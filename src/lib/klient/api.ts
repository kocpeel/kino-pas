// Klient API dla przeglądarki: timeout na każdym fetchu, ponawianie GET z backoffem
// i jitterem, POST rezerwacji ponawiany tylko z tym samym Idempotency-Key.

import type { KupionyBilet, SzczegolySeansu, UtworzonaRezerwacja } from "../domain/typy";

export const TIMEOUT_MS = 8000;
const BAZA_BACKOFF_MS = 300;
const MAX_BACKOFF_MS = 4000;
const MAX_RETRY_AFTER_DO_PONOWIENIA_S = 5;

export class BladApi extends Error {
  /** 0 = brak odpowiedzi (sieć albo timeout). */
  readonly status: number;
  readonly kod: string;
  readonly ponowZaS: number | undefined;
  readonly szczegoly: Record<string, string> | undefined;

  constructor(status: number, kod: string, komunikat: string, ponowZaS?: number, szczegoly?: Record<string, string>) {
    super(komunikat);
    this.name = "BladApi";
    this.status = status;
    this.kod = kod;
    this.ponowZaS = ponowZaS;
    this.szczegoly = szczegoly;
  }
}

export function czyPrzerwane(blad: unknown): boolean {
  return blad instanceof DOMException && blad.name === "AbortError";
}

function polaczSygnaly(zewnetrzny: AbortSignal | undefined, timeoutMs: number) {
  const kontroler = new AbortController();
  let przekroczono = false;
  const uchwyt = setTimeout(() => {
    przekroczono = true;
    kontroler.abort();
  }, timeoutMs);
  const przerwij = () => kontroler.abort();
  if (zewnetrzny?.aborted) kontroler.abort();
  zewnetrzny?.addEventListener("abort", przerwij, { once: true });
  return {
    sygnal: kontroler.signal,
    czyTimeout: () => przekroczono,
    sprzatnij: () => {
      clearTimeout(uchwyt);
      zewnetrzny?.removeEventListener("abort", przerwij);
    },
  };
}

function czekaj(ms: number, sygnal?: AbortSignal): Promise<void> {
  return new Promise((rozwiaz, odrzuc) => {
    if (sygnal?.aborted) return odrzuc(new DOMException("Przerwano", "AbortError"));
    const uchwyt = setTimeout(() => {
      sygnal?.removeEventListener("abort", naPrzerwanie);
      rozwiaz();
    }, ms);
    function naPrzerwanie() {
      clearTimeout(uchwyt);
      odrzuc(new DOMException("Przerwano", "AbortError"));
    }
    sygnal?.addEventListener("abort", naPrzerwanie, { once: true });
  });
}

/** Pełny jitter: losowo z [0, min(max, baza · 2^proba)]. */
export function opoznienieBackoff(proba: number, losuj: () => number = Math.random): number {
  return Math.round(losuj() * Math.min(MAX_BACKOFF_MS, BAZA_BACKOFF_MS * 2 ** proba));
}

export interface Odpowiedz<T> {
  dane: T;
  status: number;
  /** Różnica zegara serwera względem przeglądarki (ms), z nagłówka Date. */
  przesuniecieZegara: number;
  etag: string | null;
}

function przesuniecieZNaglowka(odpowiedz: Response, wyslano: number, odebrano: number): number {
  const data = Date.parse(odpowiedz.headers.get("date") ?? "");
  if (Number.isNaN(data)) return 0;
  const roznica = data - (wyslano + odebrano) / 2;
  // Nagłówek Date ma rozdzielczość 1 s, więc drobne różnice to szum.
  return Math.abs(roznica) > 2000 ? roznica : 0;
}

async function wykonaj<T>(url: string, init: RequestInit, sygnal?: AbortSignal, timeoutMs = TIMEOUT_MS): Promise<Odpowiedz<T>> {
  const polaczony = polaczSygnaly(sygnal, timeoutMs);
  const wyslano = Date.now();
  let odpowiedz: Response;
  try {
    odpowiedz = await fetch(url, { ...init, signal: polaczony.sygnal });
  } catch (blad) {
    if (polaczony.czyTimeout()) throw new BladApi(0, "timeout", "Serwer nie odpowiedział na czas.");
    if (sygnal?.aborted || czyPrzerwane(blad)) throw new DOMException("Przerwano", "AbortError");
    throw new BladApi(0, "network", "Brak połączenia z serwerem.");
  } finally {
    polaczony.sprzatnij();
  }
  const przesuniecieZegara = przesuniecieZNaglowka(odpowiedz, wyslano, Date.now());
  const etag = odpowiedz.headers.get("etag");
  // 304: klient ma aktualną wersję (wysłał If-None-Match), treści nie ma.
  if (odpowiedz.status === 304) return { dane: undefined as T, status: 304, przesuniecieZegara, etag };
  let cialo: unknown = null;
  try {
    cialo = await odpowiedz.json();
  } catch {
    cialo = null;
  }
  if (!odpowiedz.ok) {
    const b = (cialo ?? {}) as { error?: string; message?: string; details?: Record<string, string> };
    const ponowZaS = Number(odpowiedz.headers.get("retry-after"));
    throw new BladApi(
      odpowiedz.status,
      b.error ?? `http_${odpowiedz.status}`,
      b.message ?? "Coś poszło nie tak. Spróbuj ponownie.",
      Number.isFinite(ponowZaS) && ponowZaS > 0 ? ponowZaS : undefined,
      b.details,
    );
  }
  return { dane: cialo as T, status: odpowiedz.status, przesuniecieZegara, etag };
}

