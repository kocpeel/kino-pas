// Serwer dla testów e2e: świeża lokalna baza środowiska `e2e` (TTL 8 s), `next dev` na porcie 3100,
// Worker sali (kanał na żywo) na 8791 i sztuczny Stripe na 8792. Uruchamiany przez Playwright (webServer),
// działa obok `npm run dev`. Prawdziwy klucz Stripe'a z `.dev.vars` tu nie trafia: wrangler dla środowiska
// `e2e` czyta `.dev.vars.e2e` zamiast `.dev.vars`.

import { execSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const PORT = process.env.E2E_PORT || "3100";
const PORT_STRIPE = process.env.SZTUCZNY_STRIPE_PORT || "8792";
const SEKRET_WEBHOOKA = "whsec_e2e_sztuczny";
const srodowisko = { ...process.env, CLOUDFLARE_ENV: "e2e", NEXT_DIST_DIR: ".next-e2e", SALA_DEV_PORT: "8791" };
const wrangler = (argumenty) =>
  execSync(`npx wrangler ${argumenty}`, { stdio: "inherit", env: srodowisko });

writeFileSync(
  ".dev.vars.e2e",
  `# Wygenerowane przez scripts/e2e-serwer.mjs: sztuczne wartości dla sztucznego Stripe'a.\n` +
    `STRIPE_SECRET_KEY=sk_test_e2e_sztuczny\nSTRIPE_WEBHOOK_SECRET=${SEKRET_WEBHOOKA}\nSTRIPE_API_BASE=http://localhost:${PORT_STRIPE}\n`,
);

wrangler("d1 migrations apply DB --local --env e2e");
wrangler('d1 execute DB --local --env e2e --command "DELETE FROM seats; DELETE FROM events; DELETE FROM reservations; DELETE FROM inbox; DELETE FROM outbox;"');
wrangler("d1 execute DB --local --env e2e --file seed/seed.sql");

const stripe = spawn("node tests/e2e/sztuczny-stripe.mjs", {
  stdio: "inherit",
  shell: true,
  env: {
    ...process.env,
    SZTUCZNY_STRIPE_PORT: PORT_STRIPE,
    STRIPE_WEBHOOK_SECRET: SEKRET_WEBHOOKA,
    ADRES_WEBHOOKA: `http://localhost:${PORT}/api/webhooks/stripe`,
  },
});
const serwer = spawn(`node scripts/dev.mjs -p ${PORT}`, { stdio: "inherit", env: srodowisko, shell: true });
const zakoncz = () => {
  stripe.kill();
  serwer.kill();
};
process.on("SIGINT", zakoncz);
process.on("SIGTERM", zakoncz);
serwer.on("exit", (kod) => {
  stripe.kill();
  process.exit(kod ?? 0);
});
