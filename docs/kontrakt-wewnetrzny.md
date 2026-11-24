# Kontrakt wewnętrzny etapów II i III

Ustalenia między kartami A, B i C: adresy stron powrotu, sposób zapisu płatności, outbox i inbox.
Kontrakt zewnętrzny jest w [kontrakt-api.md](kontrakt-api.md), a zagrożenia w [zagrozenia.md](zagrozenia.md).

## Cała droga

Stripe to cudzy system: jego skutków nie obejmie nasza transakcja ani nie cofnie rollback (dual write z E07).
Dlatego każde przejście między systemami ma swojego strażnika.

| Krok | Gdzie | Kto pilnuje |
|---|---|---|
| 1. Rezerwacja + wpis do historii + kwota | D1 | warunkowy `UPDATE` i jeden `batch` |
| 2. Sesja płatności | Stripe | 🔑 klucz idempotencji `checkout:<reservationId>:<points>` |
| 3. Strażnik sesji zapisany razem z sesją | D1 | 📤 outbox (jeden `batch`) |
| 4. Webhook o płatności | Stripe → `POST /api/webhooks/stripe` | ✍️ podpis, 📨 Stripe ponawia (≥1) |
| 5. Bilet z kodem albo zaplanowany zwrot | D1 | 📥 inbox + warunkowy `UPDATE` (jeden `batch`) |
| 6. Zwrot, wygaszenie sesji, odczyt zgubionej płatności | Stripe | 📤 outbox, Cron co minutę, 🔑 klucz z joba |
| 7. Powiadomienie sali, alert na webhook | Durable Object, Slack/Discord | ⚖️ świadomy wybór (niżej) |

## Strony powrotu

| Parametr sesji | Adres | Karta C |
|---|---|---|
| `success_url` | `/bilet/:reservationId?seans=…&miejsce=…&session_id={CHECKOUT_SESSION_ID}` | „Płatność w toku…”, która sama zamienia się w bilet. Czyta tylko `GET /api/reservations/:id`, co 1,5–5 s. |
| `cancel_url` | `/rezerwacja/:reservationId?seans=…&miejsce=…&platnosc=przerwana` | Licznik, komunikat „Płatność przerwana” i przycisk „Zapłać”, dopóki rezerwacja jest ważna. |

Adres bazowy to adres żądania `POST /checkout`. `session_id` nie jest przepustką: mówi stronie tylko, że klient wraca z płatności.

## Zapis płatności

- **`seats`** odpowiada na pytanie „kto ma ten fotel”. Tu są warunkowe zapisy, czyli jeden właściciel. Bilet to
  `status = 'purchased'` z `code`, jak w etapie I.
- **`reservations`** to trwała historia, bo po wygaśnięciu wiersz w `seats` dostaje nowe `reservationId`.
  Tu jest `amount` (cena z chwili rezerwacji, nigdy się nie zmienia), `expiresAt`, sesja Stripe'a, `paymentIntentId`
  płatności, która dała bilet, `paidAt` i `refundStatus` (`pending`, `done`, `failed`). Bez danych osobowych.
- **Status w API** wynika z obu: fotel `purchased` tej rezerwacji = `paid`; `reserved` i `expiresAt > teraz` = `held`;
  każdy inny stan = `expired`.
- **`events.price`** to cena w groszach. Trafia do rezerwacji w tym samym zapisie, który zajmuje fotel.

Bilet powstaje wyłącznie przez `rozliczPlatnosc` (`domain/platnosc.ts`), na dwóch drogach: webhook i strażnik sesji.
Warunki biletu: płatność przyjęta **przed** `expiresAt`, zgodna kwota i waluta, a fotel należy do tej rezerwacji albo
nie ma żywego właściciela. W każdym innym przypadku płatność trafia do zwrotu. Chwila płatności to `event.created`,
więc spóźniony webhook nie zabiera klientowi biletu.

## Sesja Checkout

