// Serwer dla testów e2e: świeża lokalna baza środowiska `e2e` (TTL 5 s), `next dev` na porcie 3100
// i Worker sali (kanał na żywo) na 8791. Uruchamiany przez Playwright (webServer), działa obok `npm run dev`.

import { execSync, spawn } from "node:child_process";

const PORT = process.env.E2E_PORT || "3100";
const srodowisko = { ...process.env, CLOUDFLARE_ENV: "e2e", NEXT_DIST_DIR: ".next-e2e", SALA_DEV_PORT: "8791" };
const wrangler = (argumenty) =>
  execSync(`npx wrangler ${argumenty}`, { stdio: "inherit", env: srodowisko });

wrangler("d1 migrations apply DB --local --env e2e");
wrangler('d1 execute DB --local --env e2e --command "DELETE FROM seats; DELETE FROM events;"');
wrangler("d1 execute DB --local --env e2e --file seed/seed.sql");

const serwer = spawn(`node scripts/dev.mjs -p ${PORT}`, { stdio: "inherit", env: srodowisko, shell: true });
const zakoncz = () => serwer.kill();
process.on("SIGINT", zakoncz);
process.on("SIGTERM", zakoncz);
serwer.on("exit", (kod) => process.exit(kod ?? 0));
