// Uruchamia polecenie (wrangler, opennextjs-cloudflare) z danymi dostępowymi Cloudflare
// z pliku .env.cloudflare (poza gitem). Bez tego pliku działa na zmiennych środowiskowych
// albo na sesji z `npx wrangler login`.
// Użycie: node scripts/cloudflare.mjs <polecenie> [argumenty…]

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const PLIK = ".env.cloudflare";

if (existsSync(PLIK)) {
  process.loadEnvFile(PLIK);
} else {
  console.warn(`Brak ${PLIK}: używam zmiennych środowiskowych albo sesji z \`wrangler login\`.`);
}

const [polecenie, ...argumenty] = process.argv.slice(2);
if (!polecenie) {
  console.error("Użycie: node scripts/cloudflare.mjs <polecenie> [argumenty…]");
  process.exit(2);
}

const proces = spawn(polecenie, argumenty, { stdio: "inherit", shell: true, env: process.env });
proces.on("exit", (kod) => process.exit(kod ?? 1));