| Parametr | Wartość | Dlaczego |
|---|---|---|
| Klucz idempotencji | `checkout:<reservationId>:<points>` | Podwójne kliknięcie, retry i padnięcie między Stripe'em a zapisem dają tę samą sesję. Liczba punktów jest w kluczu, bo od niej zależy kwota. |
| `client_reference_id` | `reservationId` | Tak webhook wie, której rezerwacji dotyczy płatność. |
| `line_items` | `pln`, `unit_amount` = `amount` z rezerwacji − `pointsUsed` | Nigdy cena z formularza ani bieżąca cena wydarzenia. |
| `expires_at` | `expiresAt` rezerwacji + 31 min | Stripe wymaga co najmniej 30 min. Liczone od rezerwacji, nie od „teraz”, bo ten sam klucz z innymi parametrami to błąd. |
| `excluded_payment_method_types` | `blik`, `klarna`, `p24` | Od API 2026-10 metody ustawia panel, a `payment_method_types` nie jest przyjmowane. Etap II to płatność kartą. |
| `custom_text.submit` | godzina końca rezerwacji | Sesja żyje dłużej niż rezerwacja, więc klient musi to widzieć na stronie płatności. |

Nie wysyłamy `customer_email`: Stripe sam go zbiera, a my nie przekazujemy więcej danych, niż potrzeba.

## 📤 Outbox

Tabela `outbox`, te same pola co jobs z E06: `id`, `task`, `input`, `visibleAt`, `totalTried`, `completedAt`, `hasError`
(plus `lastError`). Zapis razem z naszymi danymi, wysyłka w `domain/outbox.ts`: claim → wywołanie → ack. Gwarancja:
co najmniej raz.

Kto wykonuje joby (od etapu III/IV; ten sam claim, więc job nie wykona się dwa razy):

| Kto | Kiedy |
|---|---|
| 🔔 Budzik outboxu (Durable Object `BudzikOutboxu`, binding `BUDZIK`) | W terminie co do sekundy: alarm nastawiony na `visibleAt` najbliższego joba. Budzi go każde miejsce, które dopisuje albo przesuwa job. |
| Żądanie, które wywołało zdarzenie | Od razu w tle (`ruszOutbox`): webhook płatności → naliczenie punktów i mail; bez budzika (`next dev`, e2e) to jedyna droga poza odczytami. |
| Odczyt klienta | Leniwie, przed odpowiedzią (`dokonczTeraz`): `GET /api/loyalty` kończy zaległe operacje na punktach tego klienta, odczyty listy oczekujących przesuwają kolejkę. |
| ⏰ Cron co minutę | Siatka bezpieczeństwa: wszystko, czego nikt inny nie zrobił. |

| `task` | `id` (i klucz idempotencji) | `input` | Co robi |
|---|---|---|---|
| `stripe-refund` | `stripe-refund:<paymentIntentId>` | `paymentIntentId`, `reservationId` | Zwrot płatności, która nie dała biletu. Zapisywany w tej samej transakcji co zdarzenie w inboxie. |
| `lista-kolejka` | `lista-kolejka:<eventId>` | `eventId`, `ttlMs` | Etap IV, karta B: przesuwa kolejkę listy oczekujących (oferty dla czekających, `missed` po końcu oferty). Termin: najbliższe wygaśnięcie rezerwacji na sali, gdy ktoś czeka; po odbitym mailu albo wypisaniu od razu. Gdy ktoś nadal czeka, odkłada się na następne wygaśnięcie. |
| `mail-oferta` | `mail-oferta:<reservationId>` (klucz Resend `oferta/<reservationId>`) | `waitlistId`, `reservationId`, `ttlMs` | Etap IV, karta C: mail z ofertą (wydarzenie, miejsce, link do zapłaty, godzina końca). Zapisywany w transakcji z ofertą. Trwała odmowa Resend = oferta odpada (`missed`) i kolejka rusza od razu. |
| `stripe-session-watch` | `stripe-session-watch:<reservationId>` | `reservationId`, `sessionId` | Strażnik sesji. Co minutę, dopóki rezerwacja żyje: sesja opłacona, a webhook nie dotarł → rozlicza. Rezerwacja wygasła, a sesja otwarta → wygasza sesję. Rezerwacja opłacona → koniec, bez pytania Stripe'a. |

