// Rate limiting dla POST rezerwacji: osobno na IP i na e-mail, przez binding Workers Rate Limiting.
// Awaria limitera nie blokuje sprzedaży (fail-open), bo poprawność zapewnia baza.

import { BladDomenowy } from "../domain/bledy";

/** Kształt bindingu `RateLimit` z Workers (tylko to, czego używamy). */
export interface Limiter {
  limit(opcje: { key: string }): Promise<{ success: boolean }>;
}

export interface Limitery {
  ip?: Limiter | undefined;
  email?: Limiter | undefined;
}

export function adresKlienta(zadanie: Request): string {
  const cf = zadanie.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const przekazany = zadanie.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return przekazany || "nieznany";
}

async function skrot(tekst: string): Promise<string> {
  const dane = new TextEncoder().encode(tekst);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", dane));
  return Array.from(hash.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sprawdz(limiter: Limiter | undefined, klucz: string): Promise<boolean> {
  if (!limiter) return true;
  try {
    return (await limiter.limit({ key: klucz })).success;
  } catch (blad) {
    console.warn("Rate limiter niedostępny, przepuszczam żądanie", blad);
    return true;
  }
}

/** Rzuca 429 z Retry-After, gdy przekroczono limit dla IP albo dla e-maila. */
export async function sprawdzLimityRezerwacji(
  limitery: Limitery,
  klient: { ip: string; email: string },
  okresS: number,
): Promise<void> {
  // E-mail trafia do limitera jako skrót, nie jawnym tekstem.
  const [ipOk, emailOk] = await Promise.all([
    sprawdz(limitery.ip, `ip:${klient.ip}`),
    limitery.email ? skrot(klient.email).then((h) => sprawdz(limitery.email, `email:${h}`)) : true,
  ]);
  if (!ipOk || !emailOk) {
    throw new BladDomenowy("LIMIT_ZAPYTAN", { ponowZaS: okresS });
  }
}
