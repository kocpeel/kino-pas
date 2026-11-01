# Kontrakt wewnętrzny etapu II

Ustalenia między kartami A, B i C: adresy stron powrotu, sposób zapisu płatności, outbox i inbox.
Kontrakt zewnętrzny jest w [kontrakt-api.md](kontrakt-api.md), a zagrożenia w [zagrozenia.md](zagrozenia.md).

## Cała droga

Stripe to cudzy system: jego skutków nie obejmie nasza transakcja ani nie cofnie rollback (dual write z E07).
Dlatego każde przejście między systemami ma swojego strażnika.

| Krok | Gdzie | Kto pilnuje |
|---|---|---|
| 1. Rezerwacja + wpis do historii + kwota | D1 | warunkowy `UPDATE` i jeden `batch` |
| 2. Sesja płatności | Stripe | 🔑 klucz idempotencji `checkout:<reservationId>` |
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
| Klucz idempotencji | `checkout:<reservationId>` | Podwójne kliknięcie, retry i padnięcie między Stripe'em a zapisem dają tę samą sesję. |
| `client_reference_id` | `reservationId` | Tak webhook wie, której rezerwacji dotyczy płatność. |
| `line_items` | `pln`, `unit_amount` = `amount` z rezerwacji | Nigdy cena z formularza ani bieżąca cena wydarzenia. |
| `expires_at` | `expiresAt` rezerwacji + 31 min | Stripe wymaga co najmniej 30 min. Liczone od rezerwacji, nie od „teraz”, bo ten sam klucz z innymi parametrami to błąd. |
| `excluded_payment_method_types` | `blik`, `klarna`, `p24` | Od API 2026-10 metody ustawia panel, a `payment_method_types` nie jest przyjmowane. Etap II to płatność kartą. |
| `custom_text.submit` | godzina końca rezerwacji | Sesja żyje dłużej niż rezerwacja, więc klient musi to widzieć na stronie płatności. |

Nie wysyłamy `customer_email`: Stripe sam go zbiera, a my nie przekazujemy więcej danych, niż potrzeba.

## 📤 Outbox

Tabela `outbox`, te same pola co jobs z E06: `id`, `task`, `input`, `visibleAt`, `totalTried`, `completedAt`, `hasError`
(plus `lastError`). Zapis razem z naszymi danymi, wysyłka w Workerze z Cronem (`domain/outbox.ts`): claim → wywołanie
→ ack. Gwarancja: co najmniej raz.

| `task` | `id` (i klucz idempotencji) | `input` | Co robi |
|---|---|---|---|
| `stripe-refund` | `stripe-refund:<paymentIntentId>` | `paymentIntentId`, `reservationId` | Zwrot płatności, która nie dała biletu. Zapisywany w tej samej transakcji co zdarzenie w inboxie. |
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
| Mail z biletem | nie wysyłamy | CEO o niego nie prosi. Gdyby doszedł: outbox i ≥1, bo drugi mail jest tańszy niż brak biletu. |

## Sekrety

| Zmienna | Gdzie | Uwagi |
|---|---|---|
| `STRIPE_SECRET_KEY` | sekret głównego Workera i Workera z Cronem, lokalnie `.dev.vars` | Tylko `sk_test_` albo `rk_test_`. Klucz produkcyjny wyłącza płatności. |
| `STRIPE_WEBHOOK_SECRET` | sekret głównego Workera, lokalnie `.dev.vars` | Z endpointu w panelu Stripe albo z `stripe listen`. |
| `ALERT_WEBHOOK_URL` | sekret Workera z Cronem, opcjonalny | Bez niego alerty są tylko w Workers Logs. |

Jedno konto Stripe mogą dzielić środowiska (produkcja, staging, lokalnie) i każdy endpoint dostaje wszystkie zdarzenia.
Dlatego zdarzenie z nieznaną rezerwacją kończy się 200 bez skutku, a przede wszystkim bez zwrotu.
