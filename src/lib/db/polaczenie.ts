// Jedyne miejsce, które czyta bindingi Workera (D1, rate limit, vars, sekrety Stripe'a) i składa z nich
// zależności żądania. Kontekst Cloudflare dostarcza `kontekst.ts`; testy wołają
// `zaleznosciZBindingow` bezpośrednio ze środowiskiem z Miniflare.

import { zegarSystemowy, type Zegar } from "../czas";
import { wczytajKonfiguracje, type Konfiguracja } from "../config";
import type { SeansNaLiscie, SzczegolySeansu } from "../domain/typy";
import type { BudzikOutboxu } from "../budzik/budzik-outboxu";
import { bramkaResendZeSrodowiska } from "../maile/resend";
import { bramkaZeSrodowiska } from "../platnosci/stripe";
import { uslugaPunktowZeSrodowiska } from "../punkty/usluga";
import { CacheZLimitem } from "../resilience/cache";
import type { SalaSeansu } from "../push/sala-seansu";
import { adresSaliDev, czyNextDev } from "../push/tryb-dev";
import {
  lancuchLimiterow,
  limiterNaObiekcie,
  OKNO_LIMITU_MINUTOWEGO_S,
  type Limiter,
  type Limitery,
} from "../resilience/limit-zapytan";
import type { LimiterZadan } from "../resilience/limiter-zadan";
import { straznikDlaIzolatu } from "../resilience/przeciazenie";
import type { CacheKrawedzi, CacheOdczytow, Zaleznosci } from "../zaleznosci";

export interface Bindingi {
  DB?: D1Database;
  RL_REZERWACJE_IP?: Limiter;
  RL_REZERWACJE_EMAIL?: Limiter;
  SALE?: DurableObjectNamespace<SalaSeansu>;
  LIMITER?: DurableObjectNamespace<LimiterZadan>;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** Tylko testy e2e: adres sztucznego Stripe'a. */
  STRIPE_API_BASE?: string;
  VOUCHERIFY_APP_ID?: string;
  VOUCHERIFY_SECRET_KEY?: string;
  VOUCHERIFY_API_URL?: string;
  VOUCHERIFY_CAMPAIGN_ID?: string;
  RESEND_WEBHOOK_SECRET?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  /** Tylko testy: adres sztucznego Resend. */
  RESEND_API_BASE?: string;
  BUDZIK?: DurableObjectNamespace<BudzikOutboxu>;
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

/** Jeden budzik outboxu na Workera (stała nazwa obiektu). Wywołanie w tle: awaria budzika niczego nie psuje. */
function budzikOutboxu(
  przestrzen: DurableObjectNamespace<BudzikOutboxu> | undefined,
  wTle: ((obietnica: Promise<unknown>) => void) | undefined,
): (() => void) | undefined {
  if (!przestrzen) return undefined;
  return () => {
    try {
      const praca = Promise.resolve(przestrzen.get(przestrzen.idFromName("outbox")).zaplanuj()).catch((blad: unknown) => {
        console.warn("Budzik outboxu nie odpowiada (zrobi to Cron)", blad);
      });
      wTle?.(praca);
    } catch (blad) {
      console.warn("Budzik outboxu niedostępny", blad);
    }
  };
}

/** W `npm run dev` sala żyje w osobnym Workerze (workers/sala-dev): powiadamiamy go przez HTTP. */
function powiadamiaczSaliDev(
  adres: string | null,
  wTle: ((obietnica: Promise<unknown>) => void) | undefined,
): ((eventId: string) => void) | undefined {
  if (!adres) return undefined;
  return (eventId) => {
    const praca = fetch(`${adres}/__dev/zmiana/${encodeURIComponent(eventId)}`, { method: "POST" }).catch((blad: unknown) => {
      console.warn("Worker sali (dev) nie odpowiada", blad);
    });
    wTle?.(praca);
  };
}

/**
 * Limitery rezerwacji: najpierw tani binding (przybliżony, odsiewa zalew), potem ścisły Durable Object.
 * W `next dev` klasy obiektu nie ma, więc zostaje sam binding.
 */
function limiteryRezerwacji(env: Bindingi, k: Konfiguracja): Limitery {
  const obiekty = czyNextDev() ? undefined : env.LIMITER;
  const okres = k.okresLimituS;
  const ttlS = Math.ceil(k.ttlMs / 1000);
  return {
    ip: lancuchLimiterow(
      env.RL_REZERWACJE_IP,
      limiterNaObiekcie(obiekty, "rezerwacje", [
        { limit: k.limitProbNaIp, oknoS: okres },
        { limit: k.limitRezerwacjiNaIpWTtl, oknoS: ttlS },
      ]),
    ),
    email: lancuchLimiterow(
      env.RL_REZERWACJE_EMAIL,
      limiterNaObiekcie(obiekty, "rezerwacje", [{ limit: k.limitProbNaEmail, oknoS: okres }]),
    ),
    saldo: limiterNaObiekcie(obiekty, "saldo", [{ limit: k.limitOdczytowSaldaNaIp, oknoS: OKNO_LIMITU_MINUTOWEGO_S }]),
    zapisNaListe: limiterNaObiekcie(obiekty, "lista-zapis", [{ limit: k.limitZapisowNaListeNaIp, oknoS: OKNO_LIMITU_MINUTOWEGO_S }]),
    odczytListy: limiterNaObiekcie(obiekty, "lista-odczyt", [{ limit: k.limitOdczytowListyNaIp, oknoS: OKNO_LIMITU_MINUTOWEGO_S }]),
  };
}

export function zaleznosciZBindingow(env: Bindingi, opcje: OpcjeZaleznosci = {}): Zaleznosci {
  const konfiguracja = wczytajKonfiguracje(env);
  return {
    db: env.DB,
    konfiguracja,
    zegar: opcje.zegar ?? zegarSystemowy,
    limitery: limiteryRezerwacji(env, konfiguracja),
    straznik: straznikDlaIzolatu({
      maxOdczytow: konfiguracja.maxOdczytow,
      maxZapisow: konfiguracja.maxZapisow,
      celOpoznieniaMs: konfiguracja.celOpoznieniaBazyMs,
    }),
    cache: opcje.cache ?? cacheIzolatu(),
    cacheKrawedzi: cacheKrawedziJesliJest(),
    wTle: opcje.wTle,
    // W `next dev` klasy Durable Objectu tu nie ma (żyje w worker.ts), więc sala jest w Workerze dev.
    powiadomSale: czyNextDev()
      ? powiadamiaczSaliDev(adresSaliDev(), opcje.wTle)
      : powiadamiaczSal(env.SALE, opcje.wTle),
    platnosci: bramkaZeSrodowiska(env),
    sekretWebhooka: env.STRIPE_WEBHOOK_SECRET,
    // W `next dev` obiektu limitera nie ma (żyje w worker.ts), więc budżet liczy tylko Voucherify (429).
    punkty: uslugaPunktowZeSrodowiska(czyNextDev() ? { ...env, LIMITER: undefined } : env),
    sekretWebhookaResend: env.RESEND_WEBHOOK_SECRET,
    maile: bramkaResendZeSrodowiska(env),
    // W `next dev` klasy budzika nie ma (żyje w worker.ts): joby od razu robi samo żądanie w tle.
    budzik: czyNextDev() ? undefined : budzikOutboxu(env.BUDZIK, opcje.wTle),
  };
}
