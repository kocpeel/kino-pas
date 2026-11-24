-- Etap III: program lojalnościowy (Voucherify) i mail z biletem (Resend). Zakup przechodzi teraz przez trzy
-- cudze systemy, więc jest sagą (E08): kroki z kompensacjami i postęp zapisany w naszej bazie.

-- Konto punktowe klienta. Saldo prowadzi Voucherify: to źródło prawdy, bo korzysta z niego też marketing
-- i kasy. Tu jest mapowanie e-mail → karta, znak, że punkty powitalne już przyznano, ostatnie znane saldo
-- (pamięć podręczna: sandbox Voucherify przyjmuje 100 wywołań na godzinę) i krótka blokada, żeby operacje
-- na punktach jednego klienta szły po kolei (sprawdzenie salda i jego zmiana bez wyścigu).
CREATE TABLE loyalty_accounts (
  email           TEXT PRIMARY KEY,  -- znormalizowany e-mail, ten sam co source_id klienta w Voucherify
  memberId        TEXT,              -- kod karty lojalnościowej; NULL = karty jeszcze nie znamy
  -- Notatka przed założeniem karty (E07): kartę z tą notatką założył nasz sklep, więc należą się jej punkty
  -- powitalne. Karta bez notatki przyszła z innego kanału (aplikacja, kasy) i powitalnych od nas nie dostaje.
  -- Voucherify tego nie powie: metadane z zapisu do programu trafiają do publikacji, nie na kartę.
  cardRequestedAt INTEGER,
  welcomeAt       INTEGER,           -- kiedy dopisano punkty powitalne; NULL = jeszcze nie
  balance         INTEGER,           -- ostatnie saldo odczytane z Voucherify
  balanceAt       INTEGER,           -- kiedy je odczytano
  lockedUntil     INTEGER,           -- do kiedy trwa operacja na punktach klienta
  createdAt       INTEGER NOT NULL
) WITHOUT ROWID;

-- Punkty i mail przy rezerwacji (kontrakt wewnętrzny): to czyta strona biletu i GET /api/reservations/:id.
ALTER TABLE reservations ADD COLUMN pointsUsed INTEGER NOT NULL DEFAULT 0 CHECK (pointsUsed >= 0);
ALTER TABLE reservations ADD COLUMN pointsEarned INTEGER CHECK (pointsEarned >= 0);
-- Operacja na punktach po zakupie: naliczenie (bilet) albo zwrot wydanych punktów (brak biletu).
ALTER TABLE reservations ADD COLUMN pointsStatus TEXT CHECK (pointsStatus IN ('pending', 'done', 'failed'));
ALTER TABLE reservations ADD COLUMN emailStatus TEXT
  CHECK (emailStatus IN ('pending', 'sent', 'delivered', 'bounced', 'failed'));
ALTER TABLE reservations ADD COLUMN emailId TEXT;
CREATE INDEX reservations_email_idx ON reservations (emailId) WHERE emailId IS NOT NULL;

-- 🧭 Saga zakupu (orkiestracja). Kroki: punkty (Voucherify) → płatność (Stripe) → bilet (my, punkt bez odwrotu)
-- → naliczenie punktów (Voucherify) → mail (Resend). `completed` mówi, co już się udało, więc wiadomo,
-- co skompensować, a `results` trzyma to, czego kompensacja potrzebuje (karta klienta, liczba punktów).
CREATE TABLE sagas (
  id         TEXT PRIMARY KEY,                -- = reservationId: jedna saga zakupu na rezerwację
  type       TEXT NOT NULL,                   -- 'zakup'
  status     TEXT NOT NULL CHECK (status IN ('running', 'completed', 'compensating', 'compensated')),
  completed  TEXT NOT NULL DEFAULT '[]',      -- udane kroki, w kolejności
  results    TEXT NOT NULL DEFAULT '{}',      -- dane kroków: email, memberId, adres sklepu...
  failedStep TEXT,                            -- krok, który się nie udał (wtedy kompensacja)
  createdAt  INTEGER NOT NULL,
  updatedAt  INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX sagas_otwarte_idx ON sagas (updatedAt) WHERE status IN ('running', 'compensating');
