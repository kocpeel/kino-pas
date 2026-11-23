// Handlery endpointów. Każdy: wrapper → walidacja → funkcja domenowa → odpowiedź.
// Route handlery Next.js w `src/app/api` tylko je wywołują z zależnościami żądania,
// a testy integracyjne wołają je bezpośrednio z prawdziwym D1.

import { BladDomenowy, czyBladDomenowy } from "../domain/bledy";
import { czyPoprawneIdSeansu, KOMUNIKATY_POL, normalizujEmail } from "../domain/dane-klienta";
import { saldoDlaKlienta } from "../domain/konto-punktowe";
import { przesunKolejke, stanZapisu, walidujZapis, wymagajIdZapisu, wypiszZListy, zapiszNaListe, type OpcjeListy } from "../domain/lista-oczekujacych";
import { obsluzZdarzeniePlatnosci, stanDlaKlienta, statusRezerwacji, utworzPlatnosc } from "../domain/platnosc";
import { czyPoprawneIdRezerwacji, zarezerwuj } from "../domain/rezerwacja";
import type { SaldoPunktow } from "../domain/typy";
import { zapiszLosMaila, znajdzRezerwacje } from "../db/zapytania-platnosci";
import { czyListaAktywna, TASK_KOLEJKA, TASK_MAIL_OFERTY, zapisPoMailu, zdaniaOdrzucOferte } from "../db/zapytania-listy";
import type { Zaleznosci } from "../zaleznosci";
import { czyPodpisResendPoprawny, type ZdarzenieMaila } from "../maile/resend";
import { zweryfikujZdarzenie } from "../platnosci/stripe";
import { zalegleJobyPunktowKlienta } from "../db/zapytania-punktow";
import { adresKlienta, sprawdzLimitIp, sprawdzLimityRezerwacji } from "../resilience/limit-zapytan";
import { dokonczTeraz, ruszOutbox } from "./outbox-z-zadania";
import { obsluzTrase, wPuli, wymagajBazy, type DostawcaZaleznosci } from "./obsluga-trasy";
import { pobierzRepertuar, pobierzSzczegoly, uniewaznijPoZapisie } from "./odczyty";
import { json, jsonZEtagiem } from "./odpowiedzi";
import { czytajObiektJson, czytajOpcjonalnyObiektJson, czytajTekstZLimitem, wejscieRezerwacji } from "./walidacja";

function opcjeListy(z: Zaleznosci): OpcjeListy {
  return { teraz: z.zegar.teraz(), ttlMs: z.konfiguracja.ttlMs };
}

/** Po przesunięciu kolejki: nowe oferty dostają mail od razu, a oglądający mapę widzą zajęte miejsce. */
function poKolejce(z: Zaleznosci, eventId: string, oferty: readonly string[]): void {
  if (oferty.length > 0) {
    uniewaznijPoZapisie(z, eventId);
    z.powiadomSale?.(eventId);
    ruszOutbox(z, oferty.map((r) => `${TASK_MAIL_OFERTY}:${r}`));
  } else {
    // Mógł zmienić się termin następnego sprawdzenia kolejki.
    z.budzik?.();
  }
}

/**
 * Etap IV, leniwie jak wygasanie rezerwacji: gdy na sali ktoś czeka na liście, zwolnione miejsca dostaje kolejka,
 * zanim podamy mapę albo przyjmiemy rezerwację (pierwszeństwo listy przed przypadkowym klientem). Kolejka to
 * dodatek: jej awaria nie psuje odczytu ani rezerwacji, bo przesunie ją job `lista-kolejka` i Cron.
 */
async function przesunKolejkeLeniwie(z: Zaleznosci, eventId: string): Promise<void> {
  if (!z.db || !czyPoprawneIdSeansu(eventId)) return;
  try {
    const wynik = await wPuli(z, "zakup", async (db) =>
      (await czyListaAktywna(db, eventId)) ? przesunKolejke(db, eventId, opcjeListy(z)) : null,
    );
    if (wynik) poKolejce(z, eventId, wynik.oferty);
  } catch (blad) {
    console.warn("Kolejka listy oczekujących przy odczycie:", blad instanceof Error ? blad.message : blad);
  }
}

