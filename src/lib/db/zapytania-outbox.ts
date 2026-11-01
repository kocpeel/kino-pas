// 📤 Outbox: te same pola i te same operacje co kolejka jobs z E06 (claim → praca → ack, ponowienia, DLQ).
// Job w trakcie pracy jest niewidoczny dla innych aż do `visibleAt`. Gdy worker padnie, job sam wróci.

export interface JobOutboxu {
  id: string;
  task: string;
  input: string;
  totalTried: number;
}

const SQL_CLAIM = `
UPDATE outbox
   SET visibleAt = ?2,
       totalTried = totalTried + 1
 WHERE id = (SELECT id FROM outbox
              WHERE completedAt IS NULL AND hasError = 0 AND visibleAt <= ?1
              ORDER BY visibleAt
              LIMIT 1)
RETURNING id, task, input, totalTried`;

/** Bierze najstarszy gotowy job. Jedno zdanie, więc dwa równoległe przebiegi nie wezmą tego samego. */
export async function wezJob(db: D1Database, teraz: number, niewidocznyDo: number): Promise<JobOutboxu | null> {
  return db.prepare(SQL_CLAIM).bind(teraz, niewidocznyDo).first<JobOutboxu>();
}

const SQL_ACK = `UPDATE outbox SET completedAt = ?2, lastError = NULL WHERE id = ?1`;

/** Ack: wysłane. */
export async function potwierdzJob(db: D1Database, id: string, teraz: number): Promise<void> {
  await db.prepare(SQL_ACK).bind(id, teraz).run();
}

/** Ack zwrotu razem z zapisem jego skutku u nas. */
export async function potwierdzZwrot(db: D1Database, id: string, reservationId: string, teraz: number): Promise<void> {
  await db.batch([
    db.prepare(SQL_ACK).bind(id, teraz),
    db.prepare(`UPDATE reservations SET refundStatus = 'done' WHERE id = ?1`).bind(reservationId),
  ]);
}

/** Jeszcze nie czas (np. rezerwacja nadal ważna). To nie jest porażka, więc licznik prób wraca do zera. */
export async function odlozJob(db: D1Database, id: string, visibleAt: number): Promise<void> {
  await db.prepare(`UPDATE outbox SET visibleAt = ?2, totalTried = 0, lastError = NULL WHERE id = ?1`).bind(id, visibleAt).run();
}

/** Porażka: job wróci o `visibleAt` (backoff). */
export async function ponowJob(db: D1Database, id: string, visibleAt: number, blad: string): Promise<void> {
  await db.prepare(`UPDATE outbox SET visibleAt = ?2, lastError = ?3 WHERE id = ?1`).bind(id, visibleAt, blad).run();
}

/** Limit prób wyczerpany: job idzie na bok (DLQ) i czeka na człowieka. */
export async function jobDoDlq(db: D1Database, id: string, blad: string): Promise<void> {
  await db.prepare(`UPDATE outbox SET hasError = 1, lastError = ?2 WHERE id = ?1`).bind(id, blad).run();
}

export async function oznaczNieudanyZwrot(db: D1Database, reservationId: string): Promise<void> {
  await db.prepare(`UPDATE reservations SET refundStatus = 'failed' WHERE id = ?1`).bind(reservationId).run();
}

export async function policzDlq(db: D1Database): Promise<number> {
  const wiersz = await db.prepare(`SELECT COUNT(*) AS liczba FROM outbox WHERE hasError = 1`).first<{ liczba: number }>();
  return wiersz?.liczba ?? 0;
}

/** Wysłane wiadomości nie są już potrzebne. Te z DLQ zostają do decyzji człowieka. */
export async function wyczyscOutbox(db: D1Database, granica: number): Promise<number> {
  const wynik = await db.prepare(`DELETE FROM outbox WHERE completedAt IS NOT NULL AND completedAt < ?1`).bind(granica).run();
  return wynik.meta.changes;
}
