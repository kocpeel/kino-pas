// Odczyty seansów. „Zajęty" = kupiony albo zarezerwowany z ważnym `expiresAt`,
// więc wygasłe rezerwacje znikają z mapy od razu, bez czekania na Cron.

import type { Seans, SeansNaLiscie, SzczegolySeansu } from "../domain/typy";

const SQL_LISTA = `
SELECT e.id, e.movie, e.startsAt, e.hall, e.rowsCount, e.seatsPerRow,
       COUNT(s.seatId) AS totalSeats,
       COALESCE(SUM(CASE WHEN s.status = 'free'
                           OR (s.status = 'reserved' AND s.expiresAt <= ?1)
                         THEN 1 ELSE 0 END), 0) AS freeSeats
  FROM events e
  LEFT JOIN seats s ON s.eventId = e.id
 GROUP BY e.id
 ORDER BY e.startsAt, e.id`;

export async function listaSeansow(db: D1Database, teraz: number): Promise<SeansNaLiscie[]> {
  const { results } = await db.prepare(SQL_LISTA).bind(teraz).all<SeansNaLiscie>();
  return results;
}

const SQL_SEANS = `SELECT id, movie, startsAt, hall, rowsCount, seatsPerRow FROM events WHERE id = ?1`;

// Celowo wybieramy tylko `seatId`: dane innych klientów nigdy nie opuszczają bazy w odczytach.
const SQL_ZAJETE = `
SELECT seatId FROM seats
 WHERE eventId = ?1
   AND (status = 'purchased' OR (status = 'reserved' AND expiresAt > ?2))`;

export async function szczegolySeansu(db: D1Database, eventId: string, teraz: number): Promise<SzczegolySeansu | null> {
  // Jedna podróż do bazy zamiast dwóch.
  const [seans, zajete] = await db.batch<Seans | { seatId: string }>([
    db.prepare(SQL_SEANS).bind(eventId),
    db.prepare(SQL_ZAJETE).bind(eventId, teraz),
  ]);
  const event = (seans?.results[0] as Seans | undefined) ?? null;
  if (!event) return null;
  const takenSeats = ((zajete?.results ?? []) as { seatId: string }[]).map((w) => w.seatId);
  return { event, takenSeats };
}

export async function pobierzSeans(db: D1Database, eventId: string): Promise<Seans | null> {
  return db.prepare(SQL_SEANS).bind(eventId).first<Seans>();
}
