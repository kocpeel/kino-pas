// Konto punktowe i saga zakupu w bazie. Saldo prowadzi Voucherify; tu jest mapowanie e-mail → karta,
// pamięć podręczna salda, blokada operacji klienta i postęp sagi (E08: notatka w naszej bazie zamiast
// pamięci procesu, więc po awarii wiadomo, co się udało i co trzeba cofnąć).

export interface WierszKonta {
  email: string;
  memberId: string | null;
  /** Kiedy nasz sklep zaczął zakładać kartę (notatka przed wywołaniem). NULL = karta nie od nas albo jej nie ma. */
  cardRequestedAt: number | null;
  welcomeAt: number | null;
  balance: number | null;
  balanceAt: number | null;
  lockedUntil: number | null;
}

export async function kontoKlienta(db: D1Database, email: string): Promise<WierszKonta | null> {
  return db
    .prepare(
      `SELECT email, memberId, cardRequestedAt, welcomeAt, balance, balanceAt, lockedUntil FROM loyalty_accounts WHERE email = ?1`,
    )
    .bind(email)
    .first<WierszKonta>();
}

/**
 * Notatka PRZED założeniem karty: gdy odpowiedź Voucherify nie dotrze, następna próba znajdzie kartę i będzie
 * wiedziała, że to nasza (należą się jej punkty powitalne), a nie karta z innego kanału.
 */
export function zdanieKartaZakladana(db: D1Database, email: string, teraz: number): D1PreparedStatement {
  return db.prepare(`UPDATE loyalty_accounts SET cardRequestedAt = COALESCE(cardRequestedAt, ?2) WHERE email = ?1`).bind(email, teraz);
}

/**
 * Karta znaleziona przy odczycie salda (GET /api/loyalty) dla e-maila, którego jeszcze nie znaliśmy: zapamiętujemy
 * ją razem z saldem. Bez notatki o zakładaniu, więc punktów powitalnych od nas nie dostanie.
 */
export function zdanieZapamietajKarte(db: D1Database, email: string, memberId: string, saldo: number, teraz: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO loyalty_accounts (email, memberId, balance, balanceAt, createdAt) VALUES (?1, ?2, ?3, ?4, ?4)
       ON CONFLICT (email) DO UPDATE SET memberId = COALESCE(loyalty_accounts.memberId, excluded.memberId),
                                         balance = excluded.balance, balanceAt = excluded.balanceAt
        WHERE loyalty_accounts.memberId IS NULL OR loyalty_accounts.memberId = excluded.memberId`,
    )
    .bind(email, memberId, saldo, teraz);
}

/**
 * Blokada operacji na punktach klienta do `doKiedy`. Warunkowe UPDATE, więc z dwóch równoległych żądań
 * weźmie ją jedno. Gdy proces padnie, blokada sama wygasa.
 */
export async function zablokujKonto(db: D1Database, email: string, teraz: number, doKiedy: number): Promise<boolean> {
  const [, blokada] = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO loyalty_accounts (email, createdAt) VALUES (?1, ?2)`).bind(email, teraz),
    db
      .prepare(`UPDATE loyalty_accounts SET lockedUntil = ?3 WHERE email = ?1 AND (lockedUntil IS NULL OR lockedUntil <= ?2)`)
      .bind(email, teraz, doKiedy),
  ]);
  return blokada?.meta.changes === 1;
}

/** Zdejmuje tylko własną blokadę (tę z tym samym `doKiedy`). */
export async function odblokujKonto(db: D1Database, email: string, doKiedy: number): Promise<void> {
  await db.prepare(`UPDATE loyalty_accounts SET lockedUntil = NULL WHERE email = ?1 AND lockedUntil = ?2`).bind(email, doKiedy).run();
}

export function zdanieZapiszKarte(db: D1Database, email: string, memberId: string, saldo: number, teraz: number): D1PreparedStatement {
  return db
    .prepare(`UPDATE loyalty_accounts SET memberId = ?2, balance = ?3, balanceAt = ?4 WHERE email = ?1`)
    .bind(email, memberId, saldo, teraz);
}