/** GET /api/events (ETag: 304, gdy liczby wolnych miejsc się nie zmieniły) */
export function obsluzListeSeansow(zadanie: Request, dostawca: DostawcaZaleznosci): Promise<Response> {
  return obsluzTrase(dostawca, async (z) => {
    const wynik = await pobierzRepertuar(z);
    const s = Math.round(z.konfiguracja.cacheListyMs / 1000);
    const naglowki: Record<string, string> = wynik.nieaktualne
      ? { "Cache-Control": "no-store", "X-Data-Stale": "true", "X-Data-Age": String(Math.round(wynik.wiekMs / 1000)) }
      : { "Cache-Control": `public, max-age=0, s-maxage=${s}, stale-while-revalidate=${s}, stale-if-error=600` };
    return jsonZEtagiem(zadanie, wynik.dane, naglowki);
  });
}

/** GET /api/events/:id (ETag: 304, gdy na sali nic się nie zmieniło) */
export function obsluzSzczegolySeansu(zadanie: Request, dostawca: DostawcaZaleznosci, eventId: string): Promise<Response> {
  return obsluzTrase(dostawca, async (z) => {
    await przesunKolejkeLeniwie(z, eventId);
    const wynik = await pobierzSzczegoly(z, eventId);
    const naglowki: Record<string, string> = wynik.nieaktualne
      ? { "Cache-Control": "no-store", "X-Data-Stale": "true" }
      : { "Cache-Control": "public, max-age=1" };
    return jsonZEtagiem(zadanie, wynik.dane, naglowki);
  });
}

/** POST /api/reservations */
export function obsluzRezerwacje(zadanie: Request, dostawca: DostawcaZaleznosci): Promise<Response> {
  return obsluzTrase(dostawca, async (z) => {
    const wejscie = await wejscieRezerwacji(zadanie);
    await sprawdzLimityRezerwacji(
      z.limitery,
      { ip: adresKlienta(zadanie), email: wejscie.email },
      z.konfiguracja.okresLimituS,
      z.konfiguracja.timeoutLimiteraMs,
    );
    await przesunKolejkeLeniwie(z, wejscie.eventId);
    const teraz = z.zegar.teraz();
    let wynik: Awaited<ReturnType<typeof zarezerwuj>>;
    try {
      wynik = await wPuli(z, "rezerwacja", (db) =>
        zarezerwuj(db, wejscie, {
          teraz,
          ttlMs: z.konfiguracja.ttlMs,
          limitNaEmail: z.konfiguracja.limitAktywnychNaEmail,
        }),
      );
    } catch (blad) {
      // Timeout albo awaria bazy w trakcie zapisu: rezerwacja MOGŁA powstać (D1 nie da się anulować).
      // Sala sama odczyta stan z bazy; jeśli nic się nie zmieniło, nikomu nic nie wyśle.
      if (czyBladDomenowy(blad) && blad.rodzaj === "NIEDOSTEPNE") z.powiadomSale?.(wejscie.eventId);
      throw blad;
    }
    // Także przy powtórce: pierwsza próba mogła skończyć się timeoutem po udanym zapisie,
    // więc ta jest pierwszą okazją, żeby oglądający się o rezerwacji dowiedzieli.
    uniewaznijPoZapisie(z, wejscie.eventId);
    z.powiadomSale?.(wejscie.eventId);
    return json(wynik.rezerwacja, 201, wynik.powtorka ? { "Idempotent-Replayed": "true" } : {});
  });
}

function wymagajIdRezerwacji(reservationId: string): void {
  if (!czyPoprawneIdRezerwacji(reservationId)) {
    throw new BladDomenowy("NIEPOPRAWNE_DANE", { komunikat: "Niepoprawny identyfikator rezerwacji." });
  }
}

/** GET /api/reservations/:id: stan dla strony powrotu. Bez wywołań Stripe'a, tylko nasza baza. */
export function obsluzOdczytRezerwacji(zadanie: Request, dostawca: DostawcaZaleznosci, reservationId: string): Promise<Response> {
  return obsluzTrase(dostawca, async (z) => {
    wymagajIdRezerwacji(reservationId);
    const wiersz = await wPuli(z, "szczegoly", (db) => znajdzRezerwacje(db, reservationId));
    if (!wiersz) throw new BladDomenowy("NIE_ZNALEZIONO", { komunikat: "Nie ma takiej rezerwacji." });
    return json(stanDlaKlienta(wiersz, z.zegar.teraz()));
  });
}

/**
 * POST /api/reservations/:id/checkout: sesja płatności (ta sama przy każdym ponowieniu). Opcjonalne
 * `{ points }`: tyle punktów schodzi z karty klienta, a sesja jest na cenę pomniejszoną o nie.
 * Kwota zawsze z rezerwacji: `amount` w ciele nic nie zmienia.
 */
