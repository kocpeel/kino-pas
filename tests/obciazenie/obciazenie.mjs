// Test obciążeniowy na środowisku w Cloudflare (prawdziwe opóźnienia sieci i D1), bez dodatkowych narzędzi.
// Zachowuje się jak prawdziwi klienci: każdy ma własny Idempotency-Key, a po 503 z Retry-After ponawia
// z tym samym kluczem. Sprawdza niezmienniki, nie tylko statusy:
//   W1  50 osób naraz o jeden fotel        → dokładnie jedna rezerwacja, reszta 409, zero 500
//   W2  80 osób naraz o 80 różnych foteli   → 80 rezerwacji, sala pełna, zero 500
//   W3  20 równoległych zakupów jednej rezerwacji → jeden 201, reszta 200 z tym samym kodem
//   R   odczyty: 600 GET listy i mapy, 100 naraz → zero 500, czasy p50/p95
//
// Uruchomienie (świeże dane: npm run staging:db):
//   BASE_URL=https://kasa-kino-staging.<konto>.workers.dev npm run test:obciazenie
// Kod wyjścia 1, gdy którykolwiek niezmiennik nie jest spełniony.

const BASE_URL = (process.env.BASE_URL || "http://localhost:8790").replace(/\/$/, "");
const MAKS_PONOWIEN = 8;

const przebieg = Date.now().toString(36);
let numer = 0;
const unikalny = (prefiks) => `${prefiks}-${przebieg}-${++numer}`;

function percentyl(wartosci, p) {
  const posortowane = [...wartosci].sort((a, b) => a - b);
  return posortowane[Math.min(posortowane.length - 1, Math.floor((p / 100) * posortowane.length))] ?? 0;
}

const czekaj = (ms) => new Promise((r) => setTimeout(r, ms));

/** Jedno żądanie z pomiarem czasu. */
async function zadanie(sciezka, init = {}) {
  const start = performance.now();
  const odp = await fetch(`${BASE_URL}${sciezka}`, init);
  const tekst = await odp.text();
  let cialo = null;
  try {
    cialo = JSON.parse(tekst);
  } catch {}
  return { status: odp.status, cialo, naglowki: odp.headers, ms: performance.now() - start };
}

/** Rezerwacja jak w przeglądarce: ten sam klucz przy ponowieniach po 503 (i po błędzie sieci). */
async function rezerwuj(eventId, seatId, statystyki) {
  const klucz = unikalny("obc");
  const body = JSON.stringify({ eventId, seatId, name: "Test Obciazenia", email: `${klucz}@example.com` });
  for (let proba = 0; ; proba++) {
    let wynik;
    try {
      wynik = await zadanie("/api/reservations", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": klucz },
        body,
      });
    } catch (blad) {
      statystyki.sieciowe++;
      if (proba >= MAKS_PONOWIEN) return { status: 0, blad };
      await czekaj(500);
      continue;
    }
    statystyki.czasy.push(wynik.ms);
    statystyki.statusy[wynik.status] = (statystyki.statusy[wynik.status] ?? 0) + 1;
    if (wynik.status === 503 && proba < MAKS_PONOWIEN) {
      const ponowZa = Number(wynik.naglowki.get("retry-after") || "1");
      await czekaj(ponowZa * 1000 * (0.5 + Math.random()));
      continue;
    }
    return { ...wynik, ciasteczko: wynik.naglowki.get("set-cookie")?.split(";")[0] ?? null };
  }
}

function noweStatystyki() {
  return { statusy: {}, czasy: [], sieciowe: 0 };
}

const wyniki = [];
function sprawdz(scenariusz, warunek, opis) {
  wyniki.push({ scenariusz, ok: Boolean(warunek), opis });
}

function opisStatystyk(s) {
  const statusy = Object.entries(s.statusy)
    .map(([k, v]) => `${k}×${v}`)
    .join(", ");
  return `${statusy}${s.sieciowe ? `, błędy sieci×${s.sieciowe}` : ""}; p50 ${percentyl(s.czasy, 50).toFixed(0)} ms, p95 ${percentyl(s.czasy, 95).toFixed(0)} ms`;
}

async function rozgrzej(seanse) {
  // Otwiera połączenia keep-alive, żeby właściwe żądania wyszły naprawdę naraz.
  await Promise.all(Array.from({ length: 50 }, (_, i) => zadanie(`/api/events/${seanse[i % seanse.length].id}`)));
}

async function w1(seans) {
  const s = noweStatystyki();
  const odpowiedzi = await Promise.all(Array.from({ length: 50 }, () => rezerwuj(seans.id, "H10", s)));
  const koncowe = odpowiedzi.map((o) => o.status);
  const sukcesy = koncowe.filter((k) => k === 201).length;
  sprawdz("W1", sukcesy === 1, `50 naraz o fotel H10: rezerwacji ${sukcesy} (ma być 1)`);
  sprawdz("W1", koncowe.every((k) => k === 201 || k === 409), `odpowiedzi końcowe tylko 201/409: ${[...new Set(koncowe)].join(", ")}`);
  sprawdz("W1", !s.statusy[500], `zero 500 (wszystkie odpowiedzi: ${opisStatystyk(s)})`);
  const sala = await zadanie(`/api/events/${seans.id}`);
  sprawdz("W1", sala.cialo?.takenSeats?.includes("H10"), "mapa pokazuje H10 jako zajęty");
}

