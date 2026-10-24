// Handlery endpointów. Każdy: wrapper → walidacja → funkcja domenowa → odpowiedź.
// Route handlery Next.js w `src/app/api` tylko je wywołują z zależnościami żądania,
// a testy integracyjne wołają je bezpośrednio z prawdziwym D1.

import { BladDomenowy } from "../domain/bledy";
import { czyPoprawneIdRezerwacji, kupBilet, zarezerwuj } from "../domain/rezerwacja";
import { adresKlienta, sprawdzLimityRezerwacji } from "../resilience/limit-zapytan";
import { obsluzTrase, wPuli, type DostawcaZaleznosci } from "./obsluga-trasy";
import { pobierzRepertuar, pobierzSzczegoly, uniewaznijPoZapisie } from "./odczyty";
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
    const wynik = await wPuli(z, "rezerwacja", (db) =>
      zarezerwuj(db, wejscie, {
        teraz,
        ttlMs: z.konfiguracja.ttlMs,
        limitNaEmail: z.konfiguracja.limitAktywnychNaEmail,
      }),
    );
    if (!wynik.powtorka) {
      uniewaznijPoZapisie(z, wejscie.eventId);
      // Oglądający mapę tej sali dostaną nowy stan przez WebSocket. Zakup nie zmienia zajętych foteli.
      z.powiadomSale?.(wejscie.eventId);
    }
    return json(wynik.rezerwacja, 201, wynik.powtorka ? { "Idempotent-Replayed": "true" } : {});
  });
}

/** POST /api/reservations/:id/purchase — 201 przy pierwszym zakupie, 200 przy powtórce (ten sam kod). */
export function obsluzZakup(dostawca: DostawcaZaleznosci, reservationId: string): Promise<Response> {
  return obsluzTrase(dostawca, async (z) => {
    if (!czyPoprawneIdRezerwacji(reservationId)) {
      throw new BladDomenowy("NIEPOPRAWNE_DANE", { komunikat: "Niepoprawny identyfikator rezerwacji." });
    }
    const teraz = z.zegar.teraz();
    const wynik = await wPuli(z, "zakup", (db) => kupBilet(db, reservationId, { teraz }));
    return json(wynik.bilet, wynik.nowy ? 201 : 200);
  });
}
