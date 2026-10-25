// Test obciążeniowy W1 na środowisku testowym w Cloudflare (prawdziwe opóźnienia sieci i D1).
// Kryterium zaliczenia: dla jednego fotela dokładnie jedno 201, reszta 409 (zero 5xx).
//
// Uruchomienie (k6: https://k6.io):
//   k6 run -e BASE_URL=https://kasa-kino.<konto>.workers.dev -e EVENT_ID=metropolis-2026-11-06 -e SEAT_ID=H10 \
//     tests/obciazenie/w1-ten-sam-fotel.js
// Uwaga: ścisły limit prób na IP (LimiterZadan) odrzuci na produkcji część żądań z jednej maszyny jako 429.
// Uruchamiaj na środowisku `staging` (limity wyłączone) albo z kilku maszyn. Bez k6: npm run test:obciazenie.

import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://127.0.0.1:8787";
const EVENT_ID = __ENV.EVENT_ID || "metropolis-2026-11-06";
const SEAT_ID = __ENV.SEAT_ID || "H10";

const sukcesy = new Counter("rezerwacje_201");
const konflikty = new Counter("rezerwacje_409");
const bledySerwera = new Counter("rezerwacje_5xx");

export const options = {
  scenarios: {
    w1: { executor: "per-vu-iterations", vus: 50, iterations: 1, maxDuration: "30s" },
  },
  thresholds: {
    rezerwacje_201: ["count==1"],
    rezerwacje_5xx: ["count==0"],
    http_req_duration: ["p(95)<1500"],
  },
};

export default function () {
  const odp = http.post(
    `${BASE_URL}/api/reservations`,
    JSON.stringify({ eventId: EVENT_ID, seatId: SEAT_ID, name: "Obciazenie", email: `k6-${__VU}@example.com` }),
    { headers: { "Content-Type": "application/json", "Idempotency-Key": `k6-w1-${__VU}-${Date.now()}` } },
  );
  if (odp.status === 201) sukcesy.add(1);
  if (odp.status === 409) konflikty.add(1);
  if (odp.status >= 500) bledySerwera.add(1);
  check(odp, { "201 albo 409 (albo 429 z limitu IP)": (r) => [201, 409, 429].includes(r.status) });
}
