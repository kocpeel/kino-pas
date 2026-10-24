// Jedyne miejsce, które czyta bindingi Workera (D1, rate limit, vars) i składa z nich
// zależności żądania. Kontekst Cloudflare dostarcza `kontekst.ts`; testy wołają
// `zaleznosciZBindingow` bezpośrednio ze środowiskiem z Miniflare.

import { zegarSystemowy, type Zegar } from "../czas";
import { wczytajKonfiguracje } from "../config";
import type { SeansNaLiscie, SzczegolySeansu } from "../domain/typy";
import { CacheZLimitem } from "../resilience/cache";
import type { SalaSeansu } from "../push/sala-seansu";
import type { Limiter } from "../resilience/limit-zapytan";
import { straznikDlaIzolatu } from "../resilience/przeciazenie";
import type { CacheKrawedzi, CacheOdczytow, Zaleznosci } from "../zaleznosci";

export interface Bindingi {
  DB?: D1Database;
  RL_REZERWACJE_IP?: Limiter;
  RL_REZERWACJE_EMAIL?: Limiter;
  SALE?: DurableObjectNamespace<SalaSeansu>;
  [zmienna: string]: unknown;
}

const MAX_WIEK_AWARYJNY_LISTY_MS = 10 * 60 * 1000;
const MAX_WIEK_AWARYJNY_SZCZEGOLOW_MS = 30 * 1000;

export function nowyCacheOdczytow(): CacheOdczytow {
  return {
    lista: new CacheZLimitem<SeansNaLiscie[]>(1, MAX_WIEK_AWARYJNY_LISTY_MS),
    szczegoly: new CacheZLimitem<SzczegolySeansu>(32, MAX_WIEK_AWARYJNY_SZCZEGOLOW_MS),
  };
}

// Next.js pakuje każdą stronę i każdy route handler osobno, z własnymi kopiami modułów,
// więc zmienna modułu NIE byłaby wspólna dla strony repertuaru i API rezerwacji (zapis w API
// nie unieważniłby cache strony). Dlatego jeden cache na izolat trzymamy na globalThis.
// Ograniczony: 1 wpis listy, ≤ 32 wpisy szczegółów, z TTL.
const KLUCZ_CACHE_IZOLATU = Symbol.for("kasa-kino.cache-odczytow");

function cacheIzolatu(): CacheOdczytow {
  const globalny = globalThis as { [KLUCZ_CACHE_IZOLATU]?: CacheOdczytow };
  return (globalny[KLUCZ_CACHE_IZOLATU] ??= nowyCacheOdczytow());
}

function cacheKrawedziJesliJest(): CacheKrawedzi | undefined {
  // Cache API istnieje w Workerach; w `next dev` (Node) go nie ma.
  const magazyn = (globalThis as { caches?: { default?: CacheKrawedzi } }).caches;
  return magazyn?.default;
}

export interface OpcjeZaleznosci {
  wTle?: (obietnica: Promise<unknown>) => void;
  zegar?: Zegar;
  cache?: CacheOdczytow;
}

/**
 * Powiadamia Durable Object sali, że stan seansu się zmienił (rozsyła go oglądającym przez WebSocket).
 * W tle i bez wpływu na odpowiedź: awaria kanału na żywo nie może zepsuć rezerwacji, a klienci
 * i tak mają zapasowe odpytywanie.
 */
function powiadamiaczSal(
  sale: DurableObjectNamespace<SalaSeansu> | undefined,
  wTle: ((obietnica: Promise<unknown>) => void) | undefined,
): ((eventId: string) => void) | undefined {
  if (!sale) return undefined;
  return (eventId) => {
    try {
      const praca = Promise.resolve(sale.get(sale.idFromName(eventId)).zmiana(eventId)).catch((blad: unknown) => {
        console.warn("Nie udało się powiadomić sali", eventId, blad);
      });
      wTle?.(praca);
    } catch (blad) {
      console.warn("Kanał na żywo niedostępny", blad);
    }
  };
}

export function zaleznosciZBindingow(env: Bindingi, opcje: OpcjeZaleznosci = {}): Zaleznosci {
  const konfiguracja = wczytajKonfiguracje(env);
  return {
    db: env.DB,
    konfiguracja,
    zegar: opcje.zegar ?? zegarSystemowy,
    limitery: { ip: env.RL_REZERWACJE_IP, email: env.RL_REZERWACJE_EMAIL },
    straznik: straznikDlaIzolatu({ maxOdczytow: konfiguracja.maxOdczytow, maxZapisow: konfiguracja.maxZapisow }),
    cache: opcje.cache ?? cacheIzolatu(),
    cacheKrawedzi: cacheKrawedziJesliJest(),
    wTle: opcje.wTle,
    // W `next dev` klasy Durable Objectu nie ma (żyje w worker.ts), więc nie ma kogo powiadamiać.
    powiadomSale: process.env.NODE_ENV === "development" ? undefined : powiadamiaczSal(env.SALE, opcje.wTle),
  };
}
