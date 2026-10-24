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

export async function polaczZSala(zadanie: Request, sale: SaleNamespace | undefined, eventId: string): Promise<Response> {
  if (zadanie.method !== "GET" || zadanie.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return tekst(426, "Ten adres obsługuje tylko połączenia WebSocket.");
  }
  if (!czyPoprawneIdSeansu(eventId)) return tekst(404, "Nie ma takiego seansu.");
  // Tylko nasza strona może się podłączyć (ochrona przed podpinaniem cudzych stron do kanału).
  const zrodlo = zadanie.headers.get("origin");
  if (zrodlo && new URL(zrodlo).host !== new URL(zadanie.url).host) return tekst(403, "Niedozwolone źródło.");
  if (!sale) return tekst(503, "Kanał na żywo jest chwilowo niedostępny.");

  const naglowki = new Headers(zadanie.headers);
  naglowki.set("x-event-id", eventId);
  const sala = sale.get(sale.idFromName(eventId));
  return sala.fetch(new Request(zadanie.url, { method: "GET", headers: naglowki }));
}
