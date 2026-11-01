// Lokalny zamiennik `stripe listen` dla tych, którzy nie mają Stripe CLI: odpytuje listę zdarzeń sandboksu
// i przekazuje nowe na lokalny webhook, podpisane sekretem z .dev.vars. Handler sprawdza podpis tak samo
// jak na produkcji. Uwaga: to ćwiczy naszą obsługę zdarzeń, ale nie dostarczanie przez Stripe'a (ponowienia).
//
// Użycie: npm run stripe:nasluch  (albo z adresem: node scripts/stripe-nasluch.mjs http://localhost:3100/api/webhooks/stripe)
// W .dev.vars: STRIPE_SECRET_KEY i dowolny STRIPE_WEBHOOK_SECRET (np. whsec_lokalny).

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const ADRES = process.argv[2] ?? "http://localhost:3000/api/webhooks/stripe";
const CO_ILE_MS = 1500;
const TYPY = ["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.expired"];

function wartosc(plik, nazwa) {
  return new RegExp(`^${nazwa}=(.+)$`, "m").exec(plik)?.[1]?.trim();
}

const zmienne = readFileSync(".dev.vars", "utf8");
const klucz = wartosc(zmienne, "STRIPE_SECRET_KEY");
const sekret = wartosc(zmienne, "STRIPE_WEBHOOK_SECRET");
if (!klucz?.startsWith("sk_test_") || !sekret) {
  console.error("W .dev.vars muszą być STRIPE_SECRET_KEY (sk_test_…) i STRIPE_WEBHOOK_SECRET.");
  process.exit(2);
}

const start = Math.floor(Date.now() / 1000) - 5;
const widziane = new Set();

async function przekaz(zdarzenie) {
  const cialo = JSON.stringify(zdarzenie);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", sekret).update(`${t}.${cialo}`).digest("hex");
  const odp = await fetch(ADRES, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${v1}` },
    body: cialo,
  });
  console.log(`${new Date().toISOString()} ${zdarzenie.type} ${zdarzenie.id} → ${odp.status}`);
  return odp.ok;
}

async function krok() {
  const zapytanie = new URLSearchParams({ limit: "20", "created[gte]": String(start) });
  for (const typ of TYPY) zapytanie.append("types[]", typ);
  const odp = await fetch(`https://api.stripe.com/v1/events?${zapytanie}`, { headers: { authorization: `Bearer ${klucz}` } });
  if (!odp.ok) throw new Error(`Stripe: HTTP ${odp.status}`);
  const { data } = await odp.json();
  for (const zdarzenie of data.reverse()) {
    if (widziane.has(zdarzenie.id)) continue;
    // Jak Stripe: nieudane dostarczenie zostanie ponowione przy następnym kroku.
    if (await przekaz(zdarzenie)) widziane.add(zdarzenie.id);
  }
}

console.log(`Nasłuch zdarzeń Stripe → ${ADRES}`);
for (;;) {
  await krok().catch((blad) => console.error(`Nieudany krok: ${blad.message}`));
  await new Promise((r) => setTimeout(r, CO_ILE_MS));
}
