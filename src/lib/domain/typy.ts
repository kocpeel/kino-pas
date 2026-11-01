// Kształty danych wspólne dla domeny, API i UI. Pola kontraktu API zostają po angielsku.

export type StatusMiejsca = "free" | "reserved" | "purchased";

export interface Seans {
  id: string;
  movie: string;
  startsAt: string;
  hall: string;
  rowsCount: number;
  seatsPerRow: number;
  /** Cena fotela w groszach (3200 = 32 zł). */
  price: number;
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
  /** Cena w groszach zapisana w chwili rezerwacji, nigdy się nie zmienia. */
  amount: number;
}

export type StatusRezerwacji = "held" | "paid" | "expired";

/** Odpowiedź GET /api/reservations/:id. */
export interface StanRezerwacji {
  status: StatusRezerwacji;
  amount: number;
  expiresAt: number;
  /** Kod biletu, gdy `status` to "paid". */
  code?: string;
  /** Tylko gdy płatność nie dała biletu (np. przyszła po wygaśnięciu) i pieniądze wracają do klienta. */
  refund?: "pending" | "done" | "failed";
}

/** Odpowiedź POST /api/reservations/:id/checkout. */
export interface SesjaPlatnosci {
  url: string;
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