export function obsluzCheckout(zadanie: Request, dostawca: DostawcaZaleznosci, reservationId: string): Promise<Response> {
  return obsluzTrase(dostawca, async (z) => {
    wymagajIdRezerwacji(reservationId);
    const cialo = await czytajOpcjonalnyObiektJson(zadanie);
    const sesja = await utworzPlatnosc(
      {
        wBazie: (praca) => wPuli(z, "zakup", praca),
        bramka: z.platnosci,
        punkty: z.punkty,
        db: z.db,
        zegar: z.zegar,
        teraz: z.zegar.teraz(),
      },
      reservationId,
      new URL(zadanie.url).origin,
      cialo.points,
    );
    // Strażnik tej sesji ma termin (koniec rezerwacji): budzik nastawia się na niego.
    z.budzik?.();
    return json(sesja);
  });
}

/**
 * GET /api/loyalty?email=…: saldo punktów klienta. Źródłem prawdy jest Voucherify; e-mail, który nic
 * jeszcze nie kupił (nie ma karty), ma punkty powitalne. Gdy Voucherify albo budżet wywołań odmówi, ostatnie
 * znane saldo (a dla nieznanego e-maila powitalne) z nagłówkiem X-Data-Stale, jak lista seansów w trybie awaryjnym.
 */
export function obsluzSaldo(zadanie: Request, dostawca: DostawcaZaleznosci): Promise<Response> {
  return obsluzTrase(dostawca, async (z) => {
    // Zalew odczytów z jednego adresu dostaje 429, a klient z innej sieci czyta i płaci punktami dalej.
    await sprawdzLimitIp(z.limitery.saldo, adresKlienta(zadanie), z.konfiguracja.timeoutLimiteraMs);
    const email = normalizujEmail(new URL(zadanie.url).searchParams.get("email"));
    if (!email) {
      throw new BladDomenowy("NIEPOPRAWNE_DANE", { komunikat: "Podaj poprawny adres e-mail.", szczegoly: { email: KOMUNIKATY_POL.email } });
    }
    // Pula jak dla szczegółów (load shedding), ale bez limitu czasu bazy: w środku może być wywołanie Voucherify.
    const zwolnij = z.straznik.wejdz("szczegoly");
    try {
      const db = wymagajBazy(z);
      // Leniwie, jak wygasanie rezerwacji z etapu I: zaległe operacje na punktach klienta (zwrot po porzuconej
      // płatności, naliczenie po zakupie) kończą się przed odczytem, więc saldo jest już po nich.
      await dokonczTeraz(z, await zalegleJobyPunktowKlienta(db, email, z.zegar.teraz()));
      const saldo = await saldoDlaKlienta(db, z.punkty, email, z.zegar.teraz());
      const cialo: SaldoPunktow = { email, points: saldo.points };
      const naglowki: Record<string, string> = saldo.nieaktualne
        ? { "X-Data-Stale": "true", ...(saldo.wiekMs !== null ? { "X-Data-Age": String(Math.round(saldo.wiekMs / 1000)) } : {}) }
        : {};
      return json(cialo, 200, naglowki);
    } finally {
      zwolnij();
    }
  });
}

const MAX_ROZMIAR_ZDARZENIA = 1024 * 1024;

/**
 * POST /api/webhooks/stripe. Najpierw podpis, na surowym ciele. Odpowiedź 200 także dla duplikatu
 * i zdarzeń bez znaczenia, bo inaczej Stripe ponawiałby je przez kolejne dni. Błąd zapisu to 5xx:
 * właśnie wtedy chcemy, żeby ponowił (dostarczenie co najmniej raz).
 */
export function obsluzWebhookStripe(zadanie: Request, dostawca: DostawcaZaleznosci): Promise<Response> {
  return obsluzTrase(dostawca, async (z) => {
    if (!z.sekretWebhooka) {
      console.error("Brak STRIPE_WEBHOOK_SECRET: webhook nie może sprawdzić podpisu.");
      throw new BladDomenowy("PLATNOSCI_NIEDOSTEPNE", { ponowZaS: 60 });
    }
    const podpis = zadanie.headers.get("stripe-signature");
    if (!podpis) throw new BladDomenowy("ZLY_PODPIS");
    const cialo = await czytajTekstZLimitem(zadanie, MAX_ROZMIAR_ZDARZENIA);
    const zdarzenie = await zweryfikujZdarzenie(cialo, podpis, z.sekretWebhooka);
    const teraz = z.zegar.teraz();
    const wynik = await wPuli(z, "zakup", (db) => obsluzZdarzeniePlatnosci(db, zdarzenie, { teraz }));
    if (wynik.biletWydany && wynik.eventId) {
      // Fotel mógł wrócić do zajętych (płatność na czas, webhook po sprzątaniu Crona).
      uniewaznijPoZapisie(z, wynik.eventId);
      z.powiadomSale?.(wynik.eventId);
    }
    // Kroki sagi po płatności (punkty za zakup, mail, zwroty) od razu, a nie z najbliższym Cronem.
    if (wynik.reservationId && (wynik.biletWydany || wynik.zwrotZaplanowany)) {
      const id = wynik.reservationId;
      ruszOutbox(z, [`punkty-naliczenie:${id}`, `mail-bilet:${id}`, `punkty-zwrot:${id}`]);
    }
    return json({ received: true });
  });
}

