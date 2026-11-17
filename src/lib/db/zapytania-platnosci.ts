// Płatności w bazie: historia rezerwacji, zapis sesji Checkout i księgowanie płatności.
// Stripe jest cudzym systemem, więc nasza transakcja go nie obejmie (dual write z E07). Dlatego wszystko,
// co ma się wydarzyć razem, to jeden D1 batch (jedna transakcja): inbox + bilet + kolejne kroki sagi w outboksie
// (naliczenie punktów, mail) albo kompensacje (zwrot na kartę, oddanie punktów). Żadnego wywołania sieciowego w środku.

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
  /** Punkty wydane na tę rezerwację: ustawione dopiero, gdy Voucherify potwierdził ich zdjęcie. */
  pointsUsed: number;
  pointsEarned: number | null;
  pointsStatus: "pending" | "done" | "failed" | null;
  emailStatus: "pending" | "sent" | "delivered" | "bounced" | "failed" | null;
  /** Stan fotela, jeśli nadal należy do tej rezerwacji (null = fotel ma już kogoś innego albo jest wolny). */
  seatStatus: StatusMiejsca | null;
  code: string | null;
  /** E-mail i imię klienta z fotela (dane osobowe: tylko na serwerze). */
  seatEmail: string | null;
  customerName: string | null;
  movie: string | null;
  hall: string | null;
  startsAt: string | null;
}

