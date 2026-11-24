// Serwer dla testów e2e: świeża lokalna baza środowiska `e2e` (TTL 8 s), `next dev` na porcie 3100,
// Worker sali (kanał na żywo) na 8791, sztuczny Stripe na 8792 i sztuczny Voucherify na 8793. Uruchamiany przez Playwright (webServer),
// działa obok `npm run dev`. Prawdziwy klucz Stripe'a z `.dev.vars` tu nie trafia: wrangler dla środowiska
// `e2e` czyta `.dev.vars.e2e` zamiast `.dev.vars`.

import { execSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const PORT = process.env.E2E_PORT || "3100";
const PORT_STRIPE = process.env.SZTUCZNY_STRIPE_PORT || "8792";
const PORT_VOUCHERIFY = process.env.SZTUCZNY_VOUCHERIFY_PORT || "8793";
const SEKRET_WEBHOOKA = "whsec_e2e_sztuczny";
const srodowisko = { ...process.env, CLOUDFLARE_ENV: "e2e", NEXT_DIST_DIR: ".next-e2e", SALA_DEV_PORT: "8791" };
const wrangler = (argumenty) =>
  execSync(`npx wrangler ${argumenty}`, { stdio: "inherit", env: srodowisko });

writeFileSync(
  ".dev.vars.e2e",
  `# Wygenerowane przez scripts/e2e-serwer.mjs: sztuczne wartości dla sztucznego Stripe'a.\n` +
    `STRIPE_SECRET_KEY=sk_test_e2e_sztuczny\nSTRIPE_WEBHOOK_SECRET=${SEKRET_WEBHOOKA}\nSTRIPE_API_BASE=http://localhost:${PORT_STRIPE}\n` +
    `VOUCHERIFY_APP_ID=e2e\nVOUCHERIFY_SECRET_KEY=e2e-sztuczny\nVOUCHERIFY_CAMPAIGN_ID=camp_e2e\nVOUCHERIFY_API_URL=http://localhost:${PORT_VOUCHERIFY}\n`,
);

wrangler("d1 migrations apply DB --local --env e2e");
wrangler('d1 execute DB --local --env e2e --command "DELETE FROM waitlist; DELETE FROM seats; DELETE FROM events; DELETE FROM reservations; DELETE FROM inbox; DELETE FROM outbox; DELETE FROM sagas; DELETE FROM loyalty_accounts;"');
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
const voucherify = spawn("node tests/e2e/sztuczny-voucherify.mjs", {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, SZTUCZNY_VOUCHERIFY_PORT: PORT_VOUCHERIFY },
});
const serwer = spawn(`node scripts/dev.mjs -p ${PORT}`, { stdio: "inherit", env: srodowisko, shell: true });
const zakoncz = () => {
  stripe.kill();
  voucherify.kill();
  serwer.kill();
};
process.on("SIGINT", zakoncz);
process.on("SIGTERM", zakoncz);
serwer.on("exit", (kod) => {
  stripe.kill();
  voucherify.kill();
  process.exit(kod ?? 0);
});
