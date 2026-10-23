# Decyzje projektowe

## 1. Wyścig o fotel: jedno warunkowe UPDATE w D1

Zamiast „sprawdź, czy wolny, potem zapisz" (dwie osoby zobaczą TAK) każdy zapis to jedno zdanie
`UPDATE … WHERE <warunek na stanie>`. SQLite (D1) wykonuje je atomowo, a o wyniku mówi `meta.changes`:

- **rezerwacja**: `status = 'free' OR (status = 'reserved' AND expiresAt <= now)` + podzapytanie z limitem
  aktywnych rezerwacji e-maila w tym samym zdaniu, więc limit też jest atomowy;
- **zakup**: `reservationId = ? AND status = 'reserved' AND expiresAt > now`;
- przy 0 zmienionych wierszy **dopiero wtedy** czytamy wiersz, tylko po to, by dobrać komunikat (409 / 429 / 410).
  Poprawność od tego odczytu nie zależy.

Alternatywa (Durable Object na seans) byłaby elegantsza, ale trudniejsza. Na Etap I D1 wystarcza
i dobrze się testuje (W1–W6 w `tests/integracyjne/wspolbieznosc.test.ts`).

## 2. Wygasanie leniwe, Cron tylko sprząta

O ważności rezerwacji decyduje porównanie `expiresAt` z czasem serwera przy każdym odczycie i zapisie.
Cron (osobny Worker `workers/sprzatanie`, co minutę) zwalnia wygasłe wiersze i czyści dane osobowe,
ale aplikacja działa poprawnie nawet, gdy Cron się spóźni albo nie ruszy.

Cron jest w osobnym Workerze, bo Worker generowany przez OpenNext obsługuje tylko `fetch`. OpenNext ma
„custom worker" z handlerem `scheduled`, ale osobny Worker jest prostszy i niezależny od wersji adaptera.

## 3. Czas i TTL

- Czas tylko z `src/lib/czas.ts`; handler bierze „teraz" raz na żądanie i przekazuje liczbę dalej.
  W testach zegar jest podmieniany i „przewijany".
- TTL z `RESERVATION_TTL_SECONDS` (`src/lib/config.ts`). Brak wartości → 15 min; wartość niepoprawna →
  czytelny błąd `BladKonfiguracji` (500 `server_misconfigured` + log), a nie cicha wartość domyślna.
- Klient liczy licznik z `expiresAt` serwera. Przesunięcie zegara przeglądarki szacujemy z nagłówka `Date`
  (stosowane tylko, gdy > 2 s, bo nagłówek ma rozdzielczość 1 s).

## 4. Idempotencja

- Rezerwacja: nagłówek `Idempotency-Key` zapisany w wierszu fotela (unikalny indeks częściowy).
  Ta sama (seans, fotel, e-mail) i nadal ważna → ta sama odpowiedź. Inne dane → 422.
  **Po wygaśnięciu** pierwszej rezerwacji powtórka = nowe żądanie (rekomendacja z planu testów).
  Po opłaceniu rezerwacji powtórka → 409.
- Równoległe żądania z tym samym kluczem: przegrany UPDATE (0 zmian albo naruszenie unikalności klucza)
  sprawdza jeszcze raz klucz i zwraca rezerwację zwycięzcy.
- Zakup: idempotentny przez warunek na stanie. **Decyzja: 201 przy pierwszym zakupie, 200 przy powtórce**
  (zawsze ten sam, zapisany kod).
- Formularz trzyma klucz w `sessionStorage` per (seans, fotel), więc ponowienie po timeoucie, nawet po
  odświeżeniu strony, nie tworzy drugiej rezerwacji. Klucz jest usuwany po sukcesie i po odpowiedziach,
  które przesądzają, że rezerwacja nie powstała (400/404/409/422/429).

## 5. Odporność

| Mechanizm | Gdzie | Uwagi |
|---|---|---|
| Timeout | `resilience/timeout.ts` (serwer, `DB_TIMEOUT_MS`), `klient/api.ts` (8 s, każdy fetch) | Zapytania D1 nie da się anulować, dlatego ponowienia są idempotentne. |
| Retry | `klient/api.ts` | GET: 3 próby, backoff z pełnym jitterem, szanuje `Retry-After` ≤ 5 s. POST rezerwacji tylko z kluczem. Zakup też (idempotentny przez stan). |
| Rate limiting | `resilience/limit-zapytan.ts`, binding Workers Rate Limiting | Osobno IP i e-mail (e-mail jako skrót SHA-256). Awaria limitera = przepuszczamy (fail-open). |
| Limit aktywnych rezerwacji | podzapytanie w UPDATE | Założenie spoza treści zadania. `MAX_ACTIVE_RESERVATIONS_PER_EMAIL=0` wyłącza. |
| Load shedding + bulkhead | `resilience/przeciazenie.ts` | Osobne pule odczytów i zapisów, priorytety zakup > rezerwacja > szczegóły > lista. Liczniki per izolat (przybliżenie). |
| Fallback | `http/odczyty.ts` | Lista z cache (izolat + Cache API), baner „Pokazujemy dane sprzed chwili", rezerwowanie wyłączone. |
| Błędy bazy | `http/obsluga-trasy.ts` | Każdy błąd spoza domeny przy pracy z D1 → 503 + `Retry-After`, nigdy 500 ani wiszące żądanie. |