async function w2(seans) {
  const s = noweStatystyki();
  const fotele = [];
  for (const rzad of "ABCDEFGH") for (let m = 1; m <= 10; m++) fotele.push(`${rzad}${m}`);
  const odpowiedzi = await Promise.all(fotele.map((f) => rezerwuj(seans.id, f, s)));
  const sukcesy = odpowiedzi.filter((o) => o.status === 201).length;
  sprawdz("W2", sukcesy === 80, `80 naraz o różne fotele: rezerwacji ${sukcesy} (ma być 80)`);
  sprawdz("W2", !s.statusy[500], `zero 500 (${opisStatystyk(s)})`);
  const sala = await zadanie(`/api/events/${seans.id}`);
  sprawdz("W2", sala.cialo?.takenSeats?.length === 80, `mapa: zajętych ${sala.cialo?.takenSeats?.length} z 80`);
  // Lista ma cache do 5 s (izolat i krawędź), więc sprawdzamy ją po tym czasie.
  await czekaj(6000);
  const lista = await zadanie("/api/events");
  const naLiscie = lista.cialo?.find?.((e) => e.id === seans.id);
  sprawdz("W2", naLiscie?.freeSeats === 0, `repertuar po 6 s: wolnych ${naLiscie?.freeSeats} (ma być 0)`);
}

async function w3(seans) {
  const s = noweStatystyki();
  const r = await rezerwuj(seans.id, "A1", noweStatystyki());
  if (r.status !== 201) {
    sprawdz("W3", false, `nie udało się zarezerwować A1 do testu zakupu (status ${r.status})`);
    return;
  }
  const { reservationId } = r.cialo;
  const zakupy = await Promise.all(
    Array.from({ length: 20 }, async () => {
      for (let proba = 0; ; proba++) {
        const z = await zadanie(`/api/reservations/${reservationId}/purchase`, {
          method: "POST",
          headers: { cookie: r.ciasteczko },
        });
        s.czasy.push(z.ms);
        s.statusy[z.status] = (s.statusy[z.status] ?? 0) + 1;
        if (z.status === 503 && proba < MAKS_PONOWIEN) {
          await czekaj(Number(z.naglowki.get("retry-after") || "1") * 1000 * (0.5 + Math.random()));
          continue;
        }
        return z;
      }
    }),
  );
  const pierwsze = zakupy.filter((z) => z.status === 201).length;
  const kody = new Set(zakupy.filter((z) => z.status === 200 || z.status === 201).map((z) => z.cialo?.code));
  sprawdz("W3", pierwsze === 1, `20 równoległych zakupów: 201 × ${pierwsze} (ma być 1)`);
  sprawdz("W3", kody.size === 1 && zakupy.every((z) => z.status === 200 || z.status === 201), `jeden kod dla wszystkich: ${[...kody].join(", ")} (${opisStatystyk(s)})`);
  const obcy = await zadanie(`/api/reservations/${reservationId}/purchase`, { method: "POST" });
  sprawdz("W3", obcy.status === 403 && !JSON.stringify(obcy.cialo).includes([...kody][0]), `zakup bez ciasteczka: ${obcy.status} bez kodu`);
}

async function odczyty(seanse) {
  const s = noweStatystyki();
  const sciezki = Array.from({ length: 600 }, (_, i) => (i % 3 === 0 ? "/api/events" : `/api/events/${seanse[i % seanse.length].id}`));
  let i = 0;
  await Promise.all(
    Array.from({ length: 100 }, async () => {
      while (i < sciezki.length) {
        const sciezka = sciezki[i++];
        try {
          const w = await zadanie(sciezka);
          s.czasy.push(w.ms);
          s.statusy[w.status] = (s.statusy[w.status] ?? 0) + 1;
        } catch {
          s.sieciowe++;
        }
      }
    }),
  );
  sprawdz("R", !s.statusy[500] && s.sieciowe === 0, `600 odczytów, 100 naraz: ${opisStatystyk(s)}`);
}

const start = Date.now();
console.log(`Test obciążeniowy: ${BASE_URL}`);
const zdrowie = await zadanie("/api/zdrowie");
console.log(`/api/zdrowie: ${zdrowie.status} ${JSON.stringify(zdrowie.cialo)}`);
const seanse = (await zadanie("/api/events")).cialo;
if (!Array.isArray(seanse) || seanse.length < 3) {
  console.error("Brak 3 seansów: najpierw `npm run staging:db`.");
  process.exit(1);
}
await rozgrzej(seanse);
await w1(seanse[0]);
await w2(seanse[1]);
await w3(seanse[2]);
await odczyty(seanse);

for (const w of wyniki) console.log(`${w.ok ? "✔" : "✘"} ${w.scenariusz}: ${w.opis}`);
const nieudane = wyniki.filter((w) => !w.ok).length;
console.log(`\n${wyniki.length - nieudane}/${wyniki.length} niezmienników spełnionych w ${((Date.now() - start) / 1000).toFixed(1)} s.`);
process.exit(nieudane ? 1 : 0);
