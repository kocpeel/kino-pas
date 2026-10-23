// Budowanie odpowiedzi i jedyne mapowanie błędów na 4xx/5xx (razem z `domain/bledy.ts`).

import { BladKonfiguracji } from "../config";
import { czyBladDomenowy, OPISY_BLEDOW } from "../domain/bledy";

const BEZ_CACHE = { "Cache-Control": "no-store" };

export function json(dane: unknown, status = 200, naglowki: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(dane), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...BEZ_CACHE, ...naglowki },
  });
}

export interface CialoBledu {
  error: string;
  message: string;
  details?: Record<string, string>;
}

const DOMYSLNE_RETRY_AFTER_S: Partial<Record<number, number>> = { 503: 2 };

export function odpowiedzBledu(blad: unknown): Response {
  if (czyBladDomenowy(blad)) {
    const cialo: CialoBledu = { error: blad.kod, message: blad.message };
    if (blad.szczegoly && Object.keys(blad.szczegoly).length > 0) cialo.details = blad.szczegoly;
    const ponowZaS = blad.ponowZaS ?? DOMYSLNE_RETRY_AFTER_S[blad.status];
    const naglowki: Record<string, string> = ponowZaS !== undefined ? { "Retry-After": String(ponowZaS) } : {};
    return json(cialo, blad.status, naglowki);
  }
  if (blad instanceof BladKonfiguracji) {
    console.error("Błąd konfiguracji:", blad.message);
    return json({ error: "server_misconfigured", message: "Błąd konfiguracji serwera." } satisfies CialoBledu, 500);
  }
  console.error("Nieoczekiwany błąd:", blad);
  return json({ error: "internal_error", message: "Wystąpił nieoczekiwany błąd." } satisfies CialoBledu, 500);
}

export function cialoBleduDla(rodzaj: keyof typeof OPISY_BLEDOW): CialoBledu {
  return { error: OPISY_BLEDOW[rodzaj].kod, message: OPISY_BLEDOW[rodzaj].komunikat };
}
