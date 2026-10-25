// Rate limiting dla POST rezerwacji: osobno na IP i na e-mail.
// Dwa poziomy: binding Workers Rate Limiting (tani, lokalny, ale liczy w przybliżeniu) jako pierwsze sito
// i ścisły limiter na Durable Object (`LimiterZadan`), który naprawdę egzekwuje limit.
// Awaria limitera nie blokuje sprzedaży (fail-open), bo poprawność zapewnia baza.

import { BladDomenowy } from "../domain/bledy";
import type { LimiterZadan } from "./limiter-zadan";

/** Kształt bindingu `RateLimit` z Workers (tylko to, czego używamy) i naszego limitera na obiekcie. */
export interface Limiter {
  limit(opcje: { key: string }): Promise<{ success: boolean; /** Za ile s warto ponowić. */ ponowZaS?: number }>;
}

export interface Limitery {
  ip?: Limiter | undefined;
  email?: Limiter | undefined;
}

/** Najwyżej `limit` prób w ostatnich `oknoS` sekundach. */
export interface RegulaLimitu {
  limit: number;
  oknoS: number;
}

export interface OcenaProby {
  dozwolone: boolean;
  /** Za ile ms zwolni się miejsce we wszystkich oknach (0, gdy dozwolone). */
  ponowZaMs: number;
  /** Znaczniki czasu do zapamiętania (już z tą próbą, jeśli przeszła). */
  trafienia: number[];
}

/**
 * Okno przesuwne dla kilku reguł naraz. Wystarczy pamiętać ostatnie `max(limit)` trafień z najdłuższego okna:
 * dla reguły z limitem L liczy się tylko L najnowszych. Odrzucona próba się nie liczy.
 */
export function ocenProbe(trafienia: readonly number[], reguly: readonly RegulaLimitu[], teraz: number): OcenaProby {
  const najdluzszeMs = Math.max(...reguly.map((r) => r.oknoS * 1000));
  const najwiecej = Math.max(...reguly.map((r) => r.limit));
  const swieze = trafienia.filter((t) => t > teraz - najdluzszeMs);
  let ponowZaMs = 0;
  for (const { limit, oknoS } of reguly) {
    const oknoMs = oknoS * 1000;
    const wOknie = swieze.filter((t) => t > teraz - oknoMs);
    // Żeby zmieściła się kolejna próba, z okna musi wypaść trafienie o indeksie len - limit (rosnąco).
    if (wOknie.length >= limit) ponowZaMs = Math.max(ponowZaMs, wOknie[wOknie.length - limit]! + oknoMs - teraz);
  }
  if (ponowZaMs > 0) return { dozwolone: false, ponowZaMs, trafienia: swieze };
  return { dozwolone: true, ponowZaMs: 0, trafienia: [...swieze, teraz].slice(-najwiecej) };
}

/**
 * Limiter na Durable Objectcie: jeden obiekt na klucz (skrót IP albo e-maila) w danej przestrzeni.
 * Bez reguł (wszystkie limity wyłączone) → undefined, czyli brak limitu.
 */
export function limiterNaObiekcie(
  przestrzen: DurableObjectNamespace<LimiterZadan> | undefined,
  prefiks: string,
  reguly: RegulaLimitu[],
): Limiter | undefined {
  const aktywne = reguly.filter((r) => r.limit > 0 && r.oknoS > 0);
  if (!przestrzen || aktywne.length === 0) return undefined;
  return {
    async limit({ key }) {
      const wynik = await przestrzen.get(przestrzen.idFromName(`${prefiks}:${key}`)).sprobuj(aktywne);
      return { success: wynik.dozwolone, ponowZaS: Math.ceil(wynik.ponowZaMs / 1000) };
    },
  };
}

/** Kolejne limitery: następny pytany tylko, gdy poprzedni przepuścił (tani binding chroni obiekt przed zalewem). */
export function lancuchLimiterow(...limitery: (Limiter | undefined)[]): Limiter | undefined {
  const obecne = limitery.filter((l): l is Limiter => l !== undefined);
  if (obecne.length <= 1) return obecne[0];
  return {
    async limit(opcje) {
      for (const limiter of obecne) {
        const wynik = await limiter.limit(opcje);
        if (!wynik.success) return wynik;
      }
      return { success: true };
    },
  };
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

type WynikSprawdzenia = { ok: true } | { ok: false; ponowZaS: number | undefined };

async function sprawdz(limiter: Limiter | undefined, klucz: Promise<string>): Promise<WynikSprawdzenia> {
  if (!limiter) return { ok: true };
  try {
    const wynik = await limiter.limit({ key: await klucz });
    return wynik.success ? { ok: true } : { ok: false, ponowZaS: wynik.ponowZaS };
  } catch (blad) {
    console.warn("Rate limiter niedostępny, przepuszczam żądanie", blad);
    return { ok: true };
  }
}

/** Rzuca 429 z Retry-After, gdy przekroczono limit dla IP albo dla e-maila. */
export async function sprawdzLimityRezerwacji(
  limitery: Limitery,
  klient: { ip: string; email: string },
  okresS: number,
): Promise<void> {
  // IP i e-mail trafiają do limiterów (i do nazw obiektów) jako skróty, nie jawnym tekstem.
  const wyniki = await Promise.all([
    sprawdz(limitery.ip, skrot(klient.ip).then((h) => `ip:${h}`)),
    sprawdz(limitery.email, skrot(klient.email).then((h) => `email:${h}`)),
  ]);
  const odmowy = wyniki.filter((w) => !w.ok);
  if (odmowy.length > 0) {
    // Retry-After z limitera, jeśli go zna (ścisły limiter wie dokładnie); inaczej długość okna.
    const ponowZaS = Math.max(...odmowy.map((w) => (w.ok ? 0 : (w.ponowZaS ?? okresS))));
    throw new BladDomenowy("LIMIT_ZAPYTAN", { ponowZaS: Math.max(1, ponowZaS) });
  }
}
