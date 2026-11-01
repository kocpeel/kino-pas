// Płatności w bazie: historia rezerwacji, zapis sesji Checkout i księgowanie płatności.
// Stripe jest cudzym systemem, więc nasza transakcja go nie obejmie (dual write z E07). Dlatego wszystko,
// co ma się wydarzyć razem, to jeden D1 batch (jedna transakcja): inbox + bilet + zaplanowany zwrot.
// Żadnego wywołania sieciowego w środku.

import type { StatusMiejsca } from "../domain/typy";

export interface WierszRezerwacji {
  id: string;
  eventId: string;
  seatId: string;
  amount: number;
  expiresAt: number;
  stripeSessionId: string | null;
  stripeSessionUrl: string | null;
  paymentIntentId: string | null;
  refundStatus: "pending" | "done" | "failed" | null;
  /** Stan fotela, jeśli nadal należy do tej rezerwacji (null = fotel ma już kogoś innego albo jest wolny). */
  seatStatus: StatusMiejsca | null;
  code: string | null;
  movie: string | null;
  hall: string | null;
  startsAt: string | null;
}

const SQL_REZERWACJA = `
SELECT r.id, r.eventId, r.seatId, r.amount, r.expiresAt, r.stripeSessionId, r.stripeSessionUrl,
       r.paymentIntentId, r.refundStatus,
       s.status AS seatStatus, s.code,
       e.movie, e.hall, e.startsAt
  FROM reservations r
  LEFT JOIN seats s ON s.reservationId = r.id
  LEFT JOIN events e ON e.id = r.eventId
 WHERE r.id = ?1`;

export async function znajdzRezerwacje(db: D1Database, id: string): Promise<WierszRezerwacji | null> {
  return db.prepare(SQL_REZERWACJA).bind(id).first<WierszRezerwacji>();
}

export interface NowyJob {
  id: string;
  task: string;
  input: unknown;
  visibleAt: number;
}

// OR IGNORE: ID joba wynika z danych (np. z ID płatności), więc ten sam job nie powstanie drugi raz.
const SQL_NOWY_JOB = `
INSERT OR IGNORE INTO outbox (id, task, input, visibleAt, createdAt)
VALUES (?1, ?2, ?3, ?4, ?5)`;

/** Zapamiętuje sesję Checkout i, w tej samej transakcji, zadanie dla strażnika tej sesji (outbox). */
export async function zapiszSesje(
  db: D1Database,
  p: { reservationId: string; sessionId: string; url: string; teraz: number; straznik: NowyJob },
): Promise<void> {
  await db.batch([
    db
      .prepare(`UPDATE reservations SET stripeSessionId = ?2, stripeSessionUrl = ?3 WHERE id = ?1 AND stripeSessionId IS NULL`)
      .bind(p.reservationId, p.sessionId, p.url),
    db
      .prepare(SQL_NOWY_JOB)
      .bind(p.straznik.id, p.straznik.task, JSON.stringify(p.straznik.input), p.straznik.visibleAt, p.teraz),
  ]);
}

// Fotel dostaje bilet, gdy nadal należy do tej rezerwacji albo nikt inny go nie trzyma: płatność mogła dotrzeć
// po sprzątaniu Crona albo po cudzej, już wygasłej rezerwacji. Dane poprzedniego właściciela nie przechodzą.
// Żywa cudza rezerwacja albo sprzedany fotel = 0 zmian, czyli zawsze jeden właściciel.
const SQL_WYDAJ_BILET = `
UPDATE seats
   SET customerName = CASE WHEN reservationId = ?1 THEN customerName END,
       email = CASE WHEN reservationId = ?1 THEN email END,
       idempotencyKey = CASE WHEN reservationId = ?1 THEN idempotencyKey END,
       secretHash = NULL,
       status = 'purchased',
       reservationId = ?1,
       code = ?2,
       expiresAt = NULL,
       version = version + 1,
       updatedAt = ?3
 WHERE eventId = ?4
   AND seatId = ?5
   AND (status = 'free' OR (status = 'reserved' AND (reservationId = ?1 OR expiresAt <= ?3)))`;

// Ta płatność dała bilet, jeśli fotel właśnie należy do rezerwacji, a żadna płatność nie jest jeszcze zapisana.
const SQL_ZAPISZ_PLATNOSC = `
UPDATE reservations
   SET paymentIntentId = ?2, paidAt = ?3
 WHERE id = ?1
   AND paymentIntentId IS NULL
   AND EXISTS (SELECT 1 FROM seats WHERE reservationId = ?1 AND status = 'purchased')`;

// W tej samej transakcji: płatność, która nie dała biletu, trafia do zwrotu.
const SQL_ZAPLANUJ_ZWROT = `
INSERT OR IGNORE INTO outbox (id, task, input, visibleAt, createdAt)
SELECT ?1, ?2, ?3, ?4, ?4
 WHERE NOT EXISTS (SELECT 1 FROM reservations WHERE id = ?5 AND paymentIntentId = ?6)`;

