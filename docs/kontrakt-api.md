# Kontrakt API (etapy I–IV)

Wszystkie odpowiedzi to JSON (`application/json; charset=utf-8`). Czasy w `expiresAt` to epoch ms (UTC) z zegara serwera.
Kwoty (`price`, `amount`) to grosze, waluta PLN: 3200 to 32 zł. Konwencja: 2xx sukces, 4xx odmowa z komunikatem, 5xx błąd serwera.
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
| GET | `/api/events/:id` | 200 `{ event, takenSeats, soldOut }`, 304 | 404, 503 |
| POST | `/api/reservations` | 201 `{ reservationId, expiresAt, amount }` | 400, 404, 409, 413, 422, 429, 503 |
| GET | `/api/reservations/:id` | 200 `{ status, amount, expiresAt, pointsUsed, code?, pointsEarned? }` | 400, 404, 503 |
| POST | `/api/reservations/:id/checkout` | 200 `{ url }`; ciało opcjonalne `{ points }` | 400, 404, 409, 410, 422, 503 |
| POST | `/api/events/:id/waitlist` (etap IV) | 201 `{ waitlistId, position }`, 200 ten sam zapis | 400, 404, 409, 413, 429, 503 |
| GET | `/api/waitlist/:id` (etap IV) | 200 `{ status, position, reservationId?, offerExpiresAt? }` | 400, 404, 429, 503 |
| DELETE | `/api/waitlist/:id` (etap IV) | 200 `{ status: "left", position: 0 }` | 400, 404, 409, 429, 503 |
| POST | `/api/webhooks/stripe` | 200 `{ received: true }` | 400, 413, 503 |
| GET | `/api/loyalty?email=…` (etap III) | 200 `{ email, points }` | 400, 429, 503 |
| POST | `/api/webhooks/resend` (etap III) | 200 `{ received: true }` | 400, 413, 503 |
| POST | `/api/reservations/:id/purchase` | 200 `{ code }` opłaconej rezerwacji | 400, 402, 410, 503 |
| GET | `/api/zdrowie` (poza kontraktem, do monitoringu) | 200 `{ status: "ok" \| "degraded", db: { latencyMs, avgLatencyMs }, loadShedding: { capacity }, payments: { configured } }` | 503 |

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
    "price": 3200,
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
             "hall": "Sala 1", "rowsCount": 8, "seatsPerRow": 10, "price": 3200 },
  "takenSeats": ["F7", "D5"],
  "soldOut": false
}
```

- `takenSeats` to wyłącznie identyfikatory foteli, posortowane (ten sam stan = ten sam ETag). Nigdy imiona ani e-maile.
- „Zajęty" = `purchased` albo `reserved` z `expiresAt > teraz`.
- `soldOut` (etap IV): `true`, gdy każde miejsce jest kupione albo ma ważną rezerwację (`takenSeats` obejmuje całą salę).
  Wtedy można zapisać się na listę oczekujących.
- Etap IV: `GET /api/events` zawiera wydarzenie testowe `waitlist-test` z dokładnie dwoma miejscami (`rowsCount: 1`,
  `seatsPerRow: 2`, fotele `A1` i `A2`). Gdy na sali ktoś czeka na liście, odczyt najpierw przesuwa kolejkę: zwolnione
  miejsce od razu dostaje pierwsza osoba z kolejki, więc w `takenSeats` jest już jako jej rezerwacja.
- Cache: `public, max-age=1`. Nieaktualna mapa nie szkodzi: ostatnie słowo ma warunkowy zapis (409).

### POST /api/reservations

Nagłówki: `Content-Type: application/json` (wymagany), `Idempotency-Key` (zalecany; 8–128 znaków `[A-Za-z0-9_.:-]`).

```json
{ "eventId": "metropolis-2026-11-06", "seatId": "F7", "customerName": "Jan", "email": "jan@example.com" }
```

- `seatId` to tekst „F7" walidowany względem układu sali A–H × 1–10 (wielkie litery; `f7` → 400).
- `customerName`: 2–80 znaków po scaleniu białych znaków. Dawna nazwa pola `name` działa dalej, gdy `customerName`
  nie ma w ciele; błąd walidacji wskazuje to pole, które przysłał klient. `email`: normalizowany do małych liter,
  bez spacji dookoła.
- Etap IV: gdy na sali ktoś czeka na liście oczekujących, zwolnione miejsce należy najpierw do kolejki, więc zwykła
  rezerwacja tego miejsca dostaje 409 `seat_taken`.
- Limit ciała: 4 KiB (413).
- `amount` to cena z chwili rezerwacji. Późniejsza zmiana `price` jej nie rusza, a płatność idzie zawsze na tę kwotę.

| Kod | `error` | Kiedy |
|---|---|---|
| 201 | – | `{ reservationId, expiresAt, amount }`. Powtórka (ten sam klucz albo identyczne żądanie, niżej) zwraca to samo + nagłówek `Idempotent-Replayed: true`. |
| 400 | `invalid_input` | Zły JSON, brak pól, nieznany fotel, zły `Idempotency-Key`. |
| 404 | `not_found` | Nie ma takiego seansu. |
| 409 | `seat_taken` | Fotel zajęty (albo rezerwacja z tym kluczem została już opłacona). |
| 413 | `payload_too_large` | Ciało > 4 KiB. |
| 422 | `idempotency_key_reused` | Klucz użyty wcześniej z innym seansem, fotelem albo e-mailem. |
| 429 | `rate_limited` | Limit prób z jednego IP (tryb oceny etapu: 50 na 10 s; limity na e-mail wyłączone). Retry-After = za ile sekund zwolni się miejsce w oknie. |
| 429 | `too_many_active_reservations` | E-mail ma już maks. liczbę aktywnych rezerwacji, jeśli limit jest włączony (`MAX_ACTIVE_RESERVATIONS_PER_EMAIL` > 0). Retry-After = do wygaśnięcia najstarszej. |
| 503 | `overloaded` / `unavailable` | Przeciążenie (load shedding) albo baza niedostępna/timeout. Bezpieczne do ponowienia z tym samym kluczem. |

Powtórka z tym samym kluczem **po wygaśnięciu** pierwszej rezerwacji jest traktowana jak nowe żądanie (nowa rezerwacja, jeśli fotel wolny).

**Identyczne żądanie bez klucza.** Gdy fotel trzyma już ważna rezerwacja z tym samym imieniem i e-mailem, drugi taki POST
(bez `Idempotency-Key` albo z innym kluczem) dostaje tę samą rezerwację zamiast 409: to podwójne kliknięcie albo
ponowienie. Inne imię lub e-mail na zajętym fotelu → 409.

Odpowiedzi nie ustawiają ciasteczek: cała ścieżka (rezerwacja → płatność → kod) działa z samym `reservationId`, jak we wspólnym
kontrakcie. Identyfikator to losowy UUID v4 (122 bity), więc nie da się go zgadnąć.

### GET /api/reservations/:id

Stan rezerwacji, bez pytania Stripe'a. Przez to strona powrotu nie czeka ani na kartę A, ani na B.

```json
{
  "status": "paid", "amount": 3200, "expiresAt": 1793563812419, "code": "WGHZ-VJ4X",
  "pointsUsed": 1000, "pointsEarned": 220, "pointsStatus": "done", "emailStatus": "sent"
}
```

| `status` | Kiedy |
|---|---|
| `held` | Rezerwacja trzyma fotel (`expiresAt > teraz`), jeszcze nie opłacona. |
| `paid` | Opłacona. `code` to kod biletu. |
| `expired` | Rezerwacja wygasła: także gdy fotel ma już nowego właściciela. |

Pole `refund` pojawia się tylko, gdy płatność nie dała biletu (np. przyszła po `expiresAt`): `pending` albo `done`,
a `failed`, gdy automatyczny zwrot się nie udał. Nieznana rezerwacja: 404 `not_found`. Zły identyfikator: 400 `invalid_input`.

Punkty (etap III):

| Pole | Kiedy | Znaczenie |
|---|---|---|
| `pointsUsed` | zawsze | Ile punktów zeszło z konta na tę rezerwację (0 = bez punktów). Kartą płaci się `amount − pointsUsed`. |
| `pointsEarned` | tylko `paid` | Punkty za zakup: 10 za każdy pełny złoty zapłacony kartą. |
| `pointsStatus` | po bilecie albo po zwrocie | `pending` → `done`: naliczenie punktów za zakup (bilet) albo oddanie wydanych punktów (brak biletu). `failed`: nie udało się automatycznie. |
| `emailStatus` | po bilecie | Mail z biletem: `pending`, `sent`, potem `delivered` albo `bounced` (z webhooka Resend); `failed`, gdy Resend odmówił. |

### POST /api/reservations/:id/checkout

Ciało opcjonalne: `{ "points": 1000 }` (etap III). Bez `points` działa jak w etapie II. Tworzy sesję Stripe Checkout
i zwraca `{ url }` strony płatności. Kwota sesji to zawsze `amount` z rezerwacji pomniejszone o punkty: inne pola
ciała, np. `amount`, nic nie zmieniają. Punkty schodzą z konta klienta w Voucherify, zanim powstanie sesja.
Ponowienie, podwójne kliknięcie i powrót po przerwanej płatności dają **tę samą** sesję, a punkty schodzą raz.
Liczbę punktów ustala pierwszy udany checkout.

| Kod | `error` | Kiedy |
|---|---|---|
| 200 | – | `{ url }`. |
| 400 | `invalid_input` | `:id` nie jest UUID albo `points` nie jest liczbą całkowitą ≥ 0 albo przekracza połowę `amount` (`details.points`). |
| 404 | `not_found` | Nie ma takiej rezerwacji. |
| 409 | `reservation_already_paid` | Rezerwacja jest już opłacona. |
| 409 | `points_locked` | Płatność jest już przygotowana z inną liczbą punktów. Bez `points` albo z tą samą liczbą: ta sama sesja. |
| 410 | `reservation_expired` | Rezerwacja wygasła. |
| 409 | `points_busy` | W tej samej chwili trwa inna operacja na punktach klienta (np. druga karta przeglądarki płaci punktami), a nie skończyła się w ciągu 8 s. Nic nie zeszło. Ma `Retry-After`. |
| 422 | `not_enough_points` | Klient ma za mało punktów (`details.points` mówi, ile ma). Nic nie zeszło (także gdy Voucherify zdjął mniej, bo saldo w pamięci było starsze: korekta oddaje to, co zeszło). |
| 503 | `payments_unavailable` | Stripe nie odpowiada albo płatności nie są skonfigurowane. Rezerwacja dalej trzyma fotel, a ponowienie jest bezpieczne. Ma `Retry-After`. |
| 503 | `points_unavailable` | Voucherify nie odpowiada albo budżet wywołań jest wyczerpany. Ponowienie jest bezpieczne, a płatność bez punktów działa. Ma `Retry-After`. |

Sesja żyje co najmniej 30 minut, czyli dłużej niż rezerwacja. Po wygaśnięciu rezerwacji sesję wygasza strażnik
(budzik outboxu w chwili `expiresAt`, a najpóźniej Cron po około minucie), a płatność, która mimo to zdąży, wraca
do klienta i nie daje biletu. Wydane punkty wracają w tej samej chwili; `GET /api/loyalty` tego klienta sam dokańcza
zwrot, jeśli jeszcze go nie było, więc saldo sprzed zakupu widać zaraz po `expiresAt`.

### POST /api/webhooks/stripe

Zdarzenia od Stripe'a. Wymaga poprawnego nagłówka `Stripe-Signature` (podpis surowego ciała, tolerancja 5 min).
Obsługiwane: `checkout.session.completed` i `checkout.session.async_payment_succeeded`, o ile `payment_status` to `paid`.

| Kod | Kiedy |
|---|---|
| 200 `{ received: true }` | Obsłużone, także duplikat, inny typ zdarzenia i zdarzenie o cudzej rezerwacji. Stripe przestaje ponawiać. |
| 400 `invalid_signature` | Brak albo zły podpis, za stary znacznik czasu. Nic się nie zmienia. |
| 413 `payload_too_large` | Ciało > 1 MiB. |
| 503 | Baza niedostępna albo brak sekretu webhooka. Stripe ponowi. |

### GET /api/loyalty?email=… (etap III)

Saldo punktów klienta. Identyfikatorem konta jest e-mail (normalizowany do małych liter).

```json
{ "email": "jan@example.com", "points": 1000 }
```

- E-mail, który jeszcze nic nie kupił (nie ma karty w Voucherify), ma 1000 punktów (punkty powitalne). Kartę
  zakładamy przy pierwszym użyciu punktów albo przy pierwszym naliczeniu, nie przy odczycie salda.
- Limit: 60 odczytów na minutę z jednego IP (`LOYALTY_READS_PER_IP_PER_MINUTE`), potem 429 `rate_limited`
  z `Retry-After`; klient z innej sieci czyta i płaci punktami dalej.
- Przed odczytem kończą się zaległe operacje na punktach tego klienta (zwrot po porzuconej płatności, naliczenie
  po zakupie), więc saldo jest już po nich.
- Źródłem prawdy jest Voucherify, także dla e-maila, którego jeszcze nie znamy: kartę mogła mu założyć aplikacja albo
  kasa, i wtedy podajemy jej saldo. Saldo z ostatnich 30 s podajemy z pamięci podręcznej (sandbox Voucherify przyjmuje
  100 wywołań na godzinę). Gdy Voucherify albo budżet wywołań odmówi: ostatnie znane saldo z nagłówkami
  `X-Data-Stale: true` i `X-Data-Age: <s>`; dla nieznanego e-maila 1000 z `X-Data-Stale: true`; znany klient bez
  zapamiętanego salda dostaje 503 `points_unavailable` z `Retry-After`.
- Zły e-mail: 400 `invalid_input`.

### POST /api/webhooks/resend (etap III)

Los wysłanego maila od Resend. Wymaga podpisu Svix (`svix-id`, `svix-timestamp`, `svix-signature`, tolerancja 5 min).
Obsługiwane: `email.delivered`, `email.bounced`, `email.failed` (zmieniają `emailStatus` rezerwacji albo oferty z listy
oczekujących). Odbity albo nieudany mail z ofertą (etap IV) kończy ofertę jako `missed` i od razu przesuwa kolejkę.
200 także dla duplikatu i innych typów, 400 `invalid_signature` przy złym podpisie, 503 bez sekretu webhooka.

### POST /api/events/:id/waitlist (etap IV)

Zapis na listę oczekujących wyprzedanego wydarzenia. Nagłówek `Content-Type: application/json`.

```json
{ "email": "jan@example.com", "customerName": "Jan" }
```

| Kod | `error` | Kiedy |
|---|---|---|
| 201 | – | `{ waitlistId, position }`: nowy zapis; `position` liczy się od 1. |
| 200 | – | Ten e-mail już czeka na to wydarzenie (albo ma ofertę): ten sam zapis i jego aktualna pozycja, nagłówek `Idempotent-Replayed: true`. |
| 400 | `invalid_input` | Zły JSON albo pola (`details.email`, `details.customerName`). |
| 404 | `not_found` | Nie ma takiego wydarzenia. |
| 409 | `not_sold_out` | Wydarzenie nie jest wyprzedane: jest wolne miejsce do zwykłej rezerwacji. |
| 429 | `rate_limited` | Za dużo zapisów z jednego IP (20 na minutę). |

### GET /api/waitlist/:id (etap IV)

```json
{ "status": "offered", "position": 0, "reservationId": "…", "offerExpiresAt": 1794942560366, "seatId": "A1" }
```

- `status`: `waiting` (czeka w kolejce), `offered` (ma zarezerwowane miejsce), `done` (kupił bilet), `missed` (nie
  zapłacił na czas albo mail z ofertą do niego nie doszedł), `left` (wypisał się).
- `position`: miejsce w kolejce od 1 dla `waiting`; 0, gdy osoba już nie czeka.
- `reservationId` i `offerExpiresAt` od oferty: miejsce to zwykła rezerwacja z etapu I (`GET /api/reservations/:id`,
  checkout z punktami albo bez), a `offerExpiresAt` to jej `expiresAt`. `seatId` jest dodatkiem (link i opis w panelu).
- Odczyt najpierw przesuwa kolejkę (leniwie, jak wygasanie rezerwacji), więc status jest aktualny co do sekundy.
- 400 przy złym identyfikatorze, 404 bez zapisu, 429 powyżej 120 odczytów na minutę z jednego IP.

### DELETE /api/waitlist/:id (etap IV)

Wypisanie z listy w każdej chwili: 200 `{ "status": "left", "position": 0 }`. Osoba z ofertą oddaje miejsce, które
od razu dostaje następna osoba z kolejki (wydane na nie punkty wracają). Drugie wypisanie, a także wypisanie po
`missed`, to 200 bez zmian. Po zakupie (`done`) 409 `waitlist_done`. 400 przy złym identyfikatorze, 404 bez zapisu.

### POST /api/reservations/:id/purchase

Bez ciała. Od etapu II zakup to płatność, więc ten endpoint nie wydaje biletu, tylko oddaje kod opłaconej rezerwacji.

| Kod | Kiedy |
|---|---|
| 200 `{ code }` | Rezerwacja opłacona: **zapisany** kod, za każdym razem ten sam. |
| 400 `invalid_input` | `:id` nie jest UUID. |
| 402 `payment_required` | Rezerwacja jest ważna, ale nieopłacona. |
| 410 `reservation_expired` | Rezerwacja wygasła albo nigdy nie istniała (celowo ten sam komunikat). |
| 503 | Przeciążenie albo baza niedostępna. Bezpieczne do ponowienia. |

Kod biletu: `XXXX-XXXX` z alfabetu Crockforda (bez I, L, O, U), 40 bitów losowości.

### GET /api/events/:id/live (WebSocket)

Kanał na żywo mapy sali. Wymaga `Upgrade: websocket`, a `Origin` (jeśli jest) musi być tym samym hostem.

| Kod | Kiedy |
|---|---|
| 101 | Połączono. |
| 403 | Obcy `Origin`. |
| 404 | Nieznany seans albo niepoprawny identyfikator. |
| 426 | Zwykłe żądanie HTTP zamiast WebSocketu. |
| 429 | Za dużo połączeń z jednego IP: ponad 10 równoczesnych na salę (`Retry-After: 30`) albo zgrubny limit nowych połączeń (`Retry-After: 60`). |
| 503 | Kanał chwilowo niedostępny albo przeciążenie: nowe połączenia odpadają pierwsze (`Retry-After: 5`). Mapa działa wtedy na odpytywaniu. |

Wiadomości serwera (tekst JSON), wysyłane zaraz po połączeniu, po każdej rezerwacji na tej sali i gdy rezerwacja wygaśnie:

```json
{ "typ": "stan", "dane": { "event": { "id": "…" }, "takenSeats": ["F7"] }, "etag": "W/\"53a7c646-b3\"" }
```

`dane` i `etag` są identyczne z odpowiedzią `GET /api/events/:id`, więc po zerwaniu kanału klient wraca do odpytywania
z `If-None-Match`. Klient może wysyłać `ping` (podtrzymanie), serwer odpowiada `pong`.

## Priorytety pod obciążeniem

płatność (checkout i webhook) > rezerwacja > szczegóły > lista. Odczyty i zapisy mają osobne pule (bulkhead); 25% puli zapisów jest zarezerwowane dla płatności.
