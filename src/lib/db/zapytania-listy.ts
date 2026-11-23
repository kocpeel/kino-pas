// Lista oczekujących w bazie (etap IV). Każda zmiana kolejki to warunkowy zapis albo jeden batch D1 (jedna
// transakcja), więc równoległe przesunięcia kolejki nie dadzą jednego miejsca dwóm osobom ani jednej osobie
// dwóch miejsc: oferta powstaje tylko, gdy fotel był do wzięcia I osoba nadal czekała.

export type StatusZapisu = "waiting" | "offered" | "done" | "missed" | "left";
export type StatusMailaOferty = "pending" | "sent" | "delivered" | "bounced" | "failed";

export interface WierszZapisu {
  seq: number;
  id: string;
  eventId: string;
  email: string;
  customerName: string;
  status: StatusZapisu;
  reservationId: string | null;
  seatId: string | null;
  offerExpiresAt: number | null;
  emailId: string | null;
  emailStatus: StatusMailaOferty | null;
  adres: string | null;
}

export const TASK_MAIL_OFERTY = "mail-oferta";
export const TASK_KOLEJKA = "lista-kolejka";

const KOLUMNY = `seq, id, eventId, email, customerName, status, reservationId, seatId, offerExpiresAt, emailId, emailStatus, adres`;

export async function zapisListy(db: D1Database, id: string): Promise<WierszZapisu | null> {
  return db.prepare(`SELECT ${KOLUMNY} FROM waitlist WHERE id = ?1`).bind(id).first<WierszZapisu>();
}

/** Zapis klienta, który nadal jest na liście (czeka albo ma ofertę). */
export async function aktywnyZapisKlienta(db: D1Database, eventId: string, email: string): Promise<WierszZapisu | null> {
  return db
    .prepare(`SELECT ${KOLUMNY} FROM waitlist WHERE eventId = ?1 AND email = ?2 AND status IN ('waiting', 'offered')`)
    .bind(eventId, email)
    .first<WierszZapisu>();
}

/** Miejsce w kolejce liczone od 1: tylu czekających zapisało się wcześniej, plus jeden. */
export async function pozycjaWKolejce(db: D1Database, zapis: Pick<WierszZapisu, "eventId" | "seq">): Promise<number> {
  const wiersz = await db
    .prepare(`SELECT COUNT(*) AS przed FROM waitlist WHERE eventId = ?1 AND status = 'waiting' AND seq < ?2`)
    .bind(zapis.eventId, zapis.seq)
    .first<{ przed: number }>();
  return (wiersz?.przed ?? 0) + 1;
}

/** Czy na tym wydarzeniu ktoś czeka albo ma ofertę (wtedy odczyt i rezerwacja najpierw przesuwają kolejkę). */
export async function czyListaAktywna(db: D1Database, eventId: string): Promise<boolean> {
  const wiersz = await db
    .prepare(`SELECT 1 AS jest FROM waitlist WHERE eventId = ?1 AND status IN ('waiting', 'offered') LIMIT 1`)
    .bind(eventId)
    .first<{ jest: number }>();
  return wiersz !== null;
}

/**
 * Stan sali dla zapisu na listę: null = nie ma takiego wydarzenia. Wyprzedane, gdy każde miejsce jest kupione
 * albo ma ważną rezerwację (ta sama definicja co `soldOut` w GET /api/events/:id).
 */
export async function wyprzedanie(db: D1Database, eventId: string, teraz: number): Promise<{ wyprzedane: boolean } | null> {
  const wiersz = await db
    .prepare(
      `SELECT e.rowsCount * e.seatsPerRow AS wszystkie,
              (SELECT COUNT(*) FROM seats s
                WHERE s.eventId = e.id AND (s.status = 'purchased' OR (s.status = 'reserved' AND s.expiresAt > ?2))) AS zajete
         FROM events e WHERE e.id = ?1`,
    )
    .bind(eventId, teraz)
    .first<{ wszystkie: number; zajete: number }>();
  if (!wiersz) return null;
  return { wyprzedane: wiersz.zajete >= wiersz.wszystkie };
}

