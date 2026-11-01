-- Etap II: płatność przez Stripe.

-- Cena fotela na seans, w groszach (3200 = 32 zł). Jedna cena na wydarzenie.
ALTER TABLE events ADD COLUMN price INTEGER NOT NULL DEFAULT 3200 CHECK (price > 0);

-- Trwała historia rezerwacji. `seats` zna tylko bieżącego właściciela fotela: po wygaśnięciu wiersz
-- dostaje nowe reservationId, a stary identyfikator znika. Płatność przychodzi jednak z zewnątrz
-- i może dotrzeć później, więc musimy pamiętać rezerwację, jej kwotę i sesję płatności.
-- Bez danych osobowych: imię i e-mail są tylko w `seats`.
-- Bez klucza obcego do events: to historia, a nie część stanu sali.
CREATE TABLE reservations (
  id               TEXT PRIMARY KEY,
  eventId          TEXT NOT NULL,
  seatId           TEXT NOT NULL,
  amount           INTEGER NOT NULL CHECK (amount > 0), -- cena z chwili rezerwacji, nigdy się nie zmienia
  expiresAt        INTEGER NOT NULL,
  createdAt        INTEGER NOT NULL,
  stripeSessionId  TEXT,
  stripeSessionUrl TEXT,
  paymentIntentId  TEXT,    -- płatność, która dała bilet
  paidAt           INTEGER, -- kiedy Stripe ją przyjął
  refundStatus     TEXT CHECK (refundStatus IN ('pending', 'done', 'failed')) -- płatność, która biletu nie dała
) WITHOUT ROWID;

-- Rezerwacje sprzed etapu II: cena wydarzenia, a kupione bez czasu ważności dostają chwilę zakupu.
INSERT INTO reservations (id, eventId, seatId, amount, expiresAt, createdAt)
SELECT s.reservationId, s.eventId, s.seatId, e.price, COALESCE(s.expiresAt, s.updatedAt), s.updatedAt
  FROM seats s JOIN events e ON e.id = s.eventId
 WHERE s.reservationId IS NOT NULL;

-- 📥 Inbox: zdarzenia od Stripe'a, które już obsłużyliśmy. ID zapisujemy w tej samej transakcji
-- (D1 batch) co skutek, więc drugie dostarczenie tego samego zdarzenia odbija się od klucza głównego.
CREATE TABLE inbox (
  id          TEXT PRIMARY KEY, -- ID zdarzenia od Stripe'a (evt_…)
  processedAt INTEGER NOT NULL
) WITHOUT ROWID;
-- Sprzątanie: Stripe ponawia do 3 dni, więc pamiętamy 7 (D1 nie ma indeksów TTL, robi to Cron).
CREATE INDEX inbox_processed_idx ON inbox (processedAt);

-- 📤 Outbox: wiadomości do cudzych systemów, zapisywane w transakcji z naszymi danymi.
-- Wysyła je Cron: claim → wywołanie z kluczem idempotencji → ack. Gwarancja: co najmniej raz.
CREATE TABLE outbox (
  id          TEXT PRIMARY KEY,          -- ID joba, z niego klucz idempotencji u dostawcy
  task        TEXT NOT NULL,             -- co wysłać: stripe-refund, stripe-session-watch
  input       TEXT NOT NULL,             -- dane od API (JSON)
  visibleAt   INTEGER NOT NULL,          -- do tej chwili nikt go nie weźmie
  totalTried  INTEGER NOT NULL DEFAULT 0,-- ile razy już próbowano
  completedAt INTEGER,                   -- ustawione = wysłane (ack)
  hasError    INTEGER NOT NULL DEFAULT 0,-- 1 = odłożony na bok (DLQ)
  lastError   TEXT,
  createdAt   INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX outbox_gotowe_idx ON outbox (visibleAt) WHERE completedAt IS NULL AND hasError = 0;