const SQL_STATUS_ZWROTU = `
UPDATE reservations
   SET refundStatus = 'pending'
 WHERE id = ?1
   AND refundStatus IS NULL
   AND (paymentIntentId IS NULL OR paymentIntentId <> ?2)`;

export interface Ksiegowanie {
  reservationId: string;
  eventId: string;
  seatId: string;
  paymentIntentId: string;
  /** Kiedy Stripe przyjął płatność (epoch ms). */
  paidAt: number;
  teraz: number;
  code: string;
  /** Zapłacono na czas i właściwą kwotę, więc wolno wydać bilet. */
  moznaWydacBilet: boolean;
  /** ID zdarzenia do inboxu. Brak = rozliczenie przez strażnika sesji, bez zdarzenia. */
  idZdarzenia?: string;
  /** Job zwrotu, użyty tylko gdy ta płatność nie da biletu. */
  zwrot: NowyJob;
}

export interface WynikKsiegowania {
  biletWydany: boolean;
  zwrotZaplanowany: boolean;
}

/**
 * Inbox, bilet, zapis płatności i ewentualny zwrot w JEDNEJ transakcji. Każde kolejne zdanie widzi skutki
 * poprzednich, więc decyzja „wydano bilet czy zwrot” zapada w bazie, atomowo z zapisem.
 * Drugie dostarczenie tego samego zdarzenia wywróci się na kluczu inboxu: patrz `czyDuplikatZdarzenia`.
 */
export async function zaksieguj(db: D1Database, k: Ksiegowanie): Promise<WynikKsiegowania> {
  const zdania: D1PreparedStatement[] = [];
  if (k.idZdarzenia) {
    zdania.push(db.prepare(`INSERT INTO inbox (id, processedAt) VALUES (?1, ?2)`).bind(k.idZdarzenia, k.teraz));
  }
  const pozycjaBiletu = zdania.length;
  if (k.moznaWydacBilet) {
    zdania.push(db.prepare(SQL_WYDAJ_BILET).bind(k.reservationId, k.code, k.teraz, k.eventId, k.seatId));
  }
  zdania.push(db.prepare(SQL_ZAPISZ_PLATNOSC).bind(k.reservationId, k.paymentIntentId, k.paidAt));
  const pozycjaZwrotu = zdania.length;
  zdania.push(
    db
      .prepare(SQL_ZAPLANUJ_ZWROT)
      .bind(k.zwrot.id, k.zwrot.task, JSON.stringify(k.zwrot.input), k.teraz, k.reservationId, k.paymentIntentId),
  );
  zdania.push(db.prepare(SQL_STATUS_ZWROTU).bind(k.reservationId, k.paymentIntentId));

  const wyniki = await db.batch(zdania);
  return {
    biletWydany: k.moznaWydacBilet && wyniki[pozycjaBiletu]?.meta.changes === 1,
    zwrotZaplanowany: wyniki[pozycjaZwrotu]?.meta.changes === 1,
  };
}

function trescBledu(blad: unknown): string {
  return blad instanceof Error ? `${blad.message} ${String(blad.cause ?? "")}` : String(blad);
}

/** Stripe powtórzył zdarzenie, które już obsłużyliśmy (E11000 z prezentacji, tu: klucz główny inboxu). */
export function czyDuplikatZdarzenia(blad: unknown): boolean {
  return /UNIQUE constraint failed: inbox\.id/.test(trescBledu(blad));
}

/** Wylosowany kod biletu już istnieje: losujemy nowy i powtarzamy całą transakcję. */
export function czyKolizjaKodu(blad: unknown): boolean {
  return /UNIQUE constraint failed: seats\.code/.test(trescBledu(blad));
}

// ——— Sprzątanie (Cron raz na dobę) ———

/** Inbox pamięta dłużej, niż Stripe ponawia (do 3 dni). */
export async function wyczyscInbox(db: D1Database, granica: number): Promise<number> {
  const wynik = await db.prepare(`DELETE FROM inbox WHERE processedAt < ?1`).bind(granica).run();
  return wynik.meta.changes;
}

/**
 * Stara historia rezerwacji, które nic już nie trzymają. Zostają: te z kupionym fotelem
 * i te z niezałatwionym zwrotem.
 */
export async function wyczyscHistorieRezerwacji(db: D1Database, granica: number): Promise<number> {
  const wynik = await db
    .prepare(
      `DELETE FROM reservations
        WHERE expiresAt < ?1
          AND (refundStatus IS NULL OR refundStatus = 'done')
          AND NOT EXISTS (SELECT 1 FROM seats WHERE seats.reservationId = reservations.id)`,
    )
    .bind(granica)
    .run();
  return wynik.meta.changes;
}
