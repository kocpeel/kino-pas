// Odczyty seansów. „Zajęty" = kupiony albo zarezerwowany z ważnym `expiresAt`,
// więc wygasłe rezerwacje znikają z mapy od razu, bez czekania na Cron.
//
// Warunek `status IN ('purchased', 'reserved')` pozwala użyć indeksu (eventId, status, expiresAt):
// baza czyta tylko zajęte wiersze seansu, a nie całą salę. Ma to znaczenie, bo mapa jest odpytywana
// co kilka sekund przez każdego oglądającego.

import type { Seans, SeansNaLiscie, SzczegolySeansu } from "../domain/typy";

const WARUNEK_ZAJETY = `status IN ('purchased', 'reserved') AND (status = 'purchased' OR expiresAt > ?1)`;

// Liczba miejsc wynika z układu sali (seed zakłada wszystkie fotele), więc liczymy tylko zajęte.
const SQL_LISTA = `
SELECT e.id, e.movie, e.startsAt, e.hall, e.rowsCount, e.seatsPerRow,
       e.rowsCount * e.seatsPerRow AS totalSeats,
       e.rowsCount * e.seatsPerRow
         - (SELECT COUNT(*) FROM seats WHERE eventId = e.id AND ${WARUNEK_ZAJETY}) AS freeSeats
  FROM events e
 ORDER BY e.startsAt, e.id`;

export async function listaSeansow(db: D1Database, teraz: number): Promise<SeansNaLiscie[]> {
  const { results } = await db.prepare(SQL_LISTA).bind(teraz).all<SeansNaLiscie>();
  return results;
}

const SQL_SEANS = `SELECT id, movie, startsAt, hall, rowsCount, seatsPerRow FROM events WHERE id = ?1`;

// Celowo wybieramy tylko `seatId`: dane innych klientów nigdy nie opuszczają bazy w odczytach.
// Bez ORDER BY: sortowanie w SQL skłoniłoby planer do skanu klucza głównego (cała sala) zamiast indeksu.
const SQL_ZAJETE = `SELECT seatId FROM seats WHERE eventId = ?2 AND ${WARUNEK_ZAJETY}`;

export async function szczegolySeansu(db: D1Database, eventId: string, teraz: number): Promise<SzczegolySeansu | null> {
  // Jedna podróż do bazy zamiast dwóch.
  const [seans, zajete] = await db.batch<Seans | { seatId: string }>([
    db.prepare(SQL_SEANS).bind(eventId),
    db.prepare(SQL_ZAJETE).bind(teraz, eventId),
  ]);
  const event = (seans?.results[0] as Seans | undefined) ?? null;
  if (!event) return null;
  // Stała kolejność, żeby ta sama sala dawała tę samą odpowiedź (i ten sam ETag).
  const takenSeats = ((zajete?.results ?? []) as { seatId: string }[]).map((w) => w.seatId).sort();
  return { event, takenSeats };
}

export async function pobierzSeans(db: D1Database, eventId: string): Promise<Seans | null> {
  return db.prepare(SQL_SEANS).bind(eventId).first<Seans>();
}