Awaria: backoff 1, 2, 4… min, najwyżej godzina. Po 8 próbach (około 3 godziny) job idzie do DLQ (`hasError = 1`),
zwrot dostaje `refundStatus = 'failed'`, a Cron wysyła alert. Ponowienie po naprawie przyczyny:

```sql
UPDATE outbox SET hasError = 0, totalTried = 0, visibleAt = 0 WHERE id = '<id>';
UPDATE reservations SET refundStatus = 'pending' WHERE id = '<reservationId>';
```

Klucz idempotencji Stripe pamięta co najmniej 24 h, a ponawianie trwa krócej, więc zwrot po awarii nie powtórzy się.

## 📥 Inbox

Tabela `inbox` (`id` = ID zdarzenia `evt_…`, `processedAt`). ID zdarzenia, bilet i ewentualny zwrot to jeden `batch`,
czyli jedna transakcja. Drugie dostarczenie odbija się od klucza głównego, transakcja się wycofuje, a my odpowiadamy
200, bo inaczej Stripe ponawiałby przez kolejne dni. Błąd zapisu to 5xx: wtedy chcemy ponowienia. Sprzątanie raz na
dobę, po 7 dniach (Stripe ponawia do 3 dni, a D1 nie ma indeksów TTL).

## ⚖️ Świadomy wybór, gdy nie ma klucza idempotencji

| Cudzy system | Wybór | Dlaczego |
|---|---|---|
| Alert na webhook (Slack, Discord) | ≥1 | Drugi alert to mniejsze zło niż brak alertu. |
| Powiadomienie sali (Durable Object) | ≤1 | Zgubione nic nie psuje: mapa co 60 s robi kontrolny `GET`, a ostatnie słowo ma warunkowy zapis. |
| Mail z biletem (od etapu III) | ≥1 | Outbox ponawia, a `Idempotency-Key: bilet/<id>` (Resend pamięta go 24 h) zatrzymuje drugi mail. Gdyby jednak doszedł, drugi mail jest tańszy niż brak biletu. |

## Sekrety

| Zmienna | Gdzie | Uwagi |
|---|---|---|
| `STRIPE_SECRET_KEY` | sekret głównego Workera i Workera z Cronem, lokalnie `.dev.vars` | Tylko `sk_test_` albo `rk_test_`. Klucz produkcyjny wyłącza płatności. |
| `STRIPE_WEBHOOK_SECRET` | sekret głównego Workera, lokalnie `.dev.vars` | Z endpointu w panelu Stripe albo z `stripe listen`. |
| `ALERT_WEBHOOK_URL` | sekret Workera z Cronem, opcjonalny | Bez niego alerty są tylko w Workers Logs. |
| `VOUCHERIFY_*` | sekrety głównego Workera i Workera z Cronem, lokalnie `.dev.vars` | Projekt Sandbox; kampania z `npm run voucherify:kampania`. |
| `RESEND_API_KEY` | sekret głównego Workera (od etapu IV: mail z ofertą wychodzi od razu) i Workera z Cronem | Klucz z prawem do wysyłki wystarczy. |
| `RESEND_WEBHOOK_SECRET` | sekret głównego Workera | Z webhooka w panelu Resend (`whsec_…`). |

Jedno konto Stripe mogą dzielić środowiska (produkcja, staging, lokalnie) i każdy endpoint dostaje wszystkie zdarzenia.
Dlatego zdarzenie z nieznaną rezerwacją kończy się 200 bez skutku, a przede wszystkim bez zwrotu.

## Etap III: saga zakupu z punktami (E08)

