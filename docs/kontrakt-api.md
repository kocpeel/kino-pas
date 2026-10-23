# Kontrakt API (Etap I)

Wszystkie odpowiedzi to JSON (`application/json; charset=utf-8`). Czasy w `expiresAt` to epoch ms (UTC) z zegara serwera.
Błędy mają zawsze ten sam kształt:

```json
{ "error": "seat_taken", "message": "Ten fotel został właśnie zajęty.", "details": { "pole": "opis" } }
```

`details` pojawia się tylko przy błędach walidacji pól (400). Odpowiedzi 429 i 503 mają nagłówek `Retry-After` (sekundy).

Oba GET-y mają słaby `ETag`. Klient, który wyśle `If-None-Match` z aktualnym ETagiem, dostaje **304 bez treści**
(tak odpytuje mapa sali, więc sprawdzenie „czy coś się zmieniło" kosztuje kilkadziesiąt bajtów).

## Endpointy

| Metoda | Ścieżka | Sukces | Błędy |
|---|---|---|---|
| GET | `/api/events` | 200 `SeansNaLiscie[]`, 304 | 503 |
| GET | `/api/events/:id` | 200 `{ event, takenSeats }`, 304 | 404, 503 |
| POST | `/api/reservations` | 201 `{ reservationId, expiresAt }` | 400, 404, 409, 413, 422, 429, 503 |
| POST | `/api/reservations/:id/purchase` | 201 `{ code }` (pierwszy zakup), 200 `{ code }` (powtórka) | 400, 410, 503 |

### GET /api/events

```json
[
  {
    "id": "metropolis-2026-11-06",
    "movie": "Metropolis",
    "startsAt": "2026-11-06T18:30:00.000Z",
    "hall": "Sala 1",
    "rowsCount": 8,
    "seatsPerRow": 10,
    "totalSeats": 80,
    "freeSeats": 78
  }
]
```

- „Wolny" = `free` albo `reserved` z `expiresAt ≤ teraz` (leniwe wygasanie).
- Świeżość: najwyżej 5 s (`EVENTS_CACHE_SECONDS`). Rezerwacja od razu unieważnia cache w izolacie, który ją przyjął.
- Cache: `Cache-Control: public, max-age=0, s-maxage=5, stale-while-revalidate=5, stale-if-error=600`.
- Tryb awaryjny (D1 zawodzi albo przeciążenie): 200 z ostatnimi znanymi danymi i nagłówkami
  `X-Data-Stale: true`, `X-Data-Age: <s>`, `Cache-Control: no-store`. Bez danych w cache: 503.

### GET /api/events/:id

```json
{
  "event": { "id": "metropolis-2026-11-06", "movie": "Metropolis", "startsAt": "2026-11-06T18:30:00.000Z",
             "hall": "Sala 1", "rowsCount": 8, "seatsPerRow": 10 },
  "takenSeats": ["F7", "D5"]
}
```

- `takenSeats` to wyłącznie identyfikatory foteli, posortowane (ten sam stan = ten sam ETag). Nigdy imiona ani e-maile.
- „Zajęty" = `purchased` albo `reserved` z `expiresAt > teraz`.
- Cache: `public, max-age=1`. Nieaktualna mapa nie szkodzi: ostatnie słowo ma warunkowy zapis (409).

### POST /api/reservations

Nagłówki: `Content-Type: application/json` (wymagany), `Idempotency-Key` (zalecany; 8–128 znaków `[A-Za-z0-9_.:-]`).

```json
{ "eventId": "metropolis-2026-11-06", "seatId": "F7", "name": "Jan", "email": "jan@example.com" }
```

- `seatId` to tekst „F7" walidowany względem układu sali A–H × 1–10 (wielkie litery; `f7` → 400).
- `name`: 2–80 znaków po scaleniu białych znaków. `email`: normalizowany do małych liter, bez spacji dookoła.
- Limit ciała: 4 KiB (413).

| Kod | `error` | Kiedy |
|---|---|---|
| 201 | – | `{ reservationId, expiresAt }`. Powtórka z tym samym kluczem zwraca to samo + nagłówek `Idempotent-Replayed: true`. |
| 400 | `invalid_input` | Zły JSON, brak pól, nieznany fotel, zły `Idempotency-Key`. |
| 404 | `not_found` | Nie ma takiego seansu. |
| 409 | `seat_taken` | Fotel zajęty (albo rezerwacja z tym kluczem została już opłacona). |
| 413 | `payload_too_large` | Ciało > 4 KiB. |
| 422 | `idempotency_key_reused` | Klucz użyty wcześniej z innym seansem, fotelem albo e-mailem. |
| 429 | `rate_limited` | Limit żądań na IP lub e-mail (Retry-After = okno limitu). |
| 429 | `too_many_active_reservations` | E-mail ma już maks. liczbę aktywnych rezerwacji (Retry-After = do wygaśnięcia najstarszej). |
| 503 | `overloaded` / `unavailable` | Przeciążenie (load shedding) albo baza niedostępna/timeout. Bezpieczne do ponowienia z tym samym kluczem. |

Powtórka z tym samym kluczem **po wygaśnięciu** pierwszej rezerwacji jest traktowana jak nowe żądanie (nowa rezerwacja, jeśli fotel wolny).

### POST /api/reservations/:id/purchase

Bez ciała. Idempotentny przez warunek na stanie:

| Kod | Kiedy |
|---|---|
| 201 `{ code }` | Pierwszy udany zakup (rezerwacja ważna: `expiresAt > teraz`). |
| 200 `{ code }` | Bilet już kupiony tą rezerwacją: zwracamy **zapisany** kod (retry, podwójne kliknięcie). |
| 400 `invalid_input` | `:id` nie jest UUID. |
| 410 `reservation_expired` | Rezerwacja wygasła albo nigdy nie istniała (celowo ten sam komunikat). |
| 503 | Przeciążenie albo baza niedostępna. Bezpieczne do ponowienia. |

Kod biletu: `XXXX-XXXX` z alfabetu Crockforda (bez I, L, O, U), 40 bitów losowości.

## Priorytety pod obciążeniem

zakup > rezerwacja > szczegóły > lista. Odczyty i zapisy mają osobne pule (bulkhead); 25% puli zapisów jest zarezerwowane dla zakupów.
