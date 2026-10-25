-- Schemat kasy biletowej. Jeden wiersz w `seats` = jeden fotel na jednym seansie.
-- Wszystkie czasy w `seats` to epoch ms (UTC) z zegara Workera.

CREATE TABLE events (
  id          TEXT PRIMARY KEY,
  movie       TEXT NOT NULL,
  startsAt    TEXT NOT NULL,            -- ISO 8601 (UTC)
  hall        TEXT NOT NULL,
  rowsCount   INTEGER NOT NULL DEFAULT 8  CHECK (rowsCount BETWEEN 1 AND 26),
  seatsPerRow INTEGER NOT NULL DEFAULT 10 CHECK (seatsPerRow BETWEEN 1 AND 99)
);

CREATE TABLE seats (
  eventId        TEXT NOT NULL REFERENCES events(id),
  seatId         TEXT NOT NULL,          -- np. "F7"
  status         TEXT NOT NULL DEFAULT 'free'
                 CHECK (status IN ('free', 'reserved', 'purchased')),
  reservationId  TEXT,
  expiresAt      INTEGER,
  customerName   TEXT,
  email          TEXT,
  idempotencyKey TEXT,
  code           TEXT,
  version        INTEGER NOT NULL DEFAULT 0,
  updatedAt      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (eventId, seatId),
  -- Spójność stanu: każdy status ma komplet pól, których potrzebuje.
  CHECK (status <> 'free'      OR (reservationId IS NULL AND code IS NULL)),
  CHECK (status <> 'reserved'  OR (reservationId IS NOT NULL AND expiresAt IS NOT NULL AND code IS NULL)),
  CHECK (status <> 'purchased' OR (reservationId IS NOT NULL AND code IS NOT NULL AND expiresAt IS NULL))
) WITHOUT ROWID;

-- Unikalne tylko dla niepustych wartości (indeksy częściowe).
CREATE UNIQUE INDEX seats_reservation_id_uq  ON seats (reservationId)  WHERE reservationId IS NOT NULL;
CREATE UNIQUE INDEX seats_code_uq            ON seats (code)           WHERE code IS NOT NULL;
CREATE UNIQUE INDEX seats_idempotency_key_uq ON seats (idempotencyKey) WHERE idempotencyKey IS NOT NULL;

-- Sprzątanie wygasłych i zliczanie zajętych.
CREATE INDEX seats_status_expires_idx ON seats (status, expiresAt);
-- Limit aktywnych rezerwacji na e-mail (podzapytanie w UPDATE rezerwacji).
CREATE INDEX seats_email_status_idx   ON seats (email, status);