function czyPonowic(blad: unknown): blad is BladApi {
  if (!(blad instanceof BladApi)) return false;
  if (blad.status === 0 || blad.status === 502 || blad.status === 504) return true;
  if (blad.status === 503 || blad.status === 429) {
    return (blad.ponowZaS ?? 1) <= MAX_RETRY_AFTER_DO_PONOWIENIA_S;
  }
  return false;
}

async function zPonowieniami<T>(proby: number, sygnal: AbortSignal | undefined, operacja: () => Promise<T>): Promise<T> {
  for (let proba = 0; ; proba++) {
    try {
      return await operacja();
    } catch (blad) {
      if (proba + 1 >= proby || !czyPonowic(blad)) throw blad;
      const zSerwera = blad.ponowZaS !== undefined ? blad.ponowZaS * 1000 : 0;
      await czekaj(Math.max(zSerwera, opoznienieBackoff(proba)), sygnal);
    }
  }
}

export interface OpcjeZadania {
  sygnal?: AbortSignal;
  proby?: number;
  timeoutMs?: number;
}

/** Dane razem z ETagiem, pod którym serwer je podał. */
export interface Wersja<T> {
  dane: T;
  etag: string | null;
}

/**
 * Stan sali. Z `poprzednia` wysyła If-None-Match: gdy nic się nie zmieniło, serwer odpowiada 304
 * bez treści, a funkcja zwraca TEN SAM obiekt `poprzednia` (łatwo rozpoznać brak zmian).
 */
export async function pobierzSzczegolySeansu(
  eventId: string,
  opcje: OpcjeZadania & { poprzednia?: Wersja<SzczegolySeansu> | undefined } = {},
): Promise<Wersja<SzczegolySeansu>> {
  const { sygnal, proby = 3, timeoutMs, poprzednia } = opcje;
  const naglowki: Record<string, string> = poprzednia?.etag ? { "If-None-Match": poprzednia.etag } : {};
  const odpowiedz = await zPonowieniami(proby, sygnal, () =>
    wykonaj<SzczegolySeansu>(
      `/api/events/${encodeURIComponent(eventId)}`,
      { cache: "no-store", headers: naglowki },
      sygnal,
      timeoutMs,
    ),
  );
  if (odpowiedz.status === 304 && poprzednia) return poprzednia;
  return { dane: odpowiedz.dane, etag: odpowiedz.etag };
}

export function nowyKluczIdempotencji(): string {
  return crypto.randomUUID();
}

export interface DaneRezerwacji {
  eventId: string;
  seatId: string;
  name: string;
  email: string;
}

/** Bezpieczne do ponawiania, bo każda próba niesie ten sam Idempotency-Key. */
export function utworzRezerwacje(
  dane: DaneRezerwacji,
  kluczIdempotencji: string,
  opcje: OpcjeZadania = {},
): Promise<Odpowiedz<UtworzonaRezerwacja>> {
  const { sygnal, proby = 3, timeoutMs } = opcje;
  return zPonowieniami(proby, sygnal, () =>
    wykonaj<UtworzonaRezerwacja>(
      "/api/reservations",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": kluczIdempotencji },
        body: JSON.stringify(dane),
      },
      sygnal,
      timeoutMs,
    ),
  );
}

/** Zakup jest idempotentny przez warunek na stanie (powtórka zwraca ten sam kod), więc można go ponawiać. */
export function kupBilet(reservationId: string, opcje: OpcjeZadania = {}): Promise<KupionyBilet> {
  const { sygnal, proby = 3, timeoutMs } = opcje;
  return zPonowieniami(proby, sygnal, () =>
    wykonaj<KupionyBilet>(
      `/api/reservations/${encodeURIComponent(reservationId)}/purchase`,
      { method: "POST" },
      sygnal,
      timeoutMs,
    ),
  ).then((o) => o.dane);
}
