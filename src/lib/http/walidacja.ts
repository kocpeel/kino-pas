// Schematy wejścia warstwy HTTP: ciało JSON z limitem rozmiaru i nagłówki.
// Reguły biznesowe pól (fotel, imię, e-mail) są w domenie.

import { BladDomenowy } from "../domain/bledy";
import { czyPoprawnyKluczIdempotencji, walidujRezerwacje } from "../domain/rezerwacja";
import type { WejscieRezerwacji } from "../domain/typy";

export const MAX_ROZMIAR_CIALA = 4 * 1024;

async function czytajTekstZLimitem(zadanie: Request, maxBajtow: number): Promise<string> {
  const deklarowany = Number(zadanie.headers.get("content-length") ?? "0");
  if (deklarowany > maxBajtow) throw new BladDomenowy("ZA_DUZE_ZADANIE");
  if (!zadanie.body) return "";
  const czytnik = zadanie.body.getReader();
  const kawalki: Uint8Array[] = [];
  let razem = 0;
  for (;;) {
    const { done, value } = await czytnik.read();
    if (done) break;
    razem += value.byteLength;
    if (razem > maxBajtow) {
      await czytnik.cancel().catch(() => {});
      throw new BladDomenowy("ZA_DUZE_ZADANIE");
    }
    kawalki.push(value);
  }
  const bufor = new Uint8Array(razem);
  let pozycja = 0;
  for (const kawalek of kawalki) {
    bufor.set(kawalek, pozycja);
    pozycja += kawalek.byteLength;
  }
  return new TextDecoder().decode(bufor);
}

export async function czytajObiektJson(zadanie: Request, maxBajtow = MAX_ROZMIAR_CIALA): Promise<Record<string, unknown>> {
  const typ = zadanie.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(typ)) {
    throw new BladDomenowy("NIEPOPRAWNE_DANE", { komunikat: "Oczekiwano treści typu application/json." });
  }
  const tekst = await czytajTekstZLimitem(zadanie, maxBajtow);
  let dane: unknown;
  try {
    dane = JSON.parse(tekst);
  } catch {
    throw new BladDomenowy("NIEPOPRAWNE_DANE", { komunikat: "Niepoprawny JSON." });
  }
  if (typeof dane !== "object" || dane === null || Array.isArray(dane)) {
    throw new BladDomenowy("NIEPOPRAWNE_DANE", { komunikat: "Oczekiwano obiektu JSON." });
  }
  return dane as Record<string, unknown>;
}

export function kluczIdempotencji(zadanie: Request): string | undefined {
  const klucz = zadanie.headers.get("idempotency-key");
  if (klucz === null) return undefined;
  if (!czyPoprawnyKluczIdempotencji(klucz)) {
    throw new BladDomenowy("NIEPOPRAWNE_DANE", {
      komunikat: "Niepoprawny nagłówek Idempotency-Key.",
      szczegoly: { idempotencyKey: "8–128 znaków: litery, cyfry, _ . : -" },
    });
  }
  return klucz;
}

export async function wejscieRezerwacji(zadanie: Request): Promise<WejscieRezerwacji> {
  const klucz = kluczIdempotencji(zadanie);
  const cialo = await czytajObiektJson(zadanie);
  return walidujRezerwacje({
    eventId: cialo.eventId,
    seatId: cialo.seatId,
    name: cialo.name,
    email: cialo.email,
    ...(klucz !== undefined ? { idempotencyKey: klucz } : {}),
  });
}
