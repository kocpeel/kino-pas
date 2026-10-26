# Kino Pas: kasa biletowa (Etap I)

Rezerwacja i zakup biletów na 3 seanse (2 sale, 8 × 10 foteli). Next.js 16 na Cloudflare Workers
przez adapter OpenNext, baza D1, ścisły rate limiting na Durable Object (plus binding Workers Rate Limiting), mapa sali na żywo
przez Durable Object + WebSocket (`worker.ts`), sprzątanie wygasłych rezerwacji przez osobny Worker z Cron Triggerem.

- Wdrożenie: https://kasa-kino.jajcokgt.workers.dev (Cron: Worker `kasa-kino-sprzatanie`: co minutę sprzątanie
  i kontrola zdrowia, raz na dobę retencja danych osobowych)
- Zdrowie: `GET /api/zdrowie`
- Kontrakt API: [docs/kontrakt-api.md](docs/kontrakt-api.md)
- Decyzje projektowe (wyścigi, TTL, idempotencja, odporność, wycieki): [docs/decyzje.md](docs/decyzje.md)
- Treść zadania: [task1.txt](task1.txt)

## Szybki start (lokalnie)

Wymagania: Node.js 22+.

```bash
npm install
npm run db:migrate:local
npm run db:seed:local
npm run dev
```

Aplikacja: http://localhost:3000. `next dev` dostaje bindingi (D1, rate limit, vars) z `wrangler.jsonc`
przez `initOpenNextCloudflareForDev`. Lokalna baza leży w `.wrangler/state`.
`npm run dev` uruchamia dwa procesy: `next dev` i Worker sali (`workers/sala-dev`, port 8789) z Durable Objectem,
więc mapa na żywo (WebSocket) działa także lokalnie. Same `npm run dev:next` startuje tylko Next.js (mapa wtedy odpytuje).
Krótszy TTL do ręcznych testów: skopiuj `.dev.vars.example` do `.dev.vars` (TTL 120 s).

Podgląd zbudowanego Workera w prawdziwym runtime (workerd):

```bash
npm run preview
```

Cron sprzątający lokalnie (ta sama lokalna baza), wywołanie: `curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"`:

```bash
npm run cron:dev
```

## Testy

| Komenda | Co | Środowisko |
|---|---|---|
| `npm run test:unit` | domena, układ sali, walidacja, mapowanie błędów, odporność, statyczny test wycieków | Node |
| `npm run test:int` | W1–W6 (współbieżność), wygasanie, idempotencja, odporność, kontrakt, Cron, kanał na żywo (Durable Object + WebSocket) | workerd + prawdziwy D1 (`@cloudflare/vitest-plugin`) |
| `npm run test:ui` | komponenty: Fotel, MapaSali, Formularz, Licznik, hooki (timery po odmontowaniu) | jsdom + Testing Library |
| `npm run test:e2e` | ścieżka A → B → C, wygaśnięcie (TTL 5 s), dwie sesje, odświeżanie, telefon, axe, klawiatura, repertuar po „Wstecz", mapa na żywo | Playwright + `npm run dev` (środowisko `e2e`) |
| `npm run test:e2e:push` | build produkcyjny: mapa na żywo bez odpytywania, Content-Security-Policy z nonce'em | Playwright + zbudowana aplikacja w workerd |
| `npm run test:obciazenie` | W1 (50 osób o jeden fotel), W2 (80 o różne), W3 (20 równoległych zakupów), odczyty: niezmienniki pod prawdziwym opóźnieniem | Node + środowisko `staging` w Cloudflare (`BASE_URL=…`) |
| `npm run typecheck`, `npm run lint:wycieki` | TypeScript, stan na poziomie modułu | Node |

`npm test` uruchamia testy jednostkowe, integracyjne i UI; CI (`.github/workflows/testy.yml`) robi to samo plus e2e
przy każdym pushu na `feature`/`main`. E2E potrzebuje przeglądarki:
`npx playwright install chromium` albo zainstalowany Chrome/Edge: `PW_CHANNEL=chrome npm run test:e2e`.

