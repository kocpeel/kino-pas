// Warunkowe zapisy na tabeli `seats`. Poprawność przy równoległych żądaniach wynika
// z tego, że każdy zapis to JEDNO zdanie UPDATE z warunkiem na stanie: D1 (SQLite)
// wykonuje je atomowo, a o sukcesie mówi `meta.changes`, bez osobnego „sprawdź, potem zapisz".

import type { StatusMiejsca } from "../domain/typy";

export interface ParametryRezerwacji {
  eventId: string;
  seatId: string;
  reservationId: string;
  expiresAt: number;
  customerName: string;
  email: string;
  idempotencyKey: string | null;
  teraz: number;
  /** 0 wyłącza limit aktywnych rezerwacji na e-mail. */
  limitNaEmail: number;
}

// ?6 = teraz. Fotel jest do wzięcia, gdy jest wolny albo jego rezerwacja wygasła (leniwe wygasanie).
// Podzapytanie z limitem na e-mail jest częścią tego samego zdania, więc jest atomowe razem z resztą.
const SQL_REZERWACJA = `
UPDATE seats
   SET status = 'reserved',
       reservationId = ?1,
       expiresAt = ?2,
       customerName = ?3,
       email = ?4,
       idempotencyKey = ?5,
       code = NULL,
       secretHash = NULL,
       version = version + 1,
       updatedAt = ?6
 WHERE eventId = ?7
   AND seatId = ?8
   AND (status = 'free' OR (status = 'reserved' AND expiresAt <= ?6))
   AND (?9 = 0 OR (SELECT COUNT(*) FROM seats
                    WHERE email = ?4 AND status = 'reserved' AND expiresAt > ?6) < ?9)`;

export async function zarezerwujMiejsce(db: D1Database, p: ParametryRezerwacji): Promise<boolean> {
  const wynik = await db
    .prepare(SQL_REZERWACJA)
    .bind(
      p.reservationId,
      p.expiresAt,
      p.customerName,
      p.email,
      p.idempotencyKey,
      p.teraz,
      p.eventId,
      p.seatId,
      p.limitNaEmail,
    )
    .run();
  return wynik.meta.changes === 1;
}

// Zakup zgodnie ze wspólnym kontraktem: wystarczy identyfikator ważnej rezerwacji (losowy UUID).
const SQL_ZAKUP = `
UPDATE seats
   SET status = 'purchased',
       code = ?1,
       expiresAt = NULL,
       version = version + 1,
       updatedAt = ?2
 WHERE reservationId = ?3
   AND status = 'reserved'
   AND expiresAt > ?2`;

export async function kupMiejsce(
  db: D1Database,
  p: { reservationId: string; code: string; teraz: number },
): Promise<boolean> {
  const wynik = await db.prepare(SQL_ZAKUP).bind(p.code, p.teraz, p.reservationId).run();
  return wynik.meta.changes === 1;
}

// Sprzątanie (Cron). Czyści też dane osobowe wygasłych rezerwacji.
const SQL_SPRZATANIE = `
UPDATE seats
   SET status = 'free',
       reservationId = NULL,
       expiresAt = NULL,
       customerName = NULL,
       email = NULL,
       idempotencyKey = NULL,
       code = NULL,
       secretHash = NULL,
       version = version + 1,
       updatedAt = ?1
 WHERE status = 'reserved'
   AND expiresAt <= ?1`;

export async function zwolnijWygasleRezerwacje(db: D1Database, teraz: number): Promise<number> {
  const wynik = await db.prepare(SQL_SPRZATANIE).bind(teraz).run();
  return wynik.meta.changes;
}