export function zdanieNowyZapis(
  db: D1Database,
  z: { id: string; eventId: string; email: string; customerName: string; adres: string; teraz: number },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO waitlist (id, eventId, email, customerName, status, adres, createdAt, updatedAt)
       VALUES (?1, ?2, ?3, ?4, 'waiting', ?5, ?6, ?6)`,
    )
    .bind(z.id, z.eventId, z.email, z.customerName, z.adres, z.teraz);
}

export function czyPowtorzonyZapis(blad: unknown): boolean {
  const tresc = blad instanceof Error ? `${blad.message} ${String(blad.cause ?? "")}` : String(blad);
  return /UNIQUE constraint failed: waitlist\.eventId, waitlist\.email/.test(tresc);
}

// ——— Karta B: przesunięcie kolejki ———

/** Oferty, które się skończyły: kupione → done (także „missed”, gdy płatność na czas dotarła później), minione → missed. */
export function zdaniaZamknijOferty(db: D1Database, eventId: string, teraz: number): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `UPDATE waitlist SET status = 'done', updatedAt = ?2
          WHERE eventId = ?1 AND status IN ('offered', 'missed') AND reservationId IS NOT NULL
            AND EXISTS (SELECT 1 FROM seats s WHERE s.reservationId = waitlist.reservationId AND s.status = 'purchased')`,
      )
      .bind(eventId, teraz),
    db
      .prepare(
        `UPDATE waitlist SET status = 'missed', updatedAt = ?2
          WHERE eventId = ?1 AND status = 'offered' AND offerExpiresAt <= ?2
            AND NOT EXISTS (SELECT 1 FROM seats s WHERE s.reservationId = waitlist.reservationId AND s.status = 'purchased')`,
      )
      .bind(eventId, teraz),
  ];
}

/** Fotele do oddania kolejce: wolne albo z wygasłą rezerwacją (leniwe wygasanie, jak przy zwykłej rezerwacji). */
export async function wolneMiejsca(db: D1Database, eventId: string, teraz: number, ile: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT seatId FROM seats
        WHERE eventId = ?1 AND (status = 'free' OR (status = 'reserved' AND expiresAt <= ?2))
        ORDER BY length(seatId), seatId LIMIT ?3`,
    )
    .bind(eventId, teraz, ile)
    .all<{ seatId: string }>();
  return results.map((w) => w.seatId);
}

export async function czekajacy(db: D1Database, eventId: string, ile: number): Promise<WierszZapisu[]> {
  const { results } = await db
    .prepare(`SELECT ${KOLUMNY} FROM waitlist WHERE eventId = ?1 AND status = 'waiting' ORDER BY seq LIMIT ?2`)
    .bind(eventId, ile)
    .all<WierszZapisu>();
  return results;
}

/**
 * Oferta w JEDNEJ transakcji: fotel dla osoby (tylko gdy fotel był do wzięcia i osoba nadal czeka), wpis
 * zwykłej rezerwacji z etapu I, status `offered` i job maila z ofertą (karta B daje znać karcie C przez outbox).
 * Zwraca true, gdy oferta powstała.
 */
