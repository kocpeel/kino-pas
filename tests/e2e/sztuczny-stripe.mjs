// Sztuczny Stripe dla testów e2e: bez sieci i bez sekretów, więc działa też w CI. Serwer aplikacji rozmawia
// z nim przez prawdziwe SDK (host z STRIPE_API_BASE), a webhooki dostaje z prawdziwym podpisem.
// Trzyma reguły prawdziwego Stripe'a, zmierzone na sandboksie: klucz idempotencji daje tę samą sesję, ten sam
// klucz z innymi parametrami to błąd, sesja żyje co najmniej 30 minut, a wygasić można tylko otwartą.
//
// Strona płatności: GET /pay/:id z linkami „Zapłać kartą” i „Przerwij”. Testy sterują webhookiem parametrem:
//   ?webhook=opozniony&ms=1500  przekierowanie od razu, webhook później („płatność w toku…”)
//   ?webhook=podwojny           to samo zdarzenie dwa razy
//   ?webhook=brak               webhook zaginął
// GET /__stan pokazuje sesje i zwroty.

import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.SZTUCZNY_STRIPE_PORT || 8792);
const ADRES_WEBHOOKA = process.env.ADRES_WEBHOOKA;
const SEKRET_WEBHOOKA = process.env.STRIPE_WEBHOOK_SECRET;

const sesje = new Map();
const poKluczu = new Map();
const zwroty = [];
const webhooki = [];

function teraz() {
  return Math.floor(Date.now() / 1000);
}

function json(odp, status, dane) {
  odp.writeHead(status, { "content-type": "application/json", "request-id": `req_${randomUUID()}` });
  odp.end(JSON.stringify(dane));
}

function bladStripe(odp, status, type, message, code) {
  json(odp, status, { error: { type, message, ...(code ? { code } : {}) } });
}

function czytajCialo(zad) {
  return new Promise((rozwiaz) => {
    let tekst = "";
    zad.on("data", (k) => (tekst += k));
    zad.on("end", () => rozwiaz(tekst));
  });
}

function widokSesji(s) {
  return {
    id: s.id,
    object: "checkout.session",
    status: s.status,
    payment_status: s.paymentStatus,
    payment_intent: s.paymentIntent,
    client_reference_id: s.reservationId,
    amount_total: s.amount,
    currency: s.currency,
    expires_at: s.expiresAt,
    url: s.status === "open" ? `http://localhost:${PORT}/pay/${s.id}` : null,
  };
}

function utworzSesje(odp, klucz, cialo) {
  const p = new URLSearchParams(cialo);
  const poprzednia = klucz ? poKluczu.get(klucz) : undefined;
  if (poprzednia) {
    if (poprzednia.cialo !== cialo) {
      return bladStripe(odp, 400, "idempotency_error", "Keys for idempotent requests can only be used with the same parameters they were first used with.");
    }
    return json(odp, 200, poprzednia.odpowiedz);
  }
  const expiresAt = Number(p.get("expires_at"));
  if (expiresAt < teraz() + 30 * 60) {
    return bladStripe(odp, 400, "invalid_request_error", "The `expires_at` timestamp must be at least 30 minutes from Checkout Session creation.");
  }
  if (p.has("payment_method_types")) {
    return bladStripe(odp, 400, "invalid_request_error", "The `payment_method_types` parameter is no longer supported.");
  }
  const s = {
    id: `cs_test_${randomUUID().replaceAll("-", "")}`,
    status: "open",
    paymentStatus: "unpaid",
    paymentIntent: null,
    reservationId: p.get("client_reference_id"),
    amount: Number(p.get("line_items[0][price_data][unit_amount]")),
    currency: p.get("line_items[0][price_data][currency]"),
    nazwa: p.get("line_items[0][price_data][product_data][name]"),
    expiresAt,
    successUrl: p.get("success_url"),
    cancelUrl: p.get("cancel_url"),
  };
  sesje.set(s.id, s);
  const odpowiedz = widokSesji(s);
  if (klucz) poKluczu.set(klucz, { cialo, odpowiedz });
  json(odp, 200, odpowiedz);
}

