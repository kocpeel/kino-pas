-- Sekret rezerwacji: skrót (SHA-256) losowego sekretu, który klient dostaje w ciasteczku HttpOnly.
-- Bez niego sam identyfikator rezerwacji (widoczny w adresie) nie wystarcza, żeby kupić bilet
-- albo zobaczyć kod. NULL = rezerwacja sprzed tej zmiany (wtedy sekret nie jest wymagany).
ALTER TABLE seats ADD COLUMN secretHash TEXT;
