// Wszystko, czego potrzebuje obsługa żądania. Budowane z bindingów w `db/polaczenie.ts`,
// w testach składane ręcznie (prawdziwy D1 z Miniflare, zegar testowy, sztuczne limitery).

import type { Zegar } from "./czas";
import type { Konfiguracja } from "./config";
import type { UslugaPunktow } from "./domain/konto-punktowe";
import type { BramkaMaili } from "./maile/resend";
import type { BramkaPlatnosci } from "./domain/platnosc";
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
  /** Daje znać kanałowi na żywo (Durable Object sali), że stan seansu się zmienił. */
  powiadomSale?: ((eventId: string) => void) | undefined;
  /** Stripe. undefined = brak klucza: płatności odpowiadają 503, a reszta sklepu działa. */
  platnosci?: BramkaPlatnosci | undefined;
  /** Sekret do sprawdzania podpisu webhooków. */
  sekretWebhooka?: string | undefined;
  /** Program punktowy (Voucherify). undefined = brak kluczy: punkty odpowiadają 503, płatność bez punktów działa. */
  punkty?: UslugaPunktow | undefined;
  /** Sekret webhooka Resend (Svix): los wysłanego maila. */
  sekretWebhookaResend?: string | undefined;
  /** Resend: mail z ofertą z listy oczekujących wychodzi od razu, a nie dopiero z Cronem. */
  maile?: BramkaMaili | undefined;
  /**
   * Budzi Durable Object, który wykonuje joby outboxu w ich terminie (src/lib/budzik). undefined = go nie ma
   * (`next dev`, testy): wtedy pracę od razu robi samo żądanie w tle, a resztę Cron.
   */
  budzik?: (() => void) | undefined;
}