Zakup przechodzi teraz przez trzy cudze systemy: Voucherify (punkty), Stripe (karta) i Resend (mail). Rollback
żadnego z nich nie cofnie, więc zakup jest sagą z orkiestracją: kolejność jest w kodzie (`domain/platnosc.ts`
i `domain/outbox.ts`), każdy krok ma kompensację, a postęp jest w tabeli `sagas` (notatka w naszej bazie).

| Krok | System | Akcja | Kompensacja | Kto pilnuje |
|---|---|---|---|---|
| 1. `punkty` | Voucherify | punkty schodzą z karty (`source_id` `wydanie:<id>`) | punkty wracają (`zwrot:<id>`) | 🔒 blokada konta, notatka „niepewne” przed wywołaniem, historia karty |
| 2. `platnosc` | Stripe | sesja na `amount − points`, klient płaci | zwrot na kartę, wygaszenie sesji | 🔑 klucz idempotencji, strażnik sesji |
| 3. `bilet` | D1 | bilet z kodem, `pointsEarned` i joby kroków 4–5 w jednym `batch` | brak: punkt bez odwrotu | 📥 inbox + warunkowy `UPDATE` |
| 4. `naliczenie` | Voucherify | punkty za zakup (`naliczenie:<id>`) | brak: krok tylko do przodu | 📤 outbox, historia karty przed powtórką |
| 5. `mail` | Resend | mail z biletem i podsumowaniem | brak: maila nie da się odwołać, więc jest ostatni | 📤 outbox, 🔑 `Idempotency-Key: bilet/<id>`, ⚖️ świadome ≥1 |

Kompensacja zaczyna się, gdy biletu nie będzie: rezerwacja wygasła bez płatności (strażnik wygasza sesję albo sesja nie
powstała) albo płatność nie dała biletu (po czasie, zła kwota, fotel zajęty). Wtedy saga ma status `compensating`,
w outboksie czekają zwrot na kartę (`stripe-refund`) i oddanie punktów (`punkty-zwrot`), a po obu jest `compensated`.
`failedStep` to `platnosc`, gdy sesja płatności nie powstała, i `bilet`, gdy sesja była, ale płatność nie przyszła na czas
albo nie dała biletu (po czasie, zła kwota, fotel zajęty).
Bez kompensacji saga kończy się `completed` po krokach 4 i 5.

### Gdzie zapisujemy punkty

- **`reservations.pointsUsed`**: ustawiane dopiero, gdy Voucherify potwierdził zdjęcie punktów, razem z krokiem sagi
  i strażnikiem sesji (jeden `batch`). Sesja Stripe'a powstaje tylko po potwierdzonym wydaniu, więc każda płatność ma
  pewne `pointsUsed`. Kartą płaci się `amount − pointsUsed`, i taką kwotę sprawdza rozliczenie płatności.
- **`reservations.pointsEarned`**: punkty za zakup, zapisywane w transakcji z biletem: `floor((amount − pointsUsed) / 100) × 10`.
- **`reservations.pointsStatus`**, **`emailStatus`**, **`emailId`**: stan kroków po bilecie (albo oddania punktów);
  to czyta strona biletu i `GET /api/reservations/:id`.
- **`loyalty_accounts`**: e-mail → karta (`memberId`), `cardRequestedAt` (notatka przed założeniem karty: kartę z nią
  założył nasz sklep, więc należą się jej punkty powitalne; karta bez niej przyszła z aplikacji albo kas), `welcomeAt`
  (punkty powitalne raz), ostatnie saldo z Voucherify (`balance`, `balanceAt`) i `lockedUntil`. Prawdą o saldzie
  zostaje Voucherify.
- **`sagas`**: `completed` (udane kroki, od końca tej listy idą kompensacje), `results` (e-mail, karta, liczba punktów,
  adres sklepu, notatki „niepewne”), `status`, `failedStep`.

### Voucherify bez kluczy idempotencji

