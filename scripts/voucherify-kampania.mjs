// Zakłada (albo znajduje) kampanię lojalnościową w projekcie Sandbox Voucherify i wypisuje jej ID, które trafia
// do sekretu VOUCHERIFY_CAMPAIGN_ID. Klucze bierze z `.dev.vars` (poza gitem) albo ze zmiennych środowiskowych,
// a wartości kluczy nigdy nie wypisuje. Użycie: `npm run voucherify:kampania`.
// `join_once`: klient może dołączyć do programu raz, więc nie powstanie mu druga karta.

import { existsSync, readFileSync } from "node:fs";

const NAZWA = "Kino Pas: punkty";

function zmienna(nazwa) {
  if (process.env[nazwa]) return process.env[nazwa];
  if (!existsSync(".dev.vars")) return undefined;
  const linia = readFileSync(".dev.vars", "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${nazwa}=`));
  return linia?.slice(nazwa.length + 1).trim() || undefined;
}

const appId = zmienna("VOUCHERIFY_APP_ID");
const sekret = zmienna("VOUCHERIFY_SECRET_KEY");
const adres = (zmienna("VOUCHERIFY_API_URL") || "https://api.voucherify.io").replace(/\/$/, "");
if (!appId || !sekret) {
  console.error("Brak VOUCHERIFY_APP_ID albo VOUCHERIFY_SECRET_KEY w .dev.vars albo w zmiennych środowiskowych.");
  process.exit(1);
}

async function voucherify(metoda, sciezka, cialo) {
  const odp = await fetch(`${adres}${sciezka}`, {
    method: metoda,
    headers: { "X-App-Id": appId, "X-App-Token": sekret, "Content-Type": "application/json", "User-Agent": "kasa-kino" },
    ...(cialo ? { body: JSON.stringify(cialo) } : {}),
  });
  const tresc = await odp.json().catch(() => ({}));
  if (!odp.ok) throw new Error(`${metoda} ${sciezka}: ${odp.status} ${tresc.key ?? ""} ${tresc.message ?? ""} ${tresc.details ?? ""}`);
  return { tresc, pozostalo: odp.headers.get("x-rate-limit-remaining") };
}

const { tresc: lista } = await voucherify("GET", "/v1/campaigns?campaign_type=LOYALTY_PROGRAM&limit=100");
const istniejaca = (lista.campaigns ?? lista.data ?? []).find((k) => k.name === NAZWA);
if (istniejaca) {
  console.log(`Kampania już jest: ${istniejaca.id}`);
  process.exit(0);
}

const { tresc: kampania, pozostalo } = await voucherify("POST", "/v1/campaigns", {
  name: NAZWA,
  campaign_type: "LOYALTY_PROGRAM",
  type: "AUTO_UPDATE",
  join_once: true,
  voucher: { type: "LOYALTY_CARD", loyalty_card: { points: 0 } },
  metadata: { zrodlo: "kasa-kino" },
});
console.log(`Założona kampania: ${kampania.id}`);
console.log(`Ustaw VOUCHERIFY_CAMPAIGN_ID=${kampania.id} (zostało wywołań w tej godzinie: ${pozostalo ?? "?"})`);
