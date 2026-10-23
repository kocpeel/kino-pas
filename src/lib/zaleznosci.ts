// Wszystko, czego potrzebuje obsługa żądania. Budowane z bindingów w `db/polaczenie.ts`,
// w testach składane ręcznie (prawdziwy D1 z Miniflare, zegar testowy, sztuczne limitery).

import type { Zegar } from "./czas";
import type { Konfiguracja } from "./config";
import type { SeansNaLiscie, SzczegolySeansu } from "./domain/typy";
import type { CacheZLimitem } from "./resilience/cache";
import type { Limitery } from "./resilience/limit-zapytan";
import type { StraznikPrzeciazenia } from "./resilience/przeciazenie";

export interface CacheOdczytow {
  lista: CacheZLimitem<SeansNaLiscie[]>;
  szczegoly: CacheZLimitem<SzczegolySeansu>;
}

/** Minimalny kształt Cache API (caches.default) używany jako współdzielony fallback listy. */
export interface CacheKrawedzi {
  match(klucz: string): Promise<Response | undefined>;
  put(klucz: string, odpowiedz: Response): Promise<void>;
}

export interface Zaleznosci {
  /** undefined = brak bindingu D1 (np. zła konfiguracja) → 503, nie 500. */
  db: D1Database | undefined;
  konfiguracja: Konfiguracja;
  zegar: Zegar;
  limitery: Limitery;
  straznik: StraznikPrzeciazenia;
  cache: CacheOdczytow;
  cacheKrawedzi?: CacheKrawedzi | undefined;
  /** Praca w tle po wysłaniu odpowiedzi (ctx.waitUntil). */
  wTle?: ((obietnica: Promise<unknown>) => void) | undefined;
}