// Retencja danych osobowych: po seansie (z zapasem na reklamacje) kupione miejsca tracą imię, e-mail,
// skrót sekretu i klucz idempotencji. Zostają status i kod biletu (nie są danymi osobowymi), więc
// sala i rozliczenia się nie zmieniają. `version`/`updatedAt` bez zmian: stan sali jest ten sam.
// `startsAt` to ISO 8601, porównujemy jako czas, nie jako tekst.
const SQL_RETENCJA = `
UPDATE seats
   SET customerName = NULL,
       email = NULL,
       secretHash = NULL,
       idempotencyKey = NULL
 WHERE status = 'purchased'
   AND (customerName IS NOT NULL OR email IS NOT NULL OR secretHash IS NOT NULL OR idempotencyKey IS NOT NULL)
   AND eventId IN (SELECT id FROM events WHERE CAST(strftime('%s', startsAt) AS INTEGER) * 1000 <= ?1)`;

/** Anonimizuje kupione miejsca seansów, które zaczęły się najpóźniej w chwili `granica` (epoch ms). */
export async function anonimizujPoSeansach(db: D1Database, granica: number): Promise<number> {
  const wynik = await db.prepare(SQL_RETENCJA).bind(granica).run();
  return wynik.meta.changes;
}

// ——— Odczyty pomocnicze. Służą do odpowiedzi idempotentnych i doboru komunikatu,
// nigdy do decyzji, czy wolno zapisać. ———

export interface WierszPoKluczu {
  eventId: string;
  seatId: string;
  email: string | null;
  status: StatusMiejsca;
  reservationId: string | null;
  expiresAt: number | null;
}

export async function znajdzPoKluczuIdempotencji(db: D1Database, klucz: string): Promise<WierszPoKluczu | null> {
  return db
    .prepare(
      `SELECT eventId, seatId, email, status, reservationId, expiresAt
         FROM seats WHERE idempotencyKey = ?1`,
    )
    .bind(klucz)
    .first<WierszPoKluczu>();
}

export interface StanMiejsca {
  status: StatusMiejsca;
  expiresAt: number | null;
  reservationId: string | null;
  customerName: string | null;
  email: string | null;
}

export async function stanMiejsca(db: D1Database, eventId: string, seatId: string): Promise<StanMiejsca | null> {
  return db
    .prepare(
      `SELECT status, expiresAt, reservationId, customerName, email FROM seats WHERE eventId = ?1 AND seatId = ?2`,
    )
    .bind(eventId, seatId)
    .first<StanMiejsca>();
}

export interface AktywneRezerwacje {
  liczba: number;
  najwczesniejWygasa: number | null;
}

export async function aktywneRezerwacjeEmaila(db: D1Database, email: string, teraz: number): Promise<AktywneRezerwacje> {
  const wiersz = await db
    .prepare(
      `SELECT COUNT(*) AS liczba, MIN(expiresAt) AS najwczesniejWygasa
         FROM seats WHERE email = ?1 AND status = 'reserved' AND expiresAt > ?2`,
    )
    .bind(email, teraz)
    .first<AktywneRezerwacje>();
  return wiersz ?? { liczba: 0, najwczesniejWygasa: null };
}

export interface WierszPoRezerwacji {
  status: StatusMiejsca;
  code: string | null;
  expiresAt: number | null;
}

export async function znajdzPoRezerwacji(db: D1Database, reservationId: string): Promise<WierszPoRezerwacji | null> {
  return db
    .prepare(`SELECT status, code, expiresAt FROM seats WHERE reservationId = ?1`)
    .bind(reservationId)
    .first<WierszPoRezerwacji>();
}

export type KolumnaUnikalna = "reservationId" | "code" | "idempotencyKey";

/** Rozpoznaje naruszenie indeksu unikalnego w błędzie D1 (np. równoległe użycie tego samego klucza). */
export function naruszonaUnikalnosc(blad: unknown): KolumnaUnikalna | null {
  const tresc = blad instanceof Error ? `${blad.message} ${String(blad.cause ?? "")}` : String(blad);
  const dopasowanie = /UNIQUE constraint failed: seats\.(reservationId|code|idempotencyKey)/.exec(tresc);
  return (dopasowanie?.[1] as KolumnaUnikalna | undefined) ?? null;
}
