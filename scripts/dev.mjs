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

function zabij(proces) {
  if (proces.exitCode !== null || proces.pid === undefined) return;
  if (naWindows) {
    spawn("taskkill", ["/pid", String(proces.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-proces.pid, "SIGTERM");
    } catch {
      proces.kill("SIGTERM");
    }
  }
}

function zakoncz(kod = 0) {
  if (konczenie) return;
  konczenie = true;
  procesy.forEach(zabij);
  setTimeout(() => process.exit(kod), 500);
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
