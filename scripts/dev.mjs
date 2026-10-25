// `npm run dev`: Next.js i Worker sali (kanał na żywo, workers/sala-dev) obok siebie.
// `next dev` nie uruchamia worker.ts, więc Durable Object sali i WebSocket działają w osobnym
// procesie workerd na tej samej lokalnej bazie D1. Next.js dostaje jego adres w SALA_DEV_URL.
// Argumenty idą do `next dev` (np. `npm run dev -- -p 3100`). Ctrl+C zamyka oba procesy.

import { spawn } from "node:child_process";

const portSali = Number(process.env.SALA_DEV_PORT || 8789);
const srodowiskoCf = process.env.CLOUDFLARE_ENV; // np. "e2e"
const env = { ...process.env, SALA_DEV_URL: `http://localhost:${portSali}` };
const naWindows = process.platform === "win32";
const procesy = [];
let konczenie = false;

function uruchom(nazwa, polecenie, { prefiks = true } = {}) {
  const proces = spawn(polecenie, {
    shell: true,
    env,
    detached: !naWindows, // własna grupa procesów, żeby zamknąć całe drzewo
    stdio: prefiks ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (prefiks) {
    for (const strumien of [proces.stdout, proces.stderr]) {
      let reszta = "";
      strumien.on("data", (kawalek) => {
        const linie = (reszta + kawalek).split(/\r?\n/);
        reszta = linie.pop() ?? "";
        for (const linia of linie) process.stdout.write(`[sala] ${linia}\n`);
      });
    }
  }
  proces.on("exit", (kod) => {
    if (!konczenie) {
      console.log(`[${nazwa}] zakończony (kod ${kod}), zamykam pozostałe procesy`);
      zakoncz(kod ?? 1);
    }
  });
  procesy.push(proces);
}

/** Czy w grupie procesów dziecka (Linux/macOS) został jeszcze jakiś proces. */
function grupaZyje(proces) {
  try {
    process.kill(-proces.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function zabij(proces, sygnal) {
  if (proces.pid === undefined) return;
  if (naWindows) {
    if (proces.exitCode === null) spawn("taskkill", ["/pid", String(proces.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  // Cała grupa, nie tylko lider: `next dev` i workerd to wnuki, które przeżyłyby zabicie samej powłoki
  // i trzymały otwarte stdout (Playwright czekałby wtedy na zamknięcie serwera w nieskończoność).
  try {
    process.kill(-proces.pid, sygnal);
  } catch {}
}

const LIMIT_ZAMYKANIA_MS = 5000;

function zakoncz(kod = 0) {
  if (konczenie) return;
  konczenie = true;
  procesy.forEach((p) => zabij(p, "SIGTERM"));
  if (naWindows) {
    setTimeout(() => process.exit(kod), 500);
    return;
  }
  // Wychodzimy dopiero, gdy grupy dzieci są puste; kto nie zamknie się sam, po 5 s dostaje SIGKILL.
  const start = Date.now();
  const sprawdz = setInterval(() => {
    const zywe = procesy.filter(grupaZyje);
    if (zywe.length > 0 && Date.now() - start < LIMIT_ZAMYKANIA_MS) return;
    zywe.forEach((p) => zabij(p, "SIGKILL"));
    clearInterval(sprawdz);
    process.exit(kod);
  }, 100);
}

process.on("SIGINT", () => zakoncz(0));
process.on("SIGTERM", () => zakoncz(0));

const wrangler = [
  "npx wrangler dev",
  "--config workers/sala-dev/wrangler.jsonc",
  `--port ${portSali}`,
  `--inspector-port ${9229 + (portSali - 8789)}`,
  "--persist-to .wrangler/state",
  "--show-interactive-dev-session=false",
  srodowiskoCf ? `--env ${srodowiskoCf}` : "",
].join(" ");

uruchom("sala", wrangler);
uruchom("next", `npx next dev ${process.argv.slice(2).join(" ")}`, { prefiks: false });
