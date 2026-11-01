// Handlery endpointów. Każdy: wrapper → walidacja → funkcja domenowa → odpowiedź.
// Route handlery Next.js w `src/app/api` tylko je wywołują z zależnościami żądania,
// a testy integracyjne wołają je bezpośrednio z prawdziwym D1.

import { BladDomenowy, czyBladDomenowy } from "../domain/bledy";
import { obsluzZdarzeniePlatnosci, stanDlaKlienta, statusRezerwacji, utworzPlatnosc } from "../domain/platnosc";
import { czyPoprawneIdRezerwacji, zarezerwuj } from "../domain/rezerwacja";
import { znajdzRezerwacje } from "../db/zapytania-platnosci";
import { zweryfikujZdarzenie } from "../platnosci/stripe";
import { adresKlienta, sprawdzLimityRezerwacji } from "../resilience/limit-zapytan";
import { obsluzTrase, wPuli, type DostawcaZaleznosci } from "./obsluga-trasy";
import { pobierzRepertuar, pobierzSzczegoly, uniewaznijPoZapisie } from "./odczyty";
import { json, jsonZEtagiem } from "./odpowiedzi";
import { czytajTekstZLimitem, wejscieRezerwacji } from "./walidacja";

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
    );
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

/** POST /api/reservations/:id/checkout: sesja płatności (ta sama przy każdym ponowieniu). */
export function obsluzCheckout(zadanie: Request, dostawca: DostawcaZaleznosci, reservationId: string): Promise<Response> {
  return obsluzTrase(dostawca, async (z) => {
    wymagajIdRezerwacji(reservationId);
    const sesja = await utworzPlatnosc(
      {
        wBazie: (praca) => wPuli(z, "zakup", praca),
        bramka: z.platnosci,
        teraz: z.zegar.teraz(),
      },
      reservationId,
      new URL(zadanie.url).origin,
    );
    return json(sesja);
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
    return json({ received: true });
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
