import { defineConfig, devices } from "@playwright/test";

// E2E na `npm run dev` (Next.js + Worker sali z kanałem na żywo) ze środowiskiem `e2e`
// (osobna baza D1, TTL rezerwacji 5 s). Obejmuje też testy pusha z tests/e2e-push.
// Przeglądarka: domyślnie Chromium z Playwright (`npx playwright install chromium`),
// albo zainstalowany Chrome/Edge: PW_CHANNEL=chrome | msedge.
const PORT = process.env.E2E_PORT || "3100";
const kanal = process.env.PW_CHANNEL;

export default defineConfig({
  testDir: "tests",
  testMatch: /[\\/](e2e|e2e-push)[\\/][^\\/]+\.spec\.ts$/,
  // CSP z nonce'em ustawia worker.ts, którego `next dev` nie uruchamia: ten test tylko w playwright.push.config.ts.
  testIgnore: /[\\/]e2e-push[\\/]csp\.spec\.ts$/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  // W CI cały przebieg ma twardy limit: lepiej raport z tym, co wisi, niż przerwany job bez logów.
  ...(process.env.CI ? { globalTimeout: 12 * 60_000 } : {}),
  reporter: [["list"]],
  globalSetup: "./tests/e2e/rozgrzewka.ts",
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: "pl-PL",
    timezoneId: "Europe/Warsaw",
    trace: "retain-on-failure",
    ...(kanal ? { channel: kanal } : {}),
  },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"], ...(kanal ? { channel: kanal } : {}) } }],
  webServer: {
    command: "node scripts/e2e-serwer.mjs",
    url: `http://localhost:${PORT}/api/events`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