/** Saldo prosto z Voucherify (odczyt albo wynik zmiany). */
export function zdanieZapiszSaldo(db: D1Database, email: string, saldo: number, teraz: number): D1PreparedStatement {
  return db.prepare(`UPDATE loyalty_accounts SET balance = ?2, balanceAt = ?3 WHERE email = ?1`).bind(email, saldo, teraz);
}

/** Punkty powitalne przyznane. Saldo null = nieznane (odczytamy je przy następnej potrzebie). */
export function zdaniePowitanie(db: D1Database, email: string, saldo: number | null, teraz: number): D1PreparedStatement {
  return db
    .prepare(`UPDATE loyalty_accounts SET welcomeAt = ?3, balance = ?2, balanceAt = CASE WHEN ?2 IS NULL THEN NULL ELSE ?3 END WHERE email = ?1`)
    .bind(email, saldo, teraz);
}

/**
 * Joby punktów tego klienta, których termin już minął: strażnik sesji po końcu rezerwacji (oddaje wydane punkty),
 * oddanie punktów i naliczenie po zakupie. Zaraz po strażniku idzie jego oddanie punktów, bo powstaje w trakcie.
 * Klient jest w sadze (`results.email`), bo e-mail z fotela znika po wygaśnięciu rezerwacji.
 */
export async function zalegleJobyPunktowKlienta(db: D1Database, email: string, teraz: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT o.id, o.task, s.id AS rezerwacja FROM outbox o
         JOIN sagas s ON s.id = json_extract(o.input, '$.reservationId')
        WHERE o.completedAt IS NULL AND o.hasError = 0 AND o.visibleAt <= ?2
          AND o.task IN ('stripe-session-watch', 'punkty-zwrot', 'punkty-naliczenie')
          AND json_extract(s.results, '$.email') = ?1
        ORDER BY o.visibleAt
        LIMIT 3`,
    )
    .bind(email, teraz)
    .all<{ id: string; task: string; rezerwacja: string }>();
  const ids: string[] = [];
  for (const w of results) {
    ids.push(w.id);
    if (w.task === "stripe-session-watch") ids.push(`punkty-zwrot:${w.rezerwacja}`);
  }
  return [...new Set(ids)];
}

// ——— Saga zakupu ———

export type KrokSagi = "punkty" | "platnosc" | "bilet" | "naliczenie" | "mail";
export type StatusSagi = "running" | "completed" | "compensating" | "compensated";

/** Dane kroków i kompensacji. Nic, czego nie da się odtworzyć: e-mail jest też w `seats`, aż minie retencja. */
export interface WynikiSagi {
  /** Klient (e-mail) i jego karta w Voucherify: kompensacja oddaje punkty na tę kartę. */
  email?: string;
  memberId?: string;
  /** Ile punktów wydano (albo próbowano wydać). */
  punkty?: number;
  /**
   * Operacja na punktach poszła do Voucherify, ale odpowiedź nie dotarła: przed powtórką sprawdzamy historię
   * karty (Voucherify nie ma kluczy idempotencji). Notatkę zapisujemy PRZED wywołaniem, kasujemy po odpowiedzi.
   */
  wydanieNiepewne?: boolean;
  /**
   * `source_id` ostatniej próby wydania i ich liczba. Zwykle jedna próba (`wydanie:<id>`); kolejne
   * (`wydanie:<id>:<n>`) są tylko po obciętym wydaniu, które oddała korekta (`korekta:<source_id próby>`).
   */
  wydanieId?: string;
  wydaniaProby?: number;
  naliczenieNiepewne?: boolean;
  oddanieNiepewne?: boolean;
  /** Adres sklepu z checkoutu: link do biletu w mailu. */
  adres?: string;
  mail?: "sent" | "failed";
  naliczenie?: "done" | "failed";
}

export interface WierszSagi {
  id: string;
  type: string;
  status: StatusSagi;
  completed: KrokSagi[];
  results: WynikiSagi;
  failedStep: string | null;
}

export async function sagaZakupu(db: D1Database, id: string): Promise<WierszSagi | null> {
  const wiersz = await db
    .prepare(`SELECT id, type, status, completed, results, failedStep FROM sagas WHERE id = ?1`)
    .bind(id)
    .first<{ id: string; type: string; status: StatusSagi; completed: string; results: string; failedStep: string | null }>();
  if (!wiersz) return null;
  return { ...wiersz, completed: JSON.parse(wiersz.completed) as KrokSagi[], results: JSON.parse(wiersz.results) as WynikiSagi };
}

/** Saga powstaje przy pierwszym checkoucie. Drugi raz nic nie zmienia. */
export function zdanieRozpocznijSage(db: D1Database, id: string, wyniki: WynikiSagi, teraz: number): D1PreparedStatement {
  return db
    .prepare(`INSERT OR IGNORE INTO sagas (id, type, status, completed, results, createdAt, updatedAt) VALUES (?1, 'zakup', 'running', '[]', ?2, ?3, ?3)`)
    .bind(id, JSON.stringify(wyniki), teraz);
}

/** Krok się udał (raz: powtórka zapisu go nie dubluje) i jego wyniki. */
export function zdanieKrokSagi(db: D1Database, id: string, krok: KrokSagi, wyniki: WynikiSagi, teraz: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE sagas
          SET completed = CASE WHEN EXISTS (SELECT 1 FROM json_each(sagas.completed) WHERE value = ?2)
                               THEN completed ELSE json_insert(completed, '$[#]', ?2) END,
              results = json_patch(results, ?3),
              updatedAt = ?4
        WHERE id = ?1`,
    )
    .bind(id, krok, JSON.stringify(wyniki), teraz);
}

