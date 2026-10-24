// Protokół kanału „na żywo" (WebSocket) mapy sali. Wspólny dla serwera i przeglądarki,
// więc bez zależności od Cloudflare i Next.js.
//
// Serwer → klient: {"typ":"stan","dane":{event,takenSeats},"etag":"W/\"…\""}
//   wysyłane zaraz po połączeniu, po każdej rezerwacji i gdy rezerwacja wygaśnie.
//   `dane` i `etag` są identyczne z odpowiedzią GET /api/events/:id, więc po zerwaniu połączenia
//   klient wraca do odpytywania z tym samym ETagiem.
// Klient → serwer: "ping" (podtrzymanie połączenia), odpowiedź "pong" bez budzenia obiektu.

import type { SzczegolySeansu } from "../domain/typy";

export const PING = "ping";
export const PONG = "pong";

export interface WiadomoscStanu {
  typ: "stan";
  dane: SzczegolySeansu;
  etag: string;
}

export function sciezkaNaZywo(eventId: string): string {
  return `/api/events/${encodeURIComponent(eventId)}/live`;
}

export const WZOR_SCIEZKI_NA_ZYWO = /^\/api\/events\/([^/]+)\/live$/;

export function czyWiadomoscStanu(x: unknown): x is WiadomoscStanu {
  if (typeof x !== "object" || x === null) return false;
  const w = x as Record<string, unknown>;
  const dane = w.dane as Record<string, unknown> | undefined;
  return (
    w.typ === "stan" &&
    typeof w.etag === "string" &&
    typeof dane === "object" &&
    dane !== null &&
    typeof dane.event === "object" &&
    Array.isArray(dane.takenSeats) &&
    dane.takenSeats.every((s) => typeof s === "string")
  );
}