export async function zaoferuj(
  db: D1Database,
  o: { zapis: WierszZapisu; seatId: string; reservationId: string; expiresAt: number; teraz: number },
): Promise<boolean> {
  const { zapis, seatId, reservationId: r, expiresAt, teraz } = o;
  const ttlMs = expiresAt - teraz;
  const [fotel] = await db.batch([
    db
      .prepare(
        `UPDATE seats
            SET status = 'reserved', reservationId = ?1, expiresAt = ?2, customerName = ?3, email = ?4,
                idempotencyKey = NULL, code = NULL, secretHash = NULL, version = version + 1, updatedAt = ?5
          WHERE eventId = ?6 AND seatId = ?7
            AND (status = 'free' OR (status = 'reserved' AND expiresAt <= ?5))
            AND EXISTS (SELECT 1 FROM waitlist WHERE id = ?8 AND status = 'waiting')`,
      )
      .bind(r, expiresAt, zapis.customerName, zapis.email, teraz, zapis.eventId, seatId, zapis.id),
    db
      .prepare(
        `INSERT INTO reservations (id, eventId, seatId, amount, expiresAt, createdAt)
         SELECT s.reservationId, s.eventId, s.seatId, e.price, s.expiresAt, ?2
           FROM seats s JOIN events e ON e.id = s.eventId
          WHERE s.reservationId = ?1`,
      )
      .bind(r, teraz),
    db
      .prepare(
        `UPDATE waitlist
            SET status = 'offered', reservationId = ?2, seatId = ?3, offerExpiresAt = ?4,
                emailStatus = 'pending', emailId = NULL, updatedAt = ?5
          WHERE id = ?1 AND status = 'waiting' AND EXISTS (SELECT 1 FROM seats WHERE reservationId = ?2)`,
      )
      .bind(zapis.id, r, seatId, expiresAt, teraz),
    db
      .prepare(
        `INSERT OR IGNORE INTO outbox (id, task, input, visibleAt, createdAt)
         SELECT ?1, ?2, json_object('waitlistId', ?3, 'reservationId', ?4, 'ttlMs', ?6), ?5, ?5
          WHERE EXISTS (SELECT 1 FROM waitlist WHERE id = ?3 AND reservationId = ?4 AND status = 'offered')`,
      )
      .bind(`${TASK_MAIL_OFERTY}:${r}`, TASK_MAIL_OFERTY, zapis.id, r, teraz, ttlMs),
  ]);
  return fotel?.meta.changes === 1;
}

/**
 * Następne sprawdzenie kolejki (job `lista-kolejka`): na najbliższe wygaśnięcie rezerwacji na tej sali, jeśli
 * ktoś czeka, bo wtedy miejsce może się zwolnić. Termin tylko wcześniejszy niż ustawiony (albo nowy po wykonaniu).
 * Zwraca ten termin (null = nikt nie czeka albo nic nie wygaśnie).
 */
export async function zaplanujKolejke(db: D1Database, eventId: string, ttlMs: number, teraz: number): Promise<number | null> {
  const wiersz = await db
    .prepare(
      `INSERT INTO outbox (id, task, input, visibleAt, createdAt)
       SELECT ?1, ?2, json_object('eventId', ?3, 'ttlMs', ?4), MIN(s.expiresAt), ?5
         FROM seats s
        WHERE s.eventId = ?3 AND s.status = 'reserved' AND s.expiresAt > ?5
          AND EXISTS (SELECT 1 FROM waitlist WHERE eventId = ?3 AND status = 'waiting')
       HAVING MIN(s.expiresAt) IS NOT NULL
       ON CONFLICT (id) DO UPDATE SET
         visibleAt = CASE WHEN outbox.completedAt IS NULL AND outbox.hasError = 0
                          THEN MIN(outbox.visibleAt, excluded.visibleAt) ELSE excluded.visibleAt END,
         totalTried = CASE WHEN outbox.completedAt IS NULL AND outbox.hasError = 0 THEN outbox.totalTried ELSE 0 END,
         input = excluded.input, completedAt = NULL, hasError = 0, lastError = NULL
       RETURNING visibleAt`,
    )
    .bind(`${TASK_KOLEJKA}:${eventId}`, TASK_KOLEJKA, eventId, ttlMs, teraz)
    .first<{ visibleAt: number }>();
  return wiersz?.visibleAt ?? null;
}

