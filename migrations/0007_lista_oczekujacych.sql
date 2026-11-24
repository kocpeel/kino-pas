-- Etap IV: lista oczekujących na wyprzedane wydarzenie. Zwolnione miejsce dostaje pierwsza osoba z kolejki
-- jako zwykłą rezerwację z etapu I (reservationId, expiresAt), a link w mailu prowadzi do jej płatności.

CREATE TABLE waitlist (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT, -- kolejność zapisów: z niej liczymy miejsce w kolejce
  id             TEXT NOT NULL UNIQUE,              -- waitlistId (UUID) z kontraktu
  eventId        TEXT NOT NULL REFERENCES events (id),
  email          TEXT NOT NULL,                     -- znormalizowany, jak w rezerwacji
  customerName   TEXT NOT NULL,
  -- waiting: czeka; offered: ma zarezerwowane miejsce; done: kupił bilet; missed: nie zapłacił na czas albo
  -- mail z ofertą do niego nie doszedł; left: wypisał się.
  status         TEXT NOT NULL CHECK (status IN ('waiting', 'offered', 'done', 'missed', 'left')),
  reservationId  TEXT,                              -- rezerwacja z oferty (od statusu offered)
  seatId         TEXT,
  offerExpiresAt INTEGER,                           -- = expiresAt tej rezerwacji
  emailId        TEXT,                              -- id maila z ofertą w Resend (łączy webhook z ofertą)
  emailStatus    TEXT CHECK (emailStatus IN ('pending', 'sent', 'delivered', 'bounced', 'failed')),
  adres          TEXT,                              -- adres sklepu z chwili zapisu: link w mailu
  createdAt      INTEGER NOT NULL,
  updatedAt      INTEGER NOT NULL,
  CHECK (status NOT IN ('offered', 'done') OR (reservationId IS NOT NULL AND seatId IS NOT NULL AND offerExpiresAt IS NOT NULL))
);

-- Jeden aktywny zapis klienta na wydarzenie: drugi „Powiadom mnie” oddaje ten sam zapis.
CREATE UNIQUE INDEX waitlist_aktywny_zapis ON waitlist (eventId, email) WHERE status IN ('waiting', 'offered');
-- Kolejka wydarzenia: pierwsza osoba i pozycja (liczba czekających przed nią).
CREATE INDEX waitlist_kolejka ON waitlist (eventId, status, seq);
-- Jedna oferta na rezerwację; webhook Resend znajduje ofertę po id maila.
CREATE UNIQUE INDEX waitlist_rezerwacja ON waitlist (reservationId) WHERE reservationId IS NOT NULL;
CREATE INDEX waitlist_mail ON waitlist (emailId) WHERE emailId IS NOT NULL;

-- Wydarzenie testowe z kontraktu etapu IV: dokładnie dwa miejsca. Także na produkcji, gdzie seedu się nie
-- uruchamia; INSERT OR IGNORE, więc migracja nie nadpisze wydarzenia, które już jest.
INSERT OR IGNORE INTO events (id, movie, startsAt, hall, rowsCount, seatsPerRow, price)
VALUES ('waitlist-test', 'Lista oczekujących: seans testowy', '2026-12-31T18:00:00.000Z', 'Sala kameralna', 1, 2, 3200);
INSERT OR IGNORE INTO seats (eventId, seatId) VALUES ('waitlist-test', 'A1'), ('waitlist-test', 'A2');
