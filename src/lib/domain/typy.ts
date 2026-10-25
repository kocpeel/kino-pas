// Kształty danych wspólne dla domeny, API i UI. Pola kontraktu API zostają po angielsku.

export type StatusMiejsca = "free" | "reserved" | "purchased";

export interface Seans {
  id: string;
  movie: string;
  startsAt: string;
  hall: string;
  rowsCount: number;
  seatsPerRow: number;
}

/** Pozycja listy GET /api/events. */
export interface SeansNaLiscie extends Seans {
  totalSeats: number;
  freeSeats: number;
}

/** Odpowiedź GET /api/events/:id. `takenSeats` to wyłącznie identyfikatory foteli. */
export interface SzczegolySeansu {
  event: Seans;
  takenSeats: string[];
}

/** Odpowiedź POST /api/reservations. */
export interface UtworzonaRezerwacja {
  reservationId: string;
  expiresAt: number;
}

/** Odpowiedź POST /api/reservations/:id/purchase. */
export interface KupionyBilet {
  code: string;
}

export interface DaneKlienta {
  name: string;
  email: string;
}

export interface WejscieRezerwacji extends DaneKlienta {
  eventId: string;
  seatId: string;
  idempotencyKey?: string;
}