async function wyslijWebhook(zdarzenie) {
  const cialo = JSON.stringify(zdarzenie);
  const t = teraz();
  const v1 = createHmac("sha256", SEKRET_WEBHOOKA).update(`${t}.${cialo}`).digest("hex");
  const odp = await fetch(ADRES_WEBHOOKA, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${v1}` },
    body: cialo,
  });
  webhooki.push({ id: zdarzenie.id, status: odp.status });
}

function zdarzenieOplacenia(s) {
  return {
    id: `evt_${randomUUID().replaceAll("-", "")}`,
    object: "event",
    type: "checkout.session.completed",
    created: teraz(),
    data: { object: widokSesji(s) },
  };
}

function stronaPlatnosci(odp, s) {
  odp.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  odp.end(`<!doctype html><html lang="pl"><title>Sztuczny Stripe</title><main>
    <h1>Sztuczny Stripe</h1><p>${s.nazwa}: ${s.amount / 100} ${s.currency}</p>
    ${
      s.status === "open"
        ? `<p><a href="/pay/${s.id}/oplac">Zapłać kartą</a></p><p><a href="/pay/${s.id}/przerwij">Przerwij</a></p>`
        : `<p>Ta sesja jest już zamknięta (${s.status}).</p>`
    }
  </main></html>`);
}

async function oplac(odp, s, zapytanie) {
  if (s.status !== "open") return stronaPlatnosci(odp, s);
  s.status = "complete";
  s.paymentStatus = "paid";
  s.paymentIntent = `pi_${randomUUID().replaceAll("-", "")}`;
  const zdarzenie = zdarzenieOplacenia(s);
  const tryb = zapytanie.get("webhook") ?? "od-razu";
  if (tryb === "opozniony") {
    setTimeout(() => void wyslijWebhook(zdarzenie), Number(zapytanie.get("ms") ?? 1500));
  } else if (tryb === "podwojny") {
    await wyslijWebhook(zdarzenie);
    await wyslijWebhook(zdarzenie);
  } else if (tryb !== "brak") {
    await wyslijWebhook(zdarzenie);
  }
  odp.writeHead(302, { location: s.successUrl.replace("{CHECKOUT_SESSION_ID}", s.id) });
  odp.end();
}

const serwer = createServer(async (zad, odp) => {
  const adres = new URL(zad.url, `http://localhost:${PORT}`);
  const m = adres.pathname;
  const cialo = await czytajCialo(zad);
  let t;

  if (zad.method === "POST" && m === "/v1/checkout/sessions") return utworzSesje(odp, zad.headers["idempotency-key"], cialo);
  if (zad.method === "POST" && m === "/v1/refunds") {
    const p = new URLSearchParams(cialo);
    const klucz = zad.headers["idempotency-key"];
    const poprzedni = zwroty.find((z) => z.klucz === klucz);
    if (!poprzedni) zwroty.push({ klucz, paymentIntent: p.get("payment_intent") });
    return json(odp, 200, { id: `re_${klucz}`, object: "refund", status: "succeeded" });
  }
  if ((t = /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/.exec(m)) && zad.method === "POST") {
    const s = sesje.get(t[1]);
    if (!s) return bladStripe(odp, 404, "invalid_request_error", "No such session", "resource_missing");
    if (s.status !== "open") {
      return bladStripe(odp, 400, "invalid_request_error", `Only Checkout Sessions with a status in ["open"] can be expired.`);
    }
    s.status = "expired";
    return json(odp, 200, widokSesji(s));
  }
  if ((t = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(m)) && zad.method === "GET") {
    const s = sesje.get(t[1]);
    if (!s) return bladStripe(odp, 404, "invalid_request_error", "No such session", "resource_missing");
    return json(odp, 200, widokSesji(s));
  }
  if ((t = /^\/pay\/([^/]+)\/oplac$/.exec(m))) return oplac(odp, sesje.get(t[1]), adres.searchParams);
  if ((t = /^\/pay\/([^/]+)\/przerwij$/.exec(m))) {
    odp.writeHead(302, { location: sesje.get(t[1]).cancelUrl });
    return odp.end();
  }
  if ((t = /^\/pay\/([^/]+)$/.exec(m))) return stronaPlatnosci(odp, sesje.get(t[1]));
  if (m === "/__stan") return json(odp, 200, { sesje: [...sesje.values()], zwroty, webhooki });
  bladStripe(odp, 404, "invalid_request_error", `Nieznana trasa: ${m}`);
});

serwer.listen(PORT, () => console.log(`Sztuczny Stripe na porcie ${PORT}`));