Każda zmiana salda niesie nasz `source_id`: `powitanie:<email>`, `wydanie:<id>` (kolejna próba tej rezerwacji, tylko po
obciętym wydaniu: `wydanie:<id>:<n>`), `korekta:<source_id próby>`, `naliczenie:<id>`, `zwrot:<id>`.
Przed wywołaniem zapisujemy w sadze notatkę „niepewne”, a po odpowiedzi ją kasujemy. Gdy odpowiedź nie dotrze
(timeout, 5xx), notatka zostaje: następna próba najpierw sprawdza historię karty i nie powtarza operacji, która
już się wykonała. Wszystkie operacje na punktach jednego klienta idą pod blokadą konta (`lockedUntil`, 30 s),
więc sprawdzenie salda i jego zmiana nie mają wyścigu, także między dwiema rezerwacjami tego klienta.

Voucherify nie odmawia odjęcia większego niż saldo: zdejmuje tyle, ile jest, i mówi to w `points` odpowiedzi
(sprawdzone na sandboksie). Dlatego liczy się faktyczna zmiana, a nie prośba: gdy zeszło mniej, niż klient chciał
wydać (saldo w pamięci było starsze niż wydatek w kasie), od razu oddajemy to, co zeszło (`korekta:…`), i checkout
odpowiada 422 z aktualnym saldem. Kompensacje (strażnik, oddanie punktów) liczą z historii karty wydanie minus
korektę, więc oddają dokładnie to, co zostało zdjęte.

### Budżet wywołań

Sandbox Voucherify przyjmuje 100 wywołań na godzinę. Liczymy je sami w Durable Objekcie `LimiterZadan`, wspólnie dla
Workera aplikacji i Workera z Cronem: 90 na godzinę, z czego odczyty salda najwyżej 40 (staging, który dzieli ten sam
sandbox, ma 10 i 5, żeby nie zabrać produkcji jej części). Odmowa budżetu nie wywołuje
Voucherify: checkout z punktami odpowiada 503 `points_unavailable`, odczyt salda podaje ostatnie znane (nieznany e-mail:
powitalne 1000) z `X-Data-Stale`, a job czeka do zwolnienia miejsca bez liczenia porażki.

| Operacja | Wywołania Voucherify |
|---|---|
| `GET /api/loyalty`, e-mail, którego nie znamy | 1 odczyt (szukanie karty: mogła powstać w aplikacji albo w kasach) |
| `GET /api/loyalty`, znany klient | 0 (pamięć 30 s) albo 1 |
| Pierwszy zakup z punktami (nowy klient) | 3 przy checkoucie (szukanie karty, założenie, powitalne) + 1 wydanie + 1 naliczenie |
| Kolejny zakup z punktami | 1 wydanie (+1 odczyt salda, gdy pamięć jest starsza niż 30 s) + 1 naliczenie |

### Stan pośredni na stronie biletu

Bilet jest od razu, a kroki 4 i 5 ruszają w tym samym żądaniu webhooka (budzik outboxu albo praca w tle), więc trwają
sekundy; Cron jest tylko siatką bezpieczeństwa. Strona mówi wprost, co jeszcze trwa („dopisujemy je do Twojego
konta…”, „Wysyłamy bilet na Twój e-mail…”), i odpytuje dalej, aż oba kroki się skończą (najwyżej 3 minuty).
`GET /api/loyalty` sam dokańcza zaległe naliczenie, więc saldo z punktami za zakup widać od razu po płatności.

## Etap IV: lista oczekujących

Lista oczekujących dokłada do sali kolejkę. Zwolnione miejsce dostaje pierwsza osoba z kolejki jako **zwykłą rezerwację
z etapu I** (`reservations` + fotel `reserved` z `expiresAt` = teraz + TTL), więc płatność, punkty, strażnik sesji,
kompensacje i bilet działają bez zmian, a link w mailu prowadzi do strony płatności tej rezerwacji.

### Gdzie zapisujemy

