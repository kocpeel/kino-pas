// Jedyne miejsce, które czyta bindingi Workera (D1, rate limit, vars) i składa z nich
// zależności żądania. Kontekst Cloudflare dostarcza `kontekst.ts`; testy wołają
// `zaleznosciZBindingow` bezpośrednio ze środowiskiem z Miniflare.

import { zegarSystemowy, type Zegar } from "../czas";
import { wczytajKonfiguracje } from "../config";
import type { SeansNaLiscie, SzczegolySeansu } from "../domain/typy";
import { CacheZLimitem } from "../resilience/cache";
import type { Limiter } from "../resilience/limit-zapytan";
import { straznikDlaIzolatu } from "../resilience/przeciazenie";
import type { CacheKrawedzi, CacheOdczytow, Zaleznosci } from "../zaleznosci";

export interface Bindingi {
  DB?: D1Database;
  RL_REZERWACJE_IP?: Limiter;
  RL_REZERWACJE_EMAIL?: Limiter;
  [zmienna: string]: unknown;
}

const MAX_WIEK_AWARYJNY_LISTY_MS = 10 * 60 * 1000;
const MAX_WIEK_AWARYJNY_SZCZEGOLOW_MS = 30 * 1000;

// stan-modulu: ograniczony cache izolatu (1 wpis listy, ≤ 32 wpisy szczegółów, z TTL).
const cacheIzolatu: CacheOdczytow = {
  lista: new CacheZLimitem<SeansNaLiscie[]>(1, MAX_WIEK_AWARYJNY_LISTY_MS),
  szczegoly: new CacheZLimitem<SzczegolySeansu>(32, MAX_WIEK_AWARYJNY_SZCZEGOLOW_MS),
};

export function nowyCacheOdczytow(): CacheOdczytow {
  return {
    lista: new CacheZLimitem<SeansNaLiscie[]>(1, MAX_WIEK_AWARYJNY_LISTY_MS),
    szczegoly: new CacheZLimitem<SzczegolySeansu>(32, MAX_WIEK_AWARYJNY_SZCZEGOLOW_MS),
  };
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

export function zaleznosciZBindingow(env: Bindingi, opcje: OpcjeZaleznosci = {}): Zaleznosci {
  const konfiguracja = wczytajKonfiguracje(env);
  return {
    db: env.DB,
    konfiguracja,
    zegar: opcje.zegar ?? zegarSystemowy,
    limitery: { ip: env.RL_REZERWACJE_IP, email: env.RL_REZERWACJE_EMAIL },
    straznik: straznikDlaIzolatu({ maxOdczytow: konfiguracja.maxOdczytow, maxZapisow: konfiguracja.maxZapisow }),
    cache: opcje.cache ?? cacheIzolatu,
    cacheKrawedzi: cacheKrawedziJesliJest(),
    wTle: opcje.wTle,
  };
}