/** Kolejka od razu (np. oferta odpadła): job `lista-kolejka` na teraz. */
export function zdanieKolejkaTeraz(db: D1Database, eventId: string, ttlMs: number, teraz: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO outbox (id, task, input, visibleAt, createdAt)
       VALUES (?1, ?2, json_object('eventId', ?3, 'ttlMs', ?4), ?5, ?5)
       ON CONFLICT (id) DO UPDATE SET
         visibleAt = ?5, input = excluded.input, completedAt = NULL, hasError = 0, lastError = NULL,
         totalTried = CASE WHEN outbox.completedAt IS NULL AND outbox.hasError = 0 THEN outbox.totalTried ELSE 0 END`,
    )
    .bind(`${TASK_KOLEJKA}:${eventId}`, TASK_KOLEJKA, eventId, ttlMs, teraz);
}

/**
 * Oferta odpada (mail nie doszedł albo osoba się wypisała): w JEDNEJ transakcji nowy status zapisu, zwolnienie
 * fotela (rezerwacja z oferty wygasa teraz, chyba że jest już kupiona), strażnik jej sesji płatności od razu
 * (odda wydane punkty) i kolejka od razu, więc miejsce dostaje następna osoba.
 */
export function zdaniaOdrzucOferte(
  db: D1Database,
  o: { waitlistId: string; nowyStatus: "missed" | "left"; ttlMs: number; teraz: number; eventId: string },
): D1PreparedStatement[] {
  const { waitlistId, nowyStatus, ttlMs, teraz, eventId } = o;
  const oferta = `(SELECT reservationId FROM waitlist WHERE id = ?1)`;
  return [
    db
      .prepare(
        `UPDATE waitlist SET status = ?2, updatedAt = ?3
          WHERE id = ?1 AND status = 'offered'
            AND NOT EXISTS (SELECT 1 FROM seats s WHERE s.reservationId = waitlist.reservationId AND s.status = 'purchased')`,
      )
      .bind(waitlistId, nowyStatus, teraz),
    db
      .prepare(
        `UPDATE seats SET expiresAt = ?2, version = version + 1, updatedAt = ?2
          WHERE reservationId = ${oferta} AND status = 'reserved' AND expiresAt > ?2
            AND EXISTS (SELECT 1 FROM waitlist WHERE id = ?1 AND status = ?3)`,
      )
      .bind(waitlistId, teraz, nowyStatus),
    db
      .prepare(
        `UPDATE reservations SET expiresAt = ?2
          WHERE id = ${oferta} AND expiresAt > ?2 AND EXISTS (SELECT 1 FROM waitlist WHERE id = ?1 AND status = ?3)`,
      )
      .bind(waitlistId, teraz, nowyStatus),
    db
      .prepare(
        `UPDATE outbox SET visibleAt = ?2
          WHERE id = 'stripe-session-watch:' || ${oferta} AND completedAt IS NULL AND hasError = 0 AND visibleAt > ?2`,
      )
      .bind(waitlistId, teraz),
    zdanieKolejkaTeraz(db, eventId, ttlMs, teraz),
  ];
}

/** Rezerwacja z oferty dostała bilet: zapis kończy się jako `done` (w transakcji z biletem). */
export function zdanieOfertaKupiona(db: D1Database, reservationId: string, teraz: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE waitlist SET status = 'done', updatedAt = ?2
        WHERE reservationId = ?1 AND status IN ('offered', 'missed')
          AND EXISTS (SELECT 1 FROM seats WHERE reservationId = ?1 AND status = 'purchased')`,
    )
    .bind(reservationId, teraz);
}

/** Mail z ofertą wyszedł: jego id łączy późniejszy webhook Resend z ofertą. */
export function zdanieMailOfertyWyslany(db: D1Database, waitlistId: string, reservationId: string, emailId: string): D1PreparedStatement {
  return db
    .prepare(`UPDATE waitlist SET emailId = ?3, emailStatus = 'sent' WHERE id = ?1 AND reservationId = ?2`)
    .bind(waitlistId, reservationId, emailId);
}

export async function zapisPoMailu(db: D1Database, emailId: string): Promise<WierszZapisu | null> {
  return db.prepare(`SELECT ${KOLUMNY} FROM waitlist WHERE emailId = ?1`).bind(emailId).first<WierszZapisu>();
}