Świadomie pominięte w Etapie I: circuit breaker, kolejki i DLQ (brak zewnętrznych zależności; rezerwacja musi
odpowiedzieć od razu). Cloudflare Queues + DLQ mają sens przy mailach z potwierdzeniem.

## 6. Pamięć i wycieki

- Serwer: zero rosnących `Map`/tablic i `setInterval` na poziomie modułu. Jedyny stan izolatu to dwa liczniki
  strażnika przeciążenia i cache z limitem wpisów i TTL, trzymane na `globalThis` (jeden egzemplarz na izolat, patrz pkt 7).
  Pilnuje tego `scripts/sprawdz-stan-modulu.mjs` (`npm run lint:wycieki`, uruchamiany też w testach jednostkowych).
- Klient: każdy `useEffect` z timerem/fetchem ma cleanup; polling pauzuje na ukrytej karcie i zatrzymuje się po
  kilku porażkach; licznik liczony z `expiresAt`, jeden timer. Testy sprawdzają `vi.getTimerCount() === 0`
  po odmontowaniu.

## 7. Świeżość odczytów i koszt odświeżania mapy

**Repertuar.** Lista seansów z liczbą wolnych miejsc ma cache izolatu na 5 s (`EVENTS_CACHE_SECONDS`), a udana
rezerwacja od razu go unieważnia. Ważne: Next.js pakuje każdą stronę i każdy route handler osobno, z własnymi kopiami
modułów, więc cache w zmiennej modułu NIE był wspólny dla strony repertuaru i API rezerwacji (rezerwacja czyściła cache
API, a strona dalej pokazywała stare liczby). Cache i strażnik przeciążenia są dlatego trzymane na `globalThis`
(klucze `Symbol.for`), czyli naprawdę raz na izolat. Inne izolaty dogonią zmianę najpóźniej po 5 s.
Po stronie przeglądarki repertuar odświeża się sam po „Wstecz" (Next.js pokazuje wtedy stary render z pamięci routera),
po powrocie na kartę i co 60 s w tle, tylko przy widocznej karcie.

**Mapa sali.** Klient odpytuje `GET /api/events/:id`, ale tanio:

| Co | Efekt |
|---|---|
| Interwał adaptacyjny: 5 s, a gdy nic się nie zmienia ×1,5 aż do 30 s; powrót do 5 s po zmianie, po powrocie na kartę i przy interakcji z mapą | Spokojna sala: ok. 12 zapytań w 5 min zamiast 60. |
| `ETag` + `If-None-Match` → 304 bez treści | Sprawdzenie bez zmian to kilkadziesiąt bajtów zamiast pełnej odpowiedzi. |
| Indeks `(eventId, status, expiresAt)` i warunek `status IN (...)` | D1 czyta tylko zajęte wiersze seansu, a nie 80 foteli przy każdym zapytaniu (zapytanie jest pokrywane indeksem). |
| Cache szczegółów w izolacie 1 s | Tłum oglądających w jednym izolacie = jedno zapytanie do D1 na sekundę. |
| Pauza na ukrytej karcie, zatrzymanie po 4 porażkach | Zero zapytań z kart w tle. |

Poprawność od tego nie zależy: nieaktualna mapa najwyżej pokaże wolny fotel, który jest już zajęty, a zapis i tak
odpowie 409. Prawdziwy „push" (Durable Object na seans + WebSocket z hibernacją, rozsyłanie zmian i alarm przy wygaśnięciu)
dałby aktualizację natychmiast i bez odpytywania, ale plan Etapu I świadomie wyklucza długie połączenia. To kandydat na kolejny etap.

## 8. Dane między ekranami

Kontrakt nie ma GET rezerwacji, więc `eventId`, `seatId` i `reservationId` są w adresie, a `expiresAt`, imię,
e-mail i kod w `sessionStorage` (z `try/catch`). Dane osobowe nigdy nie trafiają do URL. Bilet otwarty w nowej
karcie odtwarza kod idempotentnym POST zakupu. Uwaga: dla jeszcze nieopłaconej, ważnej rezerwacji wejście na
`/bilet/:id` ją kupi, bo tak działa zakup bez płatności w Etapie I; do strony biletu prowadzi tylko udany zakup.

## 9. Testy: co dowodzą, a czego nie

Lokalny D1 serializuje zapisy, więc testy W1–W6 dowodzą poprawności **warunków w zapytaniach**, a nie zachowania
pod prawdziwym opóźnieniem sieci. Do tego jest `tests/obciazenie/w1-ten-sam-fotel.js` (k6) na środowisku
testowym w Cloudflare.

## 10. Środowisko i narzędzia

- Next.js 16 + `@opennextjs/cloudflare` 1.20, Wrangler 4, D1, Rate Limiting binding.
- `@cloudflare/vitest-pool-workers` zostało przemianowane na `@cloudflare/vitest-plugin` (API `cloudflareTest()`).
- `.npmrc` ma `legacy-peer-deps=true`: npm 10 wywraca się na drzewie peer-dependencies Vitest 4
  (`Cannot read properties of null (reading 'edgesOut')`).