const SQL_REZERWACJA = `
SELECT r.id, r.eventId, r.seatId, r.amount, r.expiresAt, r.stripeSessionId, r.stripeSessionUrl,
       r.paymentIntentId, r.refundStatus, r.pointsUsed, r.pointsEarned, r.pointsStatus, r.emailStatus,
       s.status AS seatStatus, s.code, s.email AS seatEmail, s.customerName,
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

// ID joba wynika z danych (np. z ID rezerwacji), więc ten sam job nie powstanie drugi raz. Strażnik sesji
// mógł już powstać przy wydaniu punktów (z terminem na koniec rezerwacji): wtedy tylko przyspieszamy jego termin.
const SQL_NOWY_STRAZNIK = `
INSERT INTO outbox (id, task, input, visibleAt, createdAt)
VALUES (?1, ?2, ?3, ?4, ?5)
ON CONFLICT (id) DO UPDATE SET visibleAt = MIN(visibleAt, excluded.visibleAt), input = excluded.input
 WHERE completedAt IS NULL AND hasError = 0`;

export function zdanieStraznika(db: D1Database, job: NowyJob, teraz: number): D1PreparedStatement {
  return db.prepare(SQL_NOWY_STRAZNIK).bind(job.id, job.task, JSON.stringify(job.input), job.visibleAt, teraz);
}

const SQL_KROK_PLATNOSC = `
UPDATE sagas
   SET completed = CASE WHEN EXISTS (SELECT 1 FROM json_each(sagas.completed) WHERE value = 'platnosc')
                        THEN completed ELSE json_insert(completed, '$[#]', 'platnosc') END,
       updatedAt = ?2
 WHERE id = ?1`;

/** Zapamiętuje sesję Checkout i, w tej samej transakcji, strażnika tej sesji (outbox) i krok sagi. */
export async function zapiszSesje(
  db: D1Database,
  p: { reservationId: string; sessionId: string; url: string; teraz: number; straznik: NowyJob },
): Promise<void> {
  await db.batch([
    db
      .prepare(`UPDATE reservations SET stripeSessionId = ?2, stripeSessionUrl = ?3 WHERE id = ?1 AND stripeSessionId IS NULL`)
      .bind(p.reservationId, p.sessionId, p.url),
    zdanieStraznika(db, p.straznik, p.teraz),
    db.prepare(SQL_KROK_PLATNOSC).bind(p.reservationId, p.teraz),
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

// ——— Dalsze kroki sagi w tej samej transakcji ———

// Bilet dała TA płatność (jej ID jest zapisane w rezerwacji): punkty za zakup i mail, kroki tylko do przodu.
const SQL_PUNKTY_ZA_ZAKUP = `
UPDATE reservations
   SET pointsEarned = ?3, pointsStatus = 'pending', emailStatus = 'pending'
 WHERE id = ?1 AND paymentIntentId = ?2 AND pointsEarned IS NULL`;

const SQL_JOB_PO_BILECIE = `
INSERT OR IGNORE INTO outbox (id, task, input, visibleAt, createdAt)
SELECT ?1, ?2, ?3, ?4, ?4
 WHERE EXISTS (SELECT 1 FROM reservations WHERE id = ?5 AND paymentIntentId = ?6)`;

// Saga mogła nie powstać (sesja sprzed etapu III): wtedy zakładamy ją tutaj.
const SQL_SAGA_PO_BILECIE = `
INSERT OR IGNORE INTO sagas (id, type, status, completed, results, createdAt, updatedAt)
SELECT ?1, 'zakup', 'running', '["platnosc"]', '{}', ?3, ?3
 WHERE EXISTS (SELECT 1 FROM reservations WHERE id = ?1 AND paymentIntentId = ?2)`;

const SQL_KROK_BILET = `
UPDATE sagas
   SET completed = CASE WHEN EXISTS (SELECT 1 FROM json_each(sagas.completed) WHERE value = 'bilet')
                        THEN completed ELSE json_insert(completed, '$[#]', 'bilet') END,
       updatedAt = ?3
 WHERE id = ?1 AND EXISTS (SELECT 1 FROM reservations WHERE id = ?1 AND paymentIntentId = ?2)`;

// Rezerwacja nie ma biletu (żadna płatność go nie dała): kompensacja. Pieniądze wracają przez zwrot wyżej,
// a wydane punkty osobnym jobem. Bilet z innej płatności tej rezerwacji = oddajemy tylko tę płatność.
const BEZ_BILETU = `NOT EXISTS (SELECT 1 FROM seats WHERE reservationId = ?1 AND status = 'purchased')`;

const SQL_ODDAJ_PUNKTY = `
INSERT OR IGNORE INTO outbox (id, task, input, visibleAt, createdAt)
SELECT ?2, 'punkty-zwrot', ?3, ?4, ?4
 WHERE EXISTS (SELECT 1 FROM reservations WHERE id = ?1 AND pointsUsed > 0)
   AND ${BEZ_BILETU}`;

const SQL_STATUS_ODDANIA = `
UPDATE reservations SET pointsStatus = 'pending'
 WHERE id = ?1 AND pointsUsed > 0 AND pointsStatus IS NULL AND ${BEZ_BILETU}`;

const SQL_SAGA_KOMPENSACJA = `
UPDATE sagas SET status = 'compensating', failedStep = 'bilet', updatedAt = ?2
 WHERE id = ?1 AND status = 'running' AND ${BEZ_BILETU}`;

export const TASK_NALICZENIE = "punkty-naliczenie";
export const TASK_ODDANIE_PUNKTOW = "punkty-zwrot";
export const TASK_MAIL = "mail-bilet";

/**
 * Kompensacja po wygaśnięciu bez płatności: job oddania punktów i saga w stanie `compensating`, w jednej transakcji.
 * `niepewne` = wydanie punktów nie dostało odpowiedzi: job powstaje i sam sprawdzi historię karty.
 */
export function zdaniaOddaniaPunktow(
  db: D1Database,
  reservationId: string,
  teraz: number,
  failedStep: string,
  niepewne: boolean,
): D1PreparedStatement[] {
  const dane = JSON.stringify({ reservationId });
  return [
    niepewne
      ? db
          .prepare(`INSERT OR IGNORE INTO outbox (id, task, input, visibleAt, createdAt) SELECT ?2, 'punkty-zwrot', ?3, ?4, ?4 WHERE ${BEZ_BILETU}`)
          .bind(reservationId, `${TASK_ODDANIE_PUNKTOW}:${reservationId}`, dane, teraz)
      : db.prepare(SQL_ODDAJ_PUNKTY).bind(reservationId, `${TASK_ODDANIE_PUNKTOW}:${reservationId}`, dane, teraz),
    db.prepare(SQL_STATUS_ODDANIA).bind(reservationId),
    db
      .prepare(`UPDATE sagas SET status = 'compensating', failedStep = ?3, updatedAt = ?2 WHERE id = ?1 AND status = 'running' AND ${BEZ_BILETU}`)
      .bind(reservationId, teraz, failedStep),
  ];
}

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
  /** Punkty za zakup, zapisywane, gdy ta płatność da bilet. */
  punktyZaZakup: number;
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

  const dane = JSON.stringify({ reservationId: k.reservationId });
  if (k.moznaWydacBilet) {
    zdania.push(db.prepare(SQL_PUNKTY_ZA_ZAKUP).bind(k.reservationId, k.paymentIntentId, k.punktyZaZakup));
    for (const task of [TASK_NALICZENIE, TASK_MAIL]) {
      zdania.push(
        db.prepare(SQL_JOB_PO_BILECIE).bind(`${task}:${k.reservationId}`, task, dane, k.teraz, k.reservationId, k.paymentIntentId),
      );
    }
    zdania.push(db.prepare(SQL_SAGA_PO_BILECIE).bind(k.reservationId, k.paymentIntentId, k.teraz));
    zdania.push(db.prepare(SQL_KROK_BILET).bind(k.reservationId, k.paymentIntentId, k.teraz));
  }
  zdania.push(db.prepare(SQL_ODDAJ_PUNKTY).bind(k.reservationId, `${TASK_ODDANIE_PUNKTOW}:${k.reservationId}`, dane, k.teraz));
  zdania.push(db.prepare(SQL_STATUS_ODDANIA).bind(k.reservationId));
  zdania.push(db.prepare(SQL_SAGA_KOMPENSACJA).bind(k.reservationId, k.teraz));

  const wyniki = await db.batch(zdania);
  return {
    biletWydany: k.moznaWydacBilet && wyniki[pozycjaBiletu]?.meta.changes === 1,
    zwrotZaplanowany: wyniki[pozycjaZwrotu]?.meta.changes === 1,
  };
}

/**
 * Los maila z webhooka Resend, w jednej transakcji z inboxem. Duplikat zdarzenia wywróci się na kluczu inboxu
 * (czyDuplikatZdarzenia): wtedy nic się nie zmienia. Odrzucony nie wraca do „doręczony”.
 */
export async function zapiszLosMaila(
  db: D1Database,
  p: { idZdarzenia: string; emailId: string; los: "delivered" | "bounced" | "failed"; teraz: number },
): Promise<void> {
  try {
    await db.batch([
      db.prepare(`INSERT INTO inbox (id, processedAt) VALUES (?1, ?2)`).bind(p.idZdarzenia, p.teraz),
      db
        .prepare(`UPDATE reservations SET emailStatus = ?2 WHERE emailId = ?1 AND NOT (emailStatus = 'bounced' AND ?2 = 'delivered')`)
        .bind(p.emailId, p.los),
    ]);
  } catch (blad) {
    if (!czyDuplikatZdarzenia(blad)) throw blad;
  }
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
 * Stara historia rezerwacji, które nic już nie trzymają, razem z ich sagami. Zostają: te z kupionym fotelem
 * i te z niezałatwionym zwrotem albo oddaniem punktów.
 */
export async function wyczyscHistorieRezerwacji(db: D1Database, granica: number): Promise<number> {
  const [wynik] = await db.batch([
    db
      .prepare(
        `DELETE FROM reservations
          WHERE expiresAt < ?1
            AND (refundStatus IS NULL OR refundStatus = 'done')
            AND (pointsStatus IS NULL OR pointsStatus = 'done')
            AND NOT EXISTS (SELECT 1 FROM seats WHERE seats.reservationId = reservations.id)`,
      )
      .bind(granica),
    db
      .prepare(`DELETE FROM sagas WHERE updatedAt < ?1 AND NOT EXISTS (SELECT 1 FROM reservations WHERE reservations.id = sagas.id)`)
      .bind(granica),
  ]);
  return wynik?.meta.changes ?? 0;
}
