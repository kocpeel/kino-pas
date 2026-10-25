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

// `shell: true` (potrzebne na Windows dla npx/wrangler.cmd) skleja argumenty spacjami bez cudzysłowów,
// więc np. `--command "DELETE FROM seats; DELETE FROM events;"` rozpadłby się na kilka poleceń powłoki.
// Dlatego składamy linię sami i bierzemy w cudzysłów każdy argument ze spacją lub znakiem specjalnym.
const cytuj = (argument) => (/^[\w@%+=:,./\\-]+$/.test(argument) ? argument : `"${argument.replace(/"/g, '\\"')}"`);
const proces = spawn([polecenie, ...argumenty.map(cytuj)].join(" "), { stdio: "inherit", shell: true, env: process.env });
proces.on("exit", (kod) => process.exit(kod ?? 1));
