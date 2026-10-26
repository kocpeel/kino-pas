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
| Rate limiting | `resilience/limit-zapytan.ts`, binding Workers Rate Limiting (sito), Durable Object `LimiterZadan` (ścisły) | Osobno IP i e-mail (oba jako skrót SHA-256). Docelowo na IP dwie reguły: 10 prób/min i 12 rezerwacji w czasie TTL, na e-mail 5 prób/min. W trybie oceny etapu tylko 50 prób / 10 s na IP (sekcja 12). Awaria albo brak odpowiedzi limitera w 1 s = przepuszczamy (fail-open). |
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

**Mapa sali: push (kanał na żywo).** Odstępstwo od planu, który wykluczał długie połączenia w Etapie I: na prośbę
wprowadziliśmy prawdziwy push. Jeden Durable Object `SalaSeansu` na seans (`src/lib/push/sala-seansu.ts`) trzyma połączenia
WebSocket wszystkich oglądających mapę tej sali:

1. Przeglądarka łączy się z `/api/events/:id/live`. Trasę obsługuje `worker.ts` (własny Worker opakowujący OpenNext), bo route
   handlery Next.js nie umieją zwrócić odpowiedzi 101. Sprawdza Origin, poprawność id i istnienie seansu.
2. Po połączeniu obiekt od razu wysyła stan sali: ten sam JSON i ETag co `GET /api/events/:id`.
3. Po udanej rezerwacji API woła `zmiana()` na obiekcie (RPC, w tle przez `waitUntil`, bez wpływu na odpowiedź). Obiekt czyta
   stan z D1 (jedyne źródło prawdy) i rozsyła go wszystkim. Seria zmian to jeden odczyt w toku plus najwyżej jeden kolejny.
4. Wygaśnięcie nie jest zdarzeniem (wygasanie leniwe), więc obiekt nastawia alarm na najbliższe `expiresAt` z bazy
   i wtedy rozsyła nowy stan. Bez oglądających nie czyta bazy i nie trzyma alarmu.
5. Hibernacja: bezczynny obiekt jest usypiany, a Cloudflare trzyma połączenia. „ping" co 40 s (podtrzymanie przez
   pośredników) dostaje automatyczne „pong" bez budzenia obiektu.

Zakup nie zmienia zbioru zajętych foteli (rezerwacja → zakup), więc nie powiadamia sali. Awaria kanału nie psuje rezerwacji.
Formularz rezerwacji słucha tego samego kanału: gdy ktoś inny zarezerwuje „jego" fotel, od razu pokazuje
„Ten fotel właśnie zajął ktoś inny", blokuje wysyłkę i daje „Wróć do mapy", a po zwolnieniu fotela sam się odblokowuje.
Własna rezerwacja nie jest brana za cudzą: serwer potrafi rozesłać zmianę przed odpowiedzią na nasze żądanie,
a po timeoucie nie wiadomo, czy zapis się udał, więc w obu przypadkach formularz tego nie ogłasza.

**Zabezpieczenia kanału** (domknięte po przeglądzie wydajności):

