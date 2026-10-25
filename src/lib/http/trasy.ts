// Handlery endpointów. Każdy: wrapper → walidacja → funkcja domenowa → odpowiedź.
// Route handlery Next.js w `src/app/api` tylko je wywołują z zależnościami żądania,
// a testy integracyjne wołają je bezpośrednio z prawdziwym D1.

import { BladDomenowy, czyBladDomenowy } from "../domain/bledy";
import { czyPoprawneIdRezerwacji, kupBilet, zarezerwuj } from "../domain/rezerwacja";
import { adresKlienta, sprawdzLimityRezerwacji } from "../resilience/limit-zapytan";
import { obsluzTrase, wPuli, type DostawcaZaleznosci } from "./obsluga-trasy";
import { pobierzRepertuar, pobierzSzczegoly, uniewaznijPoZapisie } from "./odczyty";
import { ciasteczkoRezerwacji, sekretZCiasteczka } from "./ciasteczka";
import { json, jsonZEtagiem } from "./odpowiedzi";
import { wejscieRezerwacji } from "./walidacja";

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
    // Zakup nie zmienia zbioru zajętych foteli, więc tam powiadomienie nie jest potrzebne.
    uniewaznijPoZapisie(z, wejscie.eventId);
    z.powiadomSale?.(wejscie.eventId);
    // Sekret rezerwacji tylko w ciasteczku HttpOnly: treść odpowiedzi zostaje zgodna z kontraktem.
    const naglowki: Record<string, string> = {
      "Set-Cookie": ciasteczkoRezerwacji(wynik.rezerwacja.reservationId, wynik.sekret),
    };
    if (wynik.powtorka) naglowki["Idempotent-Replayed"] = "true";
    return json(wynik.rezerwacja, 201, naglowki);
  });
}

/** POST /api/reservations/:id/purchase — 201 przy pierwszym zakupie, 200 przy powtórce (ten sam kod). */
export function obsluzZakup(zadanie: Request, dostawca: DostawcaZaleznosci, reservationId: string): Promise<Response> {
  return obsluzTrase(dostawca, async (z) => {
    if (!czyPoprawneIdRezerwacji(reservationId)) {
      throw new BladDomenowy("NIEPOPRAWNE_DANE", { komunikat: "Niepoprawny identyfikator rezerwacji." });
    }
    const teraz = z.zegar.teraz();
    const sekret = sekretZCiasteczka(zadanie);
    const wynik = await wPuli(z, "zakup", (db) => kupBilet(db, reservationId, { teraz, sekret }));
    return json(wynik.bilet, wynik.nowy ? 201 : 200);
  });
}

/**
 * GET /api/zdrowie: czy aplikacja i baza odpowiadają (monitoring, alerty z Workera sprzątającego).
 * Jedno `SELECT 1` w puli listy, więc przy przeciążeniu odpada pierwsze i samo zgłasza 503.
 * „degraded" = load shedding zmniejszył pule, bo baza zwolniła.
 */
export function obsluzZdrowie(dostawca: DostawcaZaleznosci): Promise<Response> {
  return obsluzTrase(dostawca, async (z) => {
    const start = Date.now();
    await wPuli(z, "lista", (db) => db.prepare("SELECT 1").first());
    const { opoznienieMs, wspolczynnik } = z.straznik.zdrowieBazy();
    return json({
      status: wspolczynnik < 1 ? "degraded" : "ok",
      db: { latencyMs: Date.now() - start, avgLatencyMs: opoznienieMs },
      loadShedding: { capacity: wspolczynnik },
    });
  });
}