const LOS_MAILA: Record<string, "delivered" | "bounced" | "failed"> = {
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.failed": "failed",
};

/**
 * POST /api/webhooks/resend: los wysłanego maila (Resend, podpis Svix na surowym ciele). Doręczony albo
 * odrzucony (np. bounced@resend.dev) trafia do rezerwacji, więc strona biletu mówi uczciwie, czy mail doszedł.
 * Duplikat (ten sam svix-id) zapisuje inbox, więc kończy się 200 bez zmian.
 */
export function obsluzWebhookResend(zadanie: Request, dostawca: DostawcaZaleznosci): Promise<Response> {
  return obsluzTrase(dostawca, async (z) => {
    if (!z.sekretWebhookaResend) {
      console.error("Brak RESEND_WEBHOOK_SECRET: webhook Resend nie może sprawdzić podpisu.");
      throw new BladDomenowy("NIEDOSTEPNE", { ponowZaS: 60 });
    }
    const cialo = await czytajTekstZLimitem(zadanie, MAX_ROZMIAR_ZDARZENIA);
    const naglowki = {
      id: zadanie.headers.get("svix-id"),
      timestamp: zadanie.headers.get("svix-timestamp"),
      podpis: zadanie.headers.get("svix-signature"),
    };
    const teraz = z.zegar.teraz();
    if (!(await czyPodpisResendPoprawny(cialo, naglowki, z.sekretWebhookaResend, teraz))) throw new BladDomenowy("ZLY_PODPIS");
    let zdarzenie: ZdarzenieMaila;
    try {
      zdarzenie = JSON.parse(cialo) as ZdarzenieMaila;
    } catch {
      throw new BladDomenowy("NIEPOPRAWNE_DANE", { komunikat: "Niepoprawny JSON." });
    }
    const los = LOS_MAILA[zdarzenie.type];
    const emailId = zdarzenie.data?.email_id;
    if (los && emailId && naglowki.id) {
      const idZdarzenia = `resend:${naglowki.id}`;
      // Etap IV: mail z ofertą nie doszedł, więc oferta odpada i miejsce dostaje następna osoba (karta C → B),
      // w tej samej transakcji co inbox. Duplikat zdarzenia niczego nie powtarza.
      const ruszonaKolejka = await wPuli(z, "zakup", async (db) => {
        const oferta = los === "delivered" ? null : await zapisPoMailu(db, emailId);
        const dalej =
          oferta?.status === "offered"
            ? zdaniaOdrzucOferte(db, { waitlistId: oferta.id, nowyStatus: "missed", ttlMs: z.konfiguracja.ttlMs, teraz, eventId: oferta.eventId })
            : [];
        const nowe = await zapiszLosMaila(db, { idZdarzenia, emailId, los, teraz }, dalej);
        return nowe && oferta && dalej.length > 0 ? oferta.eventId : null;
      });
      if (ruszonaKolejka) {
        uniewaznijPoZapisie(z, ruszonaKolejka);
        z.powiadomSale?.(ruszonaKolejka);
        ruszOutbox(z, [`${TASK_KOLEJKA}:${ruszonaKolejka}`]);
      }
    }
    return json({ received: true });
  });
}

// ——— Etap IV: lista oczekujących ———

/**
 * POST /api/events/:id/waitlist { email, customerName } → { waitlistId, position }: 201 nowy zapis, 200 ten sam
 * (klient już jest na liście). 409 `not_sold_out`, gdy wydarzenie nie jest wyprzedane; 404 bez wydarzenia.
 */
