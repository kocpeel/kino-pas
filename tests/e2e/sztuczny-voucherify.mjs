// Sztuczny Voucherify dla testów e2e: bez sieci i bez kluczy, więc działa też w CI. Trzyma tylko te reguły
// (z dokumentacji i z sandboksa), których używa aplikacja: karta lojalnościowa na klienta (source_id = e-mail;
// drugi zapis zwraca tę samą), saldo, zmiana salda z `source_id` i historia operacji karty. Odjęcie większe niż
// saldo jest obcinane do salda (`points` w odpowiedzi mówi, ile zeszło), a zmiana o 0 nie trafia do historii.
// GET /__stan pokazuje karty i ich operacje.

import { createServer } from "node:http";

const PORT = Number(process.env.SZTUCZNY_VOUCHERIFY_PORT || 8793);

const karty = new Map(); // email → { code, balance, operacje: [{ source_id, points }] }
let numer = 0;

function json(odp, status, dane) {
  odp.writeHead(status, { "content-type": "application/json" });
  odp.end(JSON.stringify(dane));
}

function czytajCialo(zad) {
  return new Promise((rozwiaz) => {
    let tekst = "";
    zad.on("data", (k) => (tekst += k));
    zad.on("end", () => {
      try {
        rozwiaz(tekst ? JSON.parse(tekst) : {});
      } catch {
        rozwiaz({});
      }
    });
  });
}

// Jak prawdziwy: metadane z zapisu do programu idą do publikacji, nie na kartę.
function kartaApi(k) {
  return { code: k.code, type: "LOYALTY_CARD", loyalty_card: { points: k.points, balance: k.balance }, metadata: {} };
}

function poKodzie(code) {
  for (const k of karty.values()) if (k.code === code) return k;
  return null;
}

createServer(async (zad, odp) => {
  const adres = new URL(zad.url, `http://localhost:${PORT}`);
  const m = adres.pathname;
  if (m === "/__stan") return json(odp, 200, { karty: [...karty.entries()].map(([email, k]) => ({ email, ...k })) });
  if (!zad.headers["x-app-id"] || !zad.headers["x-app-token"]) return json(odp, 401, { code: 401, key: "unauthorized", message: "Unauthorized" });

  let dopasowanie = /^\/v1\/loyalties\/([^/]+)\/members$/.exec(m);
  if (dopasowanie && zad.method === "GET") {
    const k = karty.get(adres.searchParams.get("customer"));
    return json(odp, 200, { object: "list", data_ref: "vouchers", vouchers: k ? [kartaApi(k)] : [], total: k ? 1 : 0 });
  }
  if (dopasowanie && zad.method === "POST") {
    const cialo = await czytajCialo(zad);
    const email = cialo.customer?.source_id;
    if (!email) return json(odp, 400, { code: 400, key: "invalid_payload", message: "customer required" });
    if (karty.has(email)) return json(odp, 200, kartaApi(karty.get(email)));
    const k = { code: `E2E-${++numer}`, balance: 0, points: 0, operacje: [] };
    karty.set(email, k);
    return json(odp, 200, kartaApi(k));
  }
  dopasowanie = /^\/v1\/loyalties\/[^/]+\/members\/([^/]+)$/.exec(m);
  if (dopasowanie && zad.method === "GET") {
    const k = poKodzie(decodeURIComponent(dopasowanie[1]));
    return k ? json(odp, 200, kartaApi(k)) : json(odp, 404, { code: 404, key: "not_found", message: "Not found" });
  }
  dopasowanie = /^\/v1\/loyalties\/members\/([^/]+)\/balance$/.exec(m);
  if (dopasowanie && zad.method === "POST") {
    const k = poKodzie(decodeURIComponent(dopasowanie[1]));
    if (!k) return json(odp, 404, { code: 404, key: "not_found", message: "Not found" });
    const cialo = await czytajCialo(zad);
    const zmiana = cialo.points < 0 ? -Math.min(k.balance, -cialo.points) : cialo.points;
    k.balance += zmiana;
    if (zmiana > 0) k.points += zmiana;
    if (zmiana !== 0) k.operacje.push({ source_id: cialo.source_id, points: zmiana });
    return json(odp, 200, { points: zmiana, total: k.points, balance: k.balance, type: "loyalty_card", object: "balance" });
  }
  dopasowanie = /^\/v1\/loyalties\/members\/([^/]+)\/transactions$/.exec(m);
  if (dopasowanie && zad.method === "GET") {
    const k = poKodzie(decodeURIComponent(dopasowanie[1]));
    const lista = k ? k.operacje.map((o) => ({ source_id: o.source_id, details: { balance: { points: o.points } } })) : [];
    if (adres.searchParams.get("order") === "-id") lista.reverse();
    return json(odp, 200, { object: "list", data_ref: "data", data: lista, has_more: false });
  }
  json(odp, 404, { code: 404, key: "not_found", message: `Brak ${zad.method} ${m}` });
}).listen(PORT, () => console.log(`Sztuczny Voucherify na http://localhost:${PORT}`));
