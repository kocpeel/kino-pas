import { defineConfig, devices } from "@playwright/test";

// E2E kanału na żywo (Durable Object + WebSocket). `next dev` nie uruchamia worker.ts, więc te testy
// idą na zbudowanej aplikacji w workerd (`opennextjs-cloudflare preview`). Uruchamianie:
// `npm run test:e2e:push` (najpierw build). Baza: lokalna baza deweloperska (.wrangler/state).
const PORT = process.env.E2E_PUSH_PORT || "8790";
const kanal = process.env.PW_CHANNEL;

export default defineConfig({
  testDir: "tests/e2e-push",
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: "pl-PL",
    trace: "retain-on-failure",
    ...(kanal ? { channel: kanal } : {}),
  },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"], ...(kanal ? { channel: kanal } : {}) } }],
  webServer: {
    // Ścisłe limity rezerwacji (Durable Object) trzymają stan w .wrangler/state między uruchomieniami,
    // więc dla testów je luzujemy; same limity sprawdzają testy integracyjne.
    command: [
      `npx opennextjs-cloudflare preview --port ${PORT}`,
      "--var RESERVATION_ATTEMPTS_PER_IP:1000 --var RESERVATION_ATTEMPTS_PER_EMAIL:1000 --var RESERVATIONS_PER_IP_PER_TTL:0",
    ].join(" "),
    url: `http://localhost:${PORT}/api/events`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