- **`waitlist`** (migracja 0007): `id` (`waitlistId`), `seq` (kolejność zapisów, z niej pozycja), `eventId`, `email`,
  `customerName`, `status`, a od oferty `reservationId`, `seatId`, `offerExpiresAt` (= `expiresAt` rezerwacji),
  `emailId` i `emailStatus` maila z ofertą oraz `adres` sklepu (link w mailu). Jeden aktywny zapis klienta na
  wydarzenie (indeks unikalny na `waiting`/`offered`), jedna oferta na rezerwację.
- Pozycja nie jest zapisana, tylko liczona: czekający z mniejszym `seq` + 1. Wypisanie przesuwa więc wszystkich od razu.

| Status | Znaczy | Skąd |
|---|---|---|
| `waiting` | czeka w kolejce | zapis |
| `offered` | ma zarezerwowane miejsce do `offerExpiresAt` | karta B: fotel był do wzięcia i osoba nadal czekała (jedna transakcja) |
| `done` | kupił bilet | w transakcji z biletem (`zaksieguj`) albo przy przesunięciu kolejki |
| `missed` | nie zapłacił na czas albo mail do niego nie doszedł | koniec oferty bez biletu, webhook Resend `email.bounced`/`email.failed`, trwała odmowa Resend przy wysyłce |
| `left` | wypisał się | `DELETE /api/waitlist/:id` |

### Jak karta B daje znać karcie C (ktoś dostał miejsce)

Przez outbox, w **tej samej transakcji** co oferta: fotel dla osoby, wpis rezerwacji, status `offered` i job
`mail-oferta:<reservationId>`. Oferta bez maila albo mail bez oferty nie są możliwe. Job rusza od razu (budzik albo
żądanie, które przesunęło kolejkę), a wysłany mail zapisuje `emailId` przy ofercie.

### Jak karta C daje znać karcie B (mail nie doszedł)

Webhook Resend z podpisem Svix: `email.bounced` albo `email.failed` dla `emailId` oferty. W **jednej transakcji** z wpisem
do inboxu (duplikat niczego nie powtarza): oferta → `missed`, fotel i rezerwacja wygasają teraz (chyba że już kupione),
strażnik sesji tej rezerwacji dostaje termin „teraz” (odda wydane punkty) i job `lista-kolejka` dostaje termin „teraz”.
To samo, gdy Resend odmówi wysyłki na stałe (np. adres spoza sandboksa). Kolejkę przesuwa wtedy budzik albo najbliższy
odczyt, więc miejsce dostaje następna osoba w sekundy.

### Kiedy kolejka się przesuwa

Kolejka nie czeka na Crona (na darmowym Vercelu chodziłby raz na dobę, na Cloudflare co minutę):

1. **Leniwie, przy każdym odczycie i rezerwacji na tej sali** (`GET /api/events/:id`, `POST /api/reservations`,
   `POST /api/events/:id/waitlist`, `GET`/`DELETE /api/waitlist/:id`), gdy ktoś czeka. Dzięki temu zwolnione miejsce
   najpierw dostaje kolejka, a dopiero potem przypadkowy klient (pierwszeństwo listy).
2. **Job `lista-kolejka`** z terminem na najbliższe wygaśnięcie rezerwacji na sali, wykonywany przez budzik w tej sekundzie,
   gdy nikt nie czyta.
3. **Cron** co minutę jako siatka bezpieczeństwa.

Przesunięcie jest idempotentne i bezpieczne równolegle: oferta to warunkowy zapis fotela (wolny albo z wygasłą
rezerwacją) z warunkiem, że osoba nadal czeka, więc jedno miejsce nie trafi do dwóch osób, a jedna osoba nie dostanie
dwóch miejsc.

### Wydarzenie testowe

`waitlist-test`: jedna sala 1 × 2 (fotele `A1`, `A2`), cena 32 zł. Na produkcję wstawia je migracja 0007 (seed tam nie
działa), a w testach seed. Kupione bilety zostają, więc kolejny test na produkcji potrzebuje wolnych miejsc.