export function zdanieWynikiSagi(db: D1Database, id: string, wyniki: WynikiSagi, teraz: number): D1PreparedStatement {
  return db.prepare(`UPDATE sagas SET results = json_patch(results, ?2), updatedAt = ?3 WHERE id = ?1`).bind(id, JSON.stringify(wyniki), teraz);
}

/** Saga przechodzi w kompensację: tylko z `running` (zakończona sukcesem już się nie cofa). */
export function zdanieKompensuj(db: D1Database, id: string, failedStep: string, teraz: number): D1PreparedStatement {
  return db
    .prepare(`UPDATE sagas SET status = 'compensating', failedStep = ?2, updatedAt = ?3 WHERE id = ?1 AND status = 'running'`)
    .bind(id, failedStep, teraz);
}

/** Kompensacja zbędna: przed porażką nie udało się nic, co trzeba by cofać (np. sesja wygasła bez punktów). */
export function zdanieSkompensowana(db: D1Database, id: string, failedStep: string, teraz: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE sagas SET status = 'compensated', failedStep = COALESCE(failedStep, ?3), updatedAt = ?2
        WHERE id = ?1 AND status IN ('running', 'compensating')`,
    )
    .bind(id, teraz, failedStep);
}

/**
 * Kompensacja skończona, gdy pieniądze i punkty wróciły do klienta (albo nie było czego oddawać).
 * Woła się po zwrocie na kartę i po oddaniu punktów: kończy ta, która była ostatnia.
 */
export function zdanieZakonczKompensacje(db: D1Database, id: string, teraz: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE sagas SET status = 'compensated', updatedAt = ?2
        WHERE id = ?1 AND status = 'compensating'
          AND EXISTS (SELECT 1 FROM reservations r WHERE r.id = ?1
                       AND (r.refundStatus IS NULL OR r.refundStatus = 'done')
                       AND (r.pointsUsed = 0 OR r.pointsStatus = 'done'))`,
    )
    .bind(id, teraz);
}

/** Po bilecie zostały dwa kroki tylko do przodu (naliczenie, mail): saga kończy się, gdy oba są za nami. */
export function zdanieZakonczSageJesliGotowa(db: D1Database, id: string, teraz: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE sagas SET status = 'completed', updatedAt = ?2
        WHERE id = ?1 AND status = 'running'
          AND EXISTS (SELECT 1 FROM json_each(sagas.completed) WHERE value = 'naliczenie')
          AND EXISTS (SELECT 1 FROM json_each(sagas.completed) WHERE value = 'mail')`,
    )
    .bind(id, teraz);
}
