// Normalizacja i walidacja pól wejściowych. Czyste funkcje, używane przez serwer
// i przez formularz w przeglądarce (te same reguły po obu stronach).

export const MIN_DLUGOSC_IMIENIA = 2;
export const MAX_DLUGOSC_IMIENIA = 80;
export const MAX_DLUGOSC_EMAILA = 254;

const ZNAKI_STERUJACE = /[\u0000-\u001f\u007f-\u009f]/;
const WZOR_EMAILA = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const WZOR_ID_SEANSU = /^[a-z0-9][a-z0-9-]{0,63}$/;
const WZOR_KLUCZA = /^[A-Za-z0-9_.:-]{8,128}$/;
const WZOR_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Przycina, scala białe znaki, normalizuje Unicode. Zwraca null, gdy imię jest niepoprawne. */
export function normalizujImie(wartosc: unknown): string | null {
  if (typeof wartosc !== "string") return null;
  const imie = wartosc.normalize("NFC").replace(/\s+/g, " ").trim();
  if (imie.length < MIN_DLUGOSC_IMIENIA || imie.length > MAX_DLUGOSC_IMIENIA) return null;
  if (ZNAKI_STERUJACE.test(imie)) return null;
  return imie;
}

/** Małe litery, bez otaczających spacji. Spacja w środku adresu = adres niepoprawny. */
export function normalizujEmail(wartosc: unknown): string | null {
  if (typeof wartosc !== "string") return null;
  const email = wartosc.trim().toLowerCase();
  if (email.length === 0 || email.length > MAX_DLUGOSC_EMAILA) return null;
  if (!WZOR_EMAILA.test(email)) return null;
  return email;
}

export function czyPoprawneIdSeansu(wartosc: unknown): wartosc is string {
  return typeof wartosc === "string" && WZOR_ID_SEANSU.test(wartosc);
}

export function czyPoprawneIdRezerwacji(wartosc: unknown): wartosc is string {
  return typeof wartosc === "string" && WZOR_UUID.test(wartosc);
}

export function czyPoprawnyKluczIdempotencji(wartosc: unknown): wartosc is string {
  return typeof wartosc === "string" && WZOR_KLUCZA.test(wartosc);
}

export const KOMUNIKATY_POL = {
  name: `Podaj imię (${MIN_DLUGOSC_IMIENIA}–${MAX_DLUGOSC_IMIENIA} znaków).`,
  email: "Podaj poprawny adres e-mail, np. jan@example.com.",
} as const;