export function obsluzZapisNaListe(zadanie: Request, dostawca: DostawcaZaleznosci, eventId: string): Promise<Response> {
  return obsluzTrase(dostawca, async (z) => {
    await sprawdzLimitIp(z.limitery.zapisNaListe, adresKlienta(zadanie), z.konfiguracja.timeoutLimiteraMs);
    const wejscie = walidujZapis(eventId, await czytajObiektJson(zadanie), new URL(zadanie.url).origin);
    const wynik = await wPuli(z, "zakup", (db) => zapiszNaListe(db, wejscie, opcjeListy(z)));
    poKolejce(z, eventId, wynik.oferty);
    return json(wynik.zapis, wynik.nowy ? 201 : 200, wynik.nowy ? {} : { "Idempotent-Replayed": "true" });
  });
}

/** GET /api/waitlist/:id → { status, position, reservationId?, offerExpiresAt? }. Najpierw przesuwa kolejkę. */
export function obsluzStanZapisu(zadanie: Request, dostawca: DostawcaZaleznosci, waitlistId: string): Promise<Response> {
  return obsluzTrase(dostawca, async (z) => {
    await sprawdzLimitIp(z.limitery.odczytListy, adresKlienta(zadanie), z.konfiguracja.timeoutLimiteraMs);
    wymagajIdZapisu(waitlistId);
    const wynik = await wPuli(z, "zakup", (db) => stanZapisu(db, waitlistId, opcjeListy(z)));
    poKolejce(z, wynik.eventId, wynik.oferty);
    return json(wynik.stan);
  });
}

/** DELETE /api/waitlist/:id: wypisanie (200 ze stanem `left`); po zakupie 409 `waitlist_done`. */
export function obsluzWypisanie(zadanie: Request, dostawca: DostawcaZaleznosci, waitlistId: string): Promise<Response> {
  return obsluzTrase(dostawca, async (z) => {
    await sprawdzLimitIp(z.limitery.odczytListy, adresKlienta(zadanie), z.konfiguracja.timeoutLimiteraMs);
    wymagajIdZapisu(waitlistId);
    const wynik = await wPuli(z, "zakup", (db) => wypiszZListy(db, waitlistId, opcjeListy(z)));
    poKolejce(z, wynik.eventId, wynik.oferty);
    if (wynik.oferty.length === 0) {
      // Oferta tej osoby mogła zwolnić miejsce (strażnik jej sesji ma teraz termin „od razu”).
      uniewaznijPoZapisie(z, wynik.eventId);
      z.powiadomSale?.(wynik.eventId);
    }
    return json(wynik.stan);
  });
}

/**
 * POST /api/reservations/:id/purchase. Od etapu II bilet powstaje tylko po płatności, więc tu nie ma
 * już drogi na skróty: opłacona rezerwacja oddaje zapisany kod, a nieopłacona 402 z prośbą o zapłatę.
 */
export function obsluzZakup(zadanie: Request, dostawca: DostawcaZaleznosci, reservationId: string): Promise<Response> {
  return obsluzTrase(dostawca, async (z) => {
    wymagajIdRezerwacji(reservationId);
    const wiersz = await wPuli(z, "zakup", (db) => znajdzRezerwacje(db, reservationId));
    const status = wiersz ? statusRezerwacji(wiersz, z.zegar.teraz()) : "expired";
    if (!wiersz || status === "expired") throw new BladDomenowy("WYGASLA");
    if (status === "held") throw new BladDomenowy("PLATNOSC_WYMAGANA");
    return json({ code: wiersz.code });
  });
}

/**
 * GET /api/zdrowie: czy aplikacja i baza odpowiadają (monitoring, alerty z Workera sprzątającego).
 * Jedno `SELECT 1` w puli listy, więc przy przeciążeniu odpada pierwsze i samo zgłasza 503.
 * „degraded" = load shedding zmniejszył pule, bo baza zwolniła, albo brakuje sekretów Stripe'a.
 * Samego Stripe'a tu nie pytamy: jego awaria nie jest naszą, a kontrola idzie co minutę.
 */
export function obsluzZdrowie(dostawca: DostawcaZaleznosci): Promise<Response> {
  return obsluzTrase(dostawca, async (z) => {
    const start = Date.now();
    await wPuli(z, "lista", (db) => db.prepare("SELECT 1").first());
    const { opoznienieMs, wspolczynnik } = z.straznik.zdrowieBazy();
    const platnosciGotowe = Boolean(z.platnosci && z.sekretWebhooka);
    return json({
      status: wspolczynnik < 1 || !platnosciGotowe ? "degraded" : "ok",
      db: { latencyMs: Date.now() - start, avgLatencyMs: opoznienieMs },
      loadShedding: { capacity: wspolczynnik },
      payments: { configured: platnosciGotowe },
    });
  });
}