| Problem | Rozwiązanie |
|---|---|
| Zgubione powiadomienie = mapa nieaktualna aż do następnej zmiany (np. zapis udany, ale odpowiedź po timeoucie: 503 bez powiadomienia, a powtórka też nie powiadamiała). | Serwer powiadamia salę także przy powtórce i przy błędzie zapisu (`NIEDOSTEPNE`); sala porównuje ETag i nie wysyła niczego, gdy stan się nie zmienił. Klient przy działającym kanale co 60 s robi kontrolne `GET` z ETagiem najnowszego stanu (zwykle 304); odpowiedź na zapytanie wysłane przed nowszą wiadomością z kanału jej nie nadpisze. |
| Kanał nie pauzował na ukrytej karcie (plan: odświeżanie „wstrzymywane, gdy karta jest ukryta"). | Po 60 s w tle kanał jest usypiany (zamknięte połączenie, zero timerów), po powrocie łączy się od nowa i dostaje świeży stan. Krótkie przełączenie karty niczego nie zrywa. Połączenie, które nie otworzy się w 10 s, liczy się jako nieudane (włącza zapasowe odpytywanie zamiast wisieć). |
| Nowe połączenia bez limitu i load sheddingu; każde to 2 odczyty D1. | Ścisły limit **równoczesnych** połączeń z jednego IP w samej sali (znaczniki połączeń, `MAX_POLACZEN_Z_IP = 10`, 429 + Retry-After) plus zgrubny binding `RL_KANAL_IP` na nowe połączenia. Load shedding: nowe połączenia mają najniższy priorytet (`kanal`, odpadają od połowy puli odczytów). Sala czyta stan i najbliższe wygaśnięcie jednym zapytaniem zbiorczym, a nowe połączenia w ciągu 1 s dostają stan z pamięci (fala ponownych połączeń = jeden odczyt). |

Uwaga o bindingu Rate Limiting: Cloudflare liczy w nim w przybliżeniu (lokalny licznik w każdej instancji, synchronizacja
w tle; dokumentacja: *„Requests can exceed your configured limit"*, a do ścisłych limitów zaleca Durable Objects).
Na produkcji 120 połączeń z jednego IP w ciągu ok. 2 minut przeszło mimo limitu 60/min, dlatego ścisły limit połączeń jest w sali.
To samo dotyczyło limitu rezerwacji na IP/e-mail (zmierzone: 14 rezerwacji z jednego IP mimo limitu 10/min), dlatego
ścisły limit rezerwacji też liczy Durable Object (`LimiterZadan`, sekcja 11).

**Push w `npm run dev`.** `next dev` działa w Node.js i nie uruchamia `worker.ts`: nie zna trasy WebSocket, a emulacja
bindingów nie odpala klasy Durable Objectu zdefiniowanej w tym samym Workerze. Dlatego `npm run dev` (`scripts/dev.mjs`)
uruchamia obok `next dev` mały Worker deweloperski `workers/sala-dev` w workerd: ta sama klasa `SalaSeansu`, ta sama lokalna
baza D1 (to samo `database_id` + `--persist-to .wrangler/state`). Next.js dostaje jego adres w `SALA_DEV_URL`:
mapa łączy się WebSocketem bezpośrednio z nim (`DOZWOLONE_ZRODLA` wpuszcza stronę z innego portu), a API rezerwacji
powiadamia go przez lokalny `POST /__dev/zmiana/:id` zamiast RPC. Wybór trybu jest w jednym miejscu: `src/lib/push/tryb-dev.ts`.
Samo `npm run dev:next` (bez Workera sali) działa dalej, tylko bez kanału, na odpytywaniu. Produkcja się nie zmienia.
Push sprawdzają: testy integracyjne Durable Objectu w workerd, `npm run test:e2e` (na `npm run dev`) i `npm run test:e2e:push`
(na buildzie w `opennextjs-cloudflare preview`).

**Mapa sali: zapasowe odpytywanie.** Gdy kanał nie działa (np. sieć blokuje WebSockety), klient ponawia połączenie z backoffem,
a w tym czasie odpytuje `GET /api/events/:id`, tanio:

| Co | Efekt |
|---|---|
| Interwał adaptacyjny: 5 s, a gdy nic się nie zmienia ×1,5 aż do 30 s; powrót do 5 s po zmianie, po powrocie na kartę i przy interakcji z mapą | Spokojna sala: ok. 12 zapytań w 5 min zamiast 60. |
| `ETag` + `If-None-Match` → 304 bez treści | Sprawdzenie bez zmian to kilkadziesiąt bajtów zamiast pełnej odpowiedzi. |
| Indeks `(eventId, status, expiresAt)` i warunek `status IN (...)` | D1 czyta tylko zajęte wiersze seansu, a nie 80 foteli przy każdym zapytaniu (zapytanie jest pokrywane indeksem). |
| Cache szczegółów w izolacie 1 s | Tłum oglądających w jednym izolacie = jedno zapytanie do D1 na sekundę. |
| Pauza na ukrytej karcie, zatrzymanie po 4 porażkach | Zero zapytań z kart w tle. |

Poprawność od tego nie zależy: nieaktualna mapa najwyżej pokaże wolny fotel, który jest już zajęty, a zapis i tak
odpowie 409.

## 8. Dane między ekranami

Kontrakt nie ma GET rezerwacji, więc `eventId`, `seatId` i `reservationId` są w adresie, a `expiresAt`, imię,
e-mail i kod w `sessionStorage` (z `try/catch`). Dane osobowe nigdy nie trafiają do URL. Bilet otwarty w nowej
karcie tej samej przeglądarki odtwarza kod idempotentnym POST zakupu.
Uwaga: dla jeszcze nieopłaconej, ważnej rezerwacji wejście na `/bilet/:id` ją kupi, bo tak działa
zakup bez płatności w Etapie I; do strony biletu prowadzi tylko udany zakup.

## 9. Testy: co dowodzą, a czego nie

Lokalny D1 serializuje zapisy, więc testy W1–W6 dowodzą poprawności **warunków w zapytaniach**, a nie zachowania
pod prawdziwym opóźnieniem sieci. Do tego jest test obciążeniowy na osobnym środowisku w Cloudflare
(`tests/obciazenie/obciazenie.mjs`, Worker `kasa-kino-staging` z bazą `kasa-kino-db-staging`, limity na IP/e-mail
wyłączone, load shedding jak na produkcji). Klienci zachowują się jak przeglądarka: własny `Idempotency-Key`,
ponowienie po 503 z tym samym kluczem. Wynik z 25.10.2026, dwa przebiegi na świeżych danych, oba 12/12:

| Scenariusz | Wynik | Czasy (p50 / p95) |
|---|---|---|
| W1: 50 osób naraz o jeden fotel | dokładnie 1 × 201, 49 × 409, zero 5xx, mapa pokazuje fotel zajęty | 268–582 / 689–704 ms |
| W2: 80 osób naraz o 80 różnych foteli | 80 × 201, sala pełna, repertuar po 6 s: 0 wolnych | 298–381 / 589–597 ms |
| W3: 20 równoległych zakupów jednej rezerwacji | 1 × 201, 19 × 200 z tym samym kodem; bez ciasteczka 403 bez kodu | 199–204 / 417–615 ms |
| R: 600 odczytów listy i mapy, 100 naraz | 600 × 200 | 101–136 / 514–593 ms |

Ograniczenie: wszystkie żądania szły z jednej maszyny (jedna lokalizacja Cloudflare). Load shedding się nie włączył
(zero 503), więc przy tym ruchu nie był potrzebny. Wersja k6 (`tests/obciazenie/w1-ten-sam-fotel.js`) zostaje do
uruchomienia z kilku maszyn.

## 10. Środowisko i narzędzia

- Next.js 16 + `@opennextjs/cloudflare` 1.20, Wrangler 4, D1, Rate Limiting binding.
- `@cloudflare/vitest-pool-workers` zostało przemianowane na `@cloudflare/vitest-plugin` (API `cloudflareTest()`).
- Bez `.npmrc`. Wcześniej było tam `legacy-peer-deps=true`, bo npm 10 wywracał się na drzewie peer-dependencies
  Vitest 4 (`Cannot read properties of null (reading 'edgesOut')`). Na npm 10.9.8 `npm ci`, `npm install` oraz
  dodanie i usunięcie paczki działają bez tej flagi (sprawdzone na czystej kopii), więc obejście usunięto.

## 11. Domknięte luki (przegląd z 25.10.2026)

| Luka | Rozwiązanie | Gdzie | Testy |
|---|---|---|---|
| Bot z wieloma e-mailami mógł zająć całą salę: limit na IP stał na przybliżonym bindingu (zmierzone: 14 rezerwacji z jednego IP mimo 10/min). | Ścisły limiter na Durable Object `LimiterZadan`: jeden obiekt na skrót IP albo e-maila, okno przesuwne, sprawdzenie i zapis bez przerwy na `await` (atomowe). Na IP dwie reguły: 10 prób/min i **12 rezerwacji w czasie TTL**, więc jeden adres nie trzyma naraz więcej niż 12 foteli. Na e-mail 5 prób/min (plus dotychczasowe 4 aktywne rezerwacje w SQL). Binding zostaje jako tanie pierwsze sito, Retry-After mówi, kiedy zwolni się miejsce w oknie. Odrzucona próba się nie liczy, alarm kasuje dane obiektu po upływie okna. | `resilience/limiter-zadan.ts`, `resilience/limit-zapytan.ts` (`ocenProbe`), vars `RESERVATION_ATTEMPTS_PER_IP`, `RESERVATION_ATTEMPTS_PER_EMAIL`, `RESERVATIONS_PER_IP_PER_TTL` | 20 równoległych prób z jednego IP → dokładnie 3 (limit testowy); reguła TTL; okno przesuwne (jednostkowe) |
| (Wycofane 26.10.2026, sekcja 12.) `reservationId` w adresie działał jak hasło: kto miał link, mógł kupić cudzą rezerwację albo zobaczyć kod biletu. | Rezerwacja ustawia ciasteczko `kasa_rez` (32 losowe bajty, `HttpOnly; Secure; SameSite=Strict; Path=/api/reservations/:id`). Baza trzyma tylko skrót SHA-256 (`seats.secretHash`, migracja 0003). Zakup i powtórka zakupu wymagają pasującego ciasteczka (inaczej 403, bez kodu). Powtórka rezerwacji z tym samym kluczem wydaje nowy sekret. Wygasła rezerwacja dalej daje 410 (nie zdradzamy więcej). Wiersze sprzed migracji (`secretHash IS NULL`) działają jak dawniej. | `http/ciasteczka.ts`, `domain/rezerwacja.ts`, `db/zapytania-miejsca.ts`, UI: `AkcjeBiletu`, `Licznik` | integracyjne (403, rotacja sekretu, sprzątanie), komponent 403, e2e: nowa karta tej samej przeglądarki widzi kod, inna przeglądarka nie |
| Brak retencji danych osobowych. | Worker sprzątający ma drugi Cron (`17 3 * * *`): kupione bilety tracą imię, e-mail, skrót sekretu i klucz idempotencji `DATA_RETENTION_DAYS` dni po seansie (domyślnie 30). Status i kod biletu zostają (nie są danymi osobowymi), więc sala się nie zmienia. Zła wartość zmiennej nie skasuje danych wcześniej (wraca do 30). | `workers/sprzatanie/src/index.ts`, `anonimizujPoSeansach` | integracyjne (granica 30 dni, inne seanse, zła wartość, wybór crona) |
| Brak CI. | GitHub Actions: typy, statyczny test wycieków, jednostkowe, integracyjne (workerd + D1), komponenty, potem e2e (Playwright + Chromium na `npm run dev`). Bez sekretów Cloudflare. | `.github/workflows/testy.yml` | zielone na GitHubie (ok. 2,5 min). Pierwsze przebiegi wykryły, że na Linuksie Playwright zabijał serwer e2e SIGKILL-em, a `next dev` i Worker sali przeżywały i blokowały zamknięcie: teraz `gracefulShutdown: SIGTERM`, a `scripts/dev.mjs` czeka na puste grupy procesów. Job e2e przypięty do `ubuntu-24.04`, porażka trafia do publicznych adnotacji. |
| Brak Content-Security-Policy. | Nonce na każde żądanie strony w `worker.ts` (Next.js 16 czyta go z nagłówka CSP żądania i dokleja do swoich skryptów): `script-src 'self' 'nonce-…' 'strict-dynamic'`, `object-src 'none'`, `frame-ancestors 'none'`, `connect-src` z `wss:` kanału na żywo. Node'owy `proxy.ts` odpadł, bo OpenNext oznacza go jako eksperymentalny. `/_not-found` renderowane na żądanie (`connection()`), żeby też dostało nonce. W `next dev` łagodniejsza polityka bez nonce'a (React dev potrzebuje `eval`). Do tego HSTS, `Cross-Origin-Opener-Policy`, `Permissions-Policy`. | `http/csp.ts`, `worker.ts`, `next.config.ts` | jednostkowe; e2e na buildzie: nonce na każdym skrypcie, nowy przy każdym żądaniu, zero naruszeń na repertuarze, mapie z WebSocketem, formularzu i 404 |
| „Nie znaleziono" zwracało HTTP 200 (streaming przez `loading.tsx` zaczynał się przed `notFound()`). | Sprawdzenie istnienia seansu, fotela i formatu identyfikatora w `layout.tsx` każdej trasy (layout renderuje się przed granicą `loading`). Mapa przeniesiona do grupy `(mapa)`, żeby jej `loading.tsx` nie obejmował layoutu fotela. | `src/app/**/layout.tsx` | curl na dev i e2e na buildzie: 404 |
| Load shedding liczony per izolat. | Strażnik dodatkowo patrzy na sygnał wspólny dla wszystkich izolatów: średnią wykładniczą opóźnienia D1. Powyżej celu (`LOAD_SHED_DB_LATENCY_TARGET_MS`, 800 ms) pule maleją proporcjonalnie (do 25%), zakupy zawsze mają pełną pulę. Awaria i timeout liczą się jak pełny timeout. Po 10 s bez pomiarów średnia przestaje ograniczać. | `resilience/przeciazenie.ts`, `http/obsluga-trasy.ts` | jednostkowe |
| Brak alertów. | `GET /api/zdrowie` (`SELECT 1` w puli listy, `degraded`, gdy działa load shedding). Worker sprzątający co minutę woła je przez service binding. Problem: jedna linia JSON z polem `alert` w Workers Logs, a z sekretem `ALERT_WEBHOOK_URL` także webhook (Slack/Discord). Alert po 2 nieudanych kontrolach, przypomnienie co 30 min, jedna wiadomość po naprawie (stan w `alert_state`, migracja 0004). | `workers/sprzatanie/src/zdrowie.ts` | integracyjne (cała sekwencja, bez webhooka, baza stanu niedostępna, awaria webhooka) |
| `.npmrc` z `legacy-peer-deps`. | Usunięte (sekcja 10). | | czysta instalacja |
| Test obciążeniowy nie był uruchomiony w Cloudflare. | Środowisko `staging` i test w Node (bez k6), sekcja 9. Przy okazji naprawiony `scripts/cloudflare.mjs`: gubił cudzysłowy argumentów ze spacjami (`--command "…; …"` rozpadało się na kilka poleceń powłoki). | `tests/obciazenie/obciazenie.mjs`, `wrangler.jsonc` (`env.staging`) | 12/12 niezmienników, dwa przebiegi |

## 12. Zgodność z kryteriami etapu I (26.10.2026)

Ocena według „Kryteria etapu I” wykazała ryzyka, które mogły wyzerować test chaosu mimo poprawnej logiki.

| Ryzyko | Zmiana | Gdzie | Testy |
|---|---|---|---|
| Zakup wymagał ciasteczka `kasa_rez`, którego nie ma we wspólnym kontrakcie. Klient bez pamięci ciasteczek (`fetch`, `curl`) dostawał 403, więc nie działał „zakup z kodem” z warunku wstępnego. Powtórka rezerwacji unieważniała ciasteczko z pierwszej odpowiedzi. | Sekret rezerwacji wycofany: zakup i jego powtórka działają z samym `reservationId` (UUID v4). Kolumna `secretHash` zostaje (migracja 0003), ale nowe rezerwacje zapisują w niej NULL. Kompromis: kto zna `reservationId`, może kupić bilet i zobaczyć kod. | `domain/rezerwacja.ts`, `db/zapytania-miejsca.ts`, `http/trasy.ts`, UI `Licznik`, `AkcjeBiletu` | kontrakt (zakup bez ciasteczek, brak `Set-Cookie`), e2e |
| B1: identyczny POST bez `Idempotency-Key` dostawał 409 (0,5 pkt zamiast 1). | Gdy fotel trzyma ważna rezerwacja z tym samym imieniem i e-mailem, identyczne żądanie dostaje tę samą rezerwację (`Idempotent-Replayed: true`). | `domain/rezerwacja.ts` (`zarezerwuj`) | integracyjne: po kolei, 10 równolegle, inne imię/e-mail → 409, po zakupie → 409 |
| Prowadzący testuje z jednej maszyny i często jednym e-mailem: limity (10 prób/min i 12 w TTL na IP, 5 prób/min i 4 aktywne na e-mail) mogły dać 429 w B4/C1/C2/C4. | Tryb oceny: tylko limit zalewu z jednego IP, 50 prób / 10 s (binding + ścisły obiekt), limity na e-mail wyłączone. B5 nadal daje 429 z Retry-After ≤ 10 s, a adres odzyskuje dostęp w ciągu 10 s. Wartości docelowe są w komentarzach `wrangler.jsonc`. | `wrangler.jsonc` | atak B5 (niżej) |
| Przy krótkim oknie alarm `LimiterZadan` (`deleteAll` przerwany nowym `setAlarm`) kończył się błędem wewnętrznym, a wywołanie limitera nie miało timeoutu: jedno żądanie rezerwacji wisiało 5 min. | Alarm kasuje tylko swoje klucze i tylko po ciszy (inaczej przestawia się na nowy termin); limiter ma 1 s na odpowiedź, potem fail-open. | `resilience/limiter-zadan.ts`, `resilience/limit-zapytan.ts` | jednostkowy (zawieszony limiter), atak B5 bez zawieszeń |

Pomiar na lokalnym buildzie (workerd, TTL 120 s), najgorszy scenariusz: wszystkie żądania z jednego IP, jeden e-mail,
bez ciasteczek. Wynik 11/11: A1 404; A2 fotel znika 43 ms po `expiresAt`; B1 ta sama rezerwacja z kluczem i bez,
po kolei i równolegle; B2 1 × 201 + 19 × 409; B3 400/404 i nic nie zapisane; B4 nowa rezerwacja 96 ms po `expiresAt`;
B5 23 × 201 + 77 × 429 (Retry-After 6–10 s), drugi klient 201; C1 ten sam kod; C2 5/5 jeden właściciel; C3 410 i 400;
C4 410, kupione miejsce dalej zajęte.
