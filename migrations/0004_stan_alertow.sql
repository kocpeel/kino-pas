-- Stan alertów Workera sprzątającego (kontrola zdrowia co minutę). Jeden wiersz na rodzaj kontroli:
-- ile kolejnych kontroli się nie udało i kiedy wysłano ostatni alert (0 = nie wysłano). Dzięki temu
-- alert idzie raz na początku awarii (po 2 nieudanych kontrolach), przypomnienie co 30 min i raz po naprawie.
CREATE TABLE alert_state (
  name                TEXT PRIMARY KEY,
  consecutiveFailures INTEGER NOT NULL DEFAULT 0,
  alertedAt           INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
