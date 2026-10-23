// Konfiguracja z bindingów `vars` (wrangler.jsonc / .dev.vars). Brak wartości → domyślna,
// wartość niepoprawna → czytelny błąd zamiast cichego użycia domyślnej.

export interface Konfiguracja {
  ttlMs: number;
  /** 0 wyłącza limit aktywnych rezerwacji na e-mail. */
  limitAktywnychNaEmail: number;
  okresLimituS: number;
  cacheListyMs: number;
  timeoutBazyMs: number;
  maxOdczytow: number;
  maxZapisow: number;
}

export class BladKonfiguracji extends Error {
  constructor(komunikat: string) {
    super(komunikat);
    this.name = "BladKonfiguracji";
  }
}

type Zmienne = Partial<Record<string, unknown>>;

function liczbaCalkowita(env: Zmienne, nazwa: string, domyslna: number, min: number, max: number): number {
  const surowa = env[nazwa];
  if (surowa === undefined || surowa === null || surowa === "") return domyslna;
  const tekst = String(surowa).trim();
  const wartosc = Number(tekst);
  if (!/^-?\d+$/.test(tekst) || !Number.isSafeInteger(wartosc) || wartosc < min || wartosc > max) {
    throw new BladKonfiguracji(`${nazwa} musi być liczbą całkowitą z zakresu ${min}–${max}, otrzymano "${tekst}".`);
  }
  return wartosc;
}

export const DOMYSLNY_TTL_S = 15 * 60;

export function wczytajKonfiguracje(env: Zmienne): Konfiguracja {
  return {
    ttlMs: liczbaCalkowita(env, "RESERVATION_TTL_SECONDS", DOMYSLNY_TTL_S, 1, 24 * 60 * 60) * 1000,
    limitAktywnychNaEmail: liczbaCalkowita(env, "MAX_ACTIVE_RESERVATIONS_PER_EMAIL", 4, 0, 80),
    okresLimituS: liczbaCalkowita(env, "RATE_LIMIT_PERIOD_SECONDS", 60, 1, 3600),
    cacheListyMs: liczbaCalkowita(env, "EVENTS_CACHE_SECONDS", 60, 0, 3600) * 1000,
    timeoutBazyMs: liczbaCalkowita(env, "DB_TIMEOUT_MS", 3000, 50, 30_000),
    maxOdczytow: liczbaCalkowita(env, "LOAD_SHED_MAX_READS", 64, 1, 10_000),
    maxZapisow: liczbaCalkowita(env, "LOAD_SHED_MAX_WRITES", 32, 1, 10_000),
  };
}
