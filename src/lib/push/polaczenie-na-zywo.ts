// Trasa GET /api/events/:id/live (WebSocket). Waliduje żądanie i przekazuje je do Durable Objectu
// sali tego seansu. Obsługiwana przed Next.js (w worker.ts), bo route handlery Next.js
// nie potrafią zwrócić odpowiedzi 101 z WebSocketem.

import { czyPoprawneIdSeansu } from "../domain/dane-klienta";

export interface SaleNamespace {
  idFromName(nazwa: string): DurableObjectId;
  get(id: DurableObjectId): { fetch(zadanie: Request): Promise<Response> };
}

function tekst(status: number, tresc: string): Response {
  return new Response(tresc, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

export interface OpcjePolaczenia {
  /**
   * Dodatkowe dozwolone źródła (Origin), np. strona z `next dev` (http://localhost:3000)
   * łącząca się z Workerem sali na innym porcie. Na produkcji puste: tylko ta sama domena.
   */
  dozwoloneZrodla?: readonly string[];
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
  if (!sale) return tekst(503, "Kanał na żywo jest chwilowo niedostępny.");

  const naglowki = new Headers(zadanie.headers);
  naglowki.set("x-event-id", eventId);
  const sala = sale.get(sale.idFromName(eventId));
  return sala.fetch(new Request(zadanie.url, { method: "GET", headers: naglowki }));
}