## Wdrożenie na Cloudflare

Jednorazowo:

1. Dane dostępowe: skopiuj `.env.cloudflare.example` do `.env.cloudflare` (poza gitem) i wpisz `CLOUDFLARE_API_TOKEN`
   oraz `CLOUDFLARE_ACCOUNT_ID`. Skrypty zdalne (`deploy`, `cron:deploy`, `db:*:remote`, `cf:whoami`) czytają go przez
   `scripts/cloudflare.mjs`. Bez tego pliku działa `npx wrangler login`. Nie wpisuj tokena do `.env`: Next.js/OpenNext
   wczytują ten plik do aplikacji.
2. Utwórz bazę: `npx wrangler d1 create kasa-kino-db` (albo w dashboardzie) i wpisz jej `database_id`
   w **obu** plikach: `wrangler.jsonc` i `workers/sprzatanie/wrangler.jsonc`.
3. Schemat i dane:

   ```bash
   npm run db:migrate:remote
   npm run db:seed:remote
   ```

Każde wdrożenie:

```bash
npm run deploy
npm run cron:deploy
```

Tryb oceny etapu (`wrangler.jsonc`): TTL `"120"` (expiresAt ok. 2 min) i limit tylko zalewu z jednego IP (50 prób / 10 s),
bez limitów na e-mail (`docs/decyzje.md`, sekcja 12). Po ocenie: TTL `"900"` i limity docelowe z komentarzy w
`wrangler.jsonc`, potem ponowne wdrożenie.

Środowisko testów obciążeniowych (osobny Worker `kasa-kino-staging` i baza `kasa-kino-db-staging`, wpis `staging`
w `wrangler.jsonc`):

```bash
npm run staging:deploy
npm run staging:db
BASE_URL=https://kasa-kino-staging.jajcokgt.workers.dev npm run test:obciazenie
```

Alerty (opcjonalnie): Worker sprzątający co minutę sprawdza `/api/zdrowie`. Problemy zawsze trafiają do Workers Logs
(linia JSON z polem `alert`). Powiadomienia na Slack/Discord: utwórz webhook i zapisz jego adres jako sekret:

```bash
node scripts/cloudflare.mjs wrangler secret put ALERT_WEBHOOK_URL --config workers/sprzatanie/wrangler.jsonc
```

## Struktura

```
migrations/                   0001 schemat (events, seats, CHECK), 0002 indeks zajętych, 0003 sekret rezerwacji, 0004 stan alertów
seed/generuj-seed.ts          3 seanse × 80 foteli (→ seed/seed.sql)
src/app/                      strony (repertuar, mapa, formularz, licznik, bilet) i cienkie route handlery
src/components/               ui/, repertuar/, sala/, rezerwacja/, bilet/, uklad/
src/hooks/                    usePolling, useCountdown, useNaZywo (WebSocket)
src/lib/domain/               czysta logika: układ sali, walidacja, rezerwacja i zakup, błędy
src/lib/db/                   zapytania D1 (jedyne miejsce z SQL) i bindingi
src/lib/http/                 wrapper tras, walidacja wejścia, odpowiedzi, odczyty z cache
src/lib/resilience/           timeout, rate limit (ścisły na Durable Object), load shedding, ograniczony cache
src/lib/push/                 Durable Object sali, trasa WebSocket, protokół kanału na żywo
worker.ts                     własny Worker: OpenNext + CSP z nonce'em + /api/events/:id/live + Durable Objecty
src/lib/klient/               fetch z timeoutem/retry/idempotencją, sessionStorage
workers/sprzatanie/           Worker z Cronami: sprzątanie, retencja, zdrowie i alerty (ta sama baza D1)
workers/sala-dev/             Worker sali tylko do `npm run dev` (nie wdrażany)
scripts/dev.mjs               `npm run dev`: Next.js + Worker sali obok siebie
tests/                        jednostkowe/, integracyjne/, ui/, e2e/, e2e-push/, obciazenie/
```
