# Lista zagrożeń: Stripe jako cudzy system

Stripe ma własne dane i własne awarie, a nasza transakcja obejmuje tylko naszą bazę. Każde zagrożenie niżej ma kartę
(strażnika w kodzie) i test. Oznaczenia narzędzi jak w E07: 📤 outbox, 🔑 klucz idempotencji, 📥 inbox, ⚖️ świadomy wybór.

## Pułapka tego etapu: sesja żyje dłużej niż rezerwacja

Stripe nie pozwala na sesję krótszą niż 30 minut, a rezerwacja trwa docelowo 15 (w trybie oceny 2). Klient może więc zapłacić za fotel,
którego już nie ma. Nie da się tego wykluczyć: Cron działa co minutę, a klient może kliknąć w tej samej chwili.
Dlatego są dwie warstwy: strażnik wygasza sesję po wygaśnięciu rezerwacji, a płatność, która mimo to zdąży,
wraca do klienta. Bilet po czasie nie powstaje nigdy, a fotel ma zawsze jednego właściciela.

## Karty

| # | Zagrożenie | Co by się stało | Strażnik | Test |
|---|---|---|---|---|
| D1 | Płatność po wygaśnięciu rezerwacji | Klient płaci, a fotel ma już kogoś innego albo wrócił do puli: bilet po czasie albo pieniądze bez biletu | Warunek `paidAt < expiresAt` w jednej transakcji z inboxem. Inaczej 📤 `stripe-refund` z 🔑 kluczem. UI: „Pieniądze wracają na Twoją kartę”. Na stronie Stripe'a godzina końca rezerwacji. | `platnosci.test.ts` (płatność a czas), `outbox.test.ts`, e2e; prawdziwy zwrot na sandboksie |
| D2 | Otwarta sesja po wygaśnięciu rezerwacji | Strona płatności dalej przyjmuje karty | 📤 Strażnik sesji wygasza ją w ciągu minuty od końca rezerwacji | `outbox.test.ts` (strażnik), prawdziwe wygaszenie na sandboksie |
| D3 | Spóźniony webhook | Klient zapłacił na czas, a webhook dotarł po wygaśnięciu albo po sprzątaniu Crona | Liczy się `event.created`, a nie chwila dostarczenia. Fotel bez żywego właściciela wraca do płacącego. Ma żywego właściciela → on zostaje, a pieniądze wracają. | `platnosci.test.ts` |
| D4 | Zgubiony webhook (zły adres, nasza długa awaria) | Klient zapłacił i bez końca widzi „płatność w toku” | 📤 Strażnik sesji co minutę pyta Stripe'a o stan i sam rozlicza płatność. Strona po 20 s mówi, co się dzieje. | `outbox.test.ts`, prawdziwa płatność bez webhooka na sandboksie |
| D5 | Stripe powtarza zdarzenie (≥1, do 3 dni) | Drugi bilet albo drugi zwrot | 📥 Inbox w jednej transakcji ze skutkiem, 200 dla duplikatu, job zwrotu z ID wynikającym z płatności | `platnosci.test.ts` (10 równoległych dostarczeń), `wspolbieznosc.test.ts` |
| D6 | Podwójne „Zapłać”, retry, padnięcie między Stripe'em a zapisem | Dwie sesje i dwie płatności za jeden fotel | 🔑 `checkout:<id>`, deterministyczne parametry, zapisana sesja. Druga płatność, gdyby jednak przyszła, wraca do klienta. | `platnosci.test.ts`, test obciążeniowy W3 (prawdziwy Stripe) |
| D7 | Fałszywy webhook | Darmowy bilet po wysłaniu żądania na publiczny adres | ✍️ Podpis na surowym ciele, tolerancja 5 min, bez podpisu 400. Bez sekretu w konfiguracji 503, nigdy „przepuść”. | `platnosci.test.ts`, `platnosc.test.ts` |
| D8 | Droga na skróty przez stare `POST /purchase` | Bilet bez płatności | Endpoint oddaje kod tylko opłaconej rezerwacji, inaczej 402 | `platnosci.test.ts`, `kontrakt.test.ts` |
| D9 | Stripe nie działa albo zwalnia | Wiszące żądania, 500, zablokowana sprzedaż | Timeout 6 s, ograniczone ponowienia, bezpiecznik (po 5 awariach odmawia od razu przez 30 s), czytelne 503 z `Retry-After`. Rezerwacje i odczyty w ogóle nie pytają Stripe'a. Rezerwacja dalej trzyma fotel. | `platnosci.test.ts`, `platnosc.test.ts`, `Licznik.test.tsx` |
| D10 | Zwrot się nie udaje | Klient bez biletu i bez pieniędzy, a nikt o tym nie wie | 📤 Ponowienia z backoffem przez około 3 godziny, potem DLQ, `refundStatus = 'failed'`, alert z Crona i komunikat dla klienta | `outbox.test.ts` |
| D11 | Zła kwota | Bilet za złą cenę | `amount` zapisany przy rezerwacji i niezmienny, sesja tylko z niego. Webhook sprawdza kwotę i walutę, a niezgodna płatność idzie do zwrotu z alertem. | `platnosci.test.ts` |
| D12 | Wyciek klucza albo prawdziwe pieniądze | Klucz w repozytorium lub przeglądarce, obciążenie prawdziwych kart | Sekrety w zmiennych serwera, `lint:sekrety` w CI (repozytorium i pliki przeglądarki), klucz `sk_live_` wyłącza płatności, a `/api/zdrowie` zgłasza brak sekretów | `platnosc.test.ts`, `scripts/sprawdz-sekrety.mjs` |
| D13 | Zdarzenia z innego środowiska na tym samym koncie Stripe | Staging zwraca płatności produkcji albo odwrotnie | Nieznana rezerwacja = 200 bez skutku i bez zwrotu | `platnosci.test.ts` |
| D14 | Przerwana płatność i powrót przyciskiem Wstecz | Zablokowany przycisk, utracona rezerwacja | `cancel_url` z komunikatem, ta sama sesja przy ponownej próbie, odblokowanie po `pageshow` | `Licznik.test.tsx`, e2e, sandbox |
| D15 | Limity API Stripe'a | Fala kliknięć zużywa limit | Do Stripe'a idzie tylko pierwsze „Zapłać” danej rezerwacji, kolejne biorą sesję z bazy. Rezerwacje mają ścisły limit na IP. 429 od Stripe'a to 503 z `Retry-After`. | `platnosci.test.ts` |
| D16 | Wyciek linku do biletu | Kod widoczny dla kogoś, kto dostał link | ⚖️ Świadomy wybór: sekret rezerwacji wycofany (`decyzje.md`, sekcja 12), bo kontrakt daje kod po samym identyfikatorze. To losowy UUID, którego nie da się zgadnąć, a kod nie zawiera danych osobowych. | `kontrakt.test.ts` |

## Czego ta lista nie obejmuje

- **Spory i chargebacki:** w trybie testowym ich nie ma.
- **Mail z biletem:** nie wysyłamy go. Kod zostaje w przeglądarce, a gdy klient ją wyczyści, po biletu trzeba iść do obsługi.
- **Globalny stan bezpiecznika:** liczy się osobno w każdym izolacie, więc przy awarii Stripe'a chwilę potrwa, zanim otworzy się wszędzie.
