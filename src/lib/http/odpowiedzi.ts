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

/** Słaby ETag z treści (FNV-1a, 32 bity + długość). Wystarcza, żeby rozpoznać „nic się nie zmieniło". */
export function slabyEtag(tresc: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < tresc.length; i++) {
    hash ^= tresc.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `W/"${(hash >>> 0).toString(16).padStart(8, "0")}-${tresc.length.toString(16)}"`;
}

function pasujeDoIfNoneMatch(zadanie: Request, etag: string): boolean {
  const naglowek = zadanie.headers.get("if-none-match");
  if (!naglowek) return false;
  if (naglowek.trim() === "*") return true;
  const bezW = (t: string) => t.trim().replace(/^W\//, "");
  return naglowek.split(",").some((t) => bezW(t) === bezW(etag));
}

/**
 * Odpowiedź odczytu z ETagiem. Gdy klient ma już tę wersję (If-None-Match), dostaje 304 bez treści:
 * odpytywanie mapy, na której nic się nie zmieniło, kosztuje wtedy kilkadziesiąt bajtów.
 */
export function jsonZEtagiem(zadanie: Request, dane: unknown, naglowki: Record<string, string> = {}): Response {
  const tresc = JSON.stringify(dane);
  const etag = slabyEtag(tresc);
  if (pasujeDoIfNoneMatch(zadanie, etag)) {
    return new Response(null, { status: 304, headers: { ...BEZ_CACHE, ...naglowki, ETag: etag } });
  }
  return new Response(tresc, {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...BEZ_CACHE, ...naglowki, ETag: etag },
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
