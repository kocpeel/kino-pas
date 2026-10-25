// Trasa GET /api/events/:id/live (WebSocket). Waliduje żądanie, pilnuje limitu połączeń na IP
// i load sheddingu, po czym przekazuje je do Durable Objectu sali tego seansu.
// Obsługiwana przed Next.js (w worker.ts), bo route handlery Next.js nie potrafią zwrócić
// odpowiedzi 101 z WebSocketem.

import { czyBladDomenowy } from "../domain/bledy";
import { czyPoprawneIdSeansu } from "../domain/dane-klienta";
import { adresKlienta, type Limiter } from "../resilience/limit-zapytan";
import type { StraznikPrzeciazenia } from "../resilience/przeciazenie";

export interface SaleNamespace {
  idFromName(nazwa: string): DurableObjectId;
  get(id: DurableObjectId): { fetch(zadanie: Request): Promise<Response> };
}

export interface OpcjePolaczenia {
  /**
   * Dodatkowe dozwolone źródła (Origin), np. strona z `next dev` (http://localhost:3000)
   * łącząca się z Workerem sali na innym porcie. Na produkcji puste: tylko ta sama domena.
   */
  dozwoloneZrodla?: readonly string[];
  /**
   * Zgrubny limit NOWYCH połączeń na IP (binding Rate Limiting). Binding liczy w przybliżeniu
   * (lokalnie w każdej instancji, synchronizacja w tle), więc ścisły limit RÓWNOCZESNYCH połączeń
   * egzekwuje sama sala (MAX_POLACZEN_Z_IP). Awaria limitera nie blokuje (fail-open).
   */
  limiter?: Limiter | undefined;
  /** Okno limitu w sekundach (do Retry-After). */
  okresLimituS?: number;
  /** Load shedding: przy przeciążeniu nowe połączenia odpadają pierwsze (mapa ma zapasowe odpytywanie). */
  straznik?: StraznikPrzeciazenia | undefined;
}

function tekst(status: number, tresc: string, naglowki: Record<string, string> = {}): Response {
  return new Response(tresc, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...naglowki },
  });
}

function czyDozwoloneZrodlo(zadanie: Request, dozwolone: readonly string[]): boolean {
  const zrodlo = zadanie.headers.get("origin");
  if (!zrodlo) return true;
  try {
    const url = new URL(zrodlo);
    return url.host === new URL(zadanie.url).host || dozwolone.includes(url.origin);
  } catch {
    return false;
  }
}

async function wLimicie(limiter: Limiter | undefined, zadanie: Request): Promise<boolean> {
  if (!limiter) return true;
  try {
    return (await limiter.limit({ key: `kanal:${adresKlienta(zadanie)}` })).success;
  } catch (blad) {
    console.warn("Rate limiter kanału niedostępny, przepuszczam połączenie", blad);
    return true;
  }
}

export async function polaczZSala(
  zadanie: Request,
  sale: SaleNamespace | undefined,
  eventId: string,
  opcje: OpcjePolaczenia = {},
): Promise<Response> {
  if (zadanie.method !== "GET" || zadanie.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return tekst(426, "Ten adres obsługuje tylko połączenia WebSocket.");
  }
  if (!czyPoprawneIdSeansu(eventId)) return tekst(404, "Nie ma takiego seansu.");
  // Tylko nasza strona może się podłączyć (ochrona przed podpinaniem cudzych stron do kanału).
  if (!czyDozwoloneZrodlo(zadanie, opcje.dozwoloneZrodla ?? [])) return tekst(403, "Niedozwolone źródło.");
  if (!(await wLimicie(opcje.limiter, zadanie))) {
    return tekst(429, "Za dużo połączeń z kanałem na żywo. Spróbuj za chwilę.", {
      "Retry-After": String(opcje.okresLimituS ?? 60),
    });
  }
  if (!sale) return tekst(503, "Kanał na żywo jest chwilowo niedostępny.", { "Retry-After": "5" });

  let zwolnij: (() => void) | undefined;
  try {
    zwolnij = opcje.straznik?.wejdz("kanal");
  } catch (blad) {
    if (czyBladDomenowy(blad)) return tekst(503, "System jest przeciążony, spróbuj za chwilę.", { "Retry-After": "5" });
    throw blad;
  }
  try {
    const naglowki = new Headers(zadanie.headers);
    naglowki.set("x-event-id", eventId);
    // Sala liczy równoczesne połączenia z jednego IP (ścisły limit, w odróżnieniu od bindingu).
    naglowki.set("x-klient-ip", adresKlienta(zadanie));
    const sala = sale.get(sale.idFromName(eventId));
    return await sala.fetch(new Request(zadanie.url, { method: "GET", headers: naglowki }));
  } finally {
    zwolnij?.();
  }
}
