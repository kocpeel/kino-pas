import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { utworzZegarTestowy } from "../../src/lib/czas";
import { obsluzListeSeansow, obsluzRezerwacje, obsluzSzczegolySeansu, obsluzZakup } from "../../src/lib/http/trasy";
import type { Limiter } from "../../src/lib/resilience/limit-zapytan";
import { StraznikPrzeciazenia } from "../../src/lib/resilience/przeciazenie";
import {
  kup,
  SEANS,
  zadanieRezerwacji,
  zarezerwuj,
  zasiej,
  zaleznosci,
  zawieszonaBaza,
  zepsutaBaza,
} from "./pomocnicze";

beforeEach(async () => {
  await zasiej();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

/** Limiter z oknem stałym liczonym zegarem testowym (do testu „po oknie znowu działa"). */
function limiterOkienny(limit: number, okresMs: number, teraz: () => number): Limiter {
  const okna = new Map<string, { start: number; ile: number }>();
  return {
    async limit({ key }) {
      const t = teraz();
      const okno = okna.get(key);
      if (!okno || t - okno.start >= okresMs) {
        okna.set(key, { start: t, ile: 1 });
        return { success: true };
      }
      okno.ile++;
      return { success: okno.ile <= limit };
    },
  };
}

describe("rate limiting", () => {
  it("przekroczenie → 429 z Retry-After; po oknie znowu działa; inni klienci nie są blokowani", async () => {
    const zegar = utworzZegarTestowy();
    const z = zaleznosci({ zegar, limitery: { ip: limiterOkienny(2, 60_000, zegar.teraz) } });
    const zIp = (seatId: string, ip: string, email: string) => zarezerwuj(z, { seatId, email }, { ip });

    expect((await zIp("A1", "1.1.1.1", "a1@example.com")).status).toBe(201);
    expect((await zIp("A2", "1.1.1.1", "a2@example.com")).status).toBe(201);
    const odmowa = await zIp("A3", "1.1.1.1", "a3@example.com");
    expect(odmowa.status).toBe(429);
    expect(odmowa.naglowki.get("retry-after")).toBe("60");
    expect(odmowa.cialo.error).toBe("rate_limited");

    expect((await zIp("A4", "2.2.2.2", "b@example.com")).status).toBe(201);

    zegar.przewin(60_000);
    expect((await zIp("A3", "1.1.1.1", "a3@example.com")).status).toBe(201);
  });

  it("prawdziwy binding Rate Limiting (Miniflare) przez pełną ścieżkę Workera", async () => {
    const wyslij = (seatId: string, email: string, ip: string) =>
      exports.default.fetch(zadanieRezerwacji({ seatId, email }, { ip }));
    const statusy: number[] = [];
    for (let i = 1; i <= 4; i++) statusy.push((await wyslij(`B${i}`, `rl${i}@example.com`, "9.9.9.9")).status);
    expect(statusy).toEqual([201, 201, 201, 429]);
    const inny = await wyslij("B5", "rl5@example.com", "8.8.8.8");
    expect(inny.status).toBe(201);
  });

  it("limit na e-mail niezależny od IP", async () => {
    const zegar = utworzZegarTestowy();
    const z = zaleznosci({ zegar, limitery: { email: limiterOkienny(1, 60_000, zegar.teraz) } });
    expect((await zarezerwuj(z, { seatId: "C1", email: "jeden@example.com" }, { ip: "1.0.0.1" })).status).toBe(201);
    expect((await zarezerwuj(z, { seatId: "C2", email: "jeden@example.com" }, { ip: "1.0.0.2" })).status).toBe(429);
  });
});

describe("load shedding", () => {
  it("przy przeciążeniu: rezerwacja 503 + Retry-After, a zakup nadal przechodzi", async () => {
    const straznik = new StraznikPrzeciazenia({ maxOdczytow: 4, maxZapisow: 4 });
    const z = zaleznosci({ straznik });
    const r = await zarezerwuj(z, { seatId: "D1" });
    // Symulowane obciążenie: 3 zapisy w toku (≥ 75% puli).
    const zajete = [straznik.wejdz("zakup"), straznik.wejdz("zakup"), straznik.wejdz("zakup")];

    const odrzucona = await zarezerwuj(z, { seatId: "D2" });
    expect(odrzucona.status).toBe(503);
    expect(odrzucona.cialo.error).toBe("overloaded");
    expect(odrzucona.naglowki.get("retry-after")).toBe("2");

    const lista = await obsluzListeSeansow(() => z);
    expect(lista.status).toBe(503);

    const zakup = await kup(z, r.cialo.reservationId);
    expect(zakup.status).toBe(201);

    zajete.forEach((zwolnij) => zwolnij());
    expect(straznik.stan()).toEqual({ odczytyWToku: 0, zapisyWToku: 0 });
  });

  it("przeciążona lista oddaje dane z cache zamiast 503, jeśli je ma", async () => {
    const straznik = new StraznikPrzeciazenia({ maxOdczytow: 4, maxZapisow: 4 });
    const zegar = utworzZegarTestowy();
    const z = zaleznosci({ straznik, zegar });
    expect((await obsluzListeSeansow(() => z)).status).toBe(200);
    zegar.przewin(61_000); // cache już nieświeży
    const zajete = [straznik.wejdz("zakup"), straznik.wejdz("zakup"), straznik.wejdz("zakup")];
    const odp = await obsluzListeSeansow(() => z);
    expect(odp.status).toBe(200);
    expect(odp.headers.get("x-data-stale")).toBe("true");
    zajete.forEach((zwolnij) => zwolnij());
  });
});

describe("awaria bazy", () => {
  it("lista seansów z cache z oznaczeniem: dane sprzed chwili", async () => {
    const zegar = utworzZegarTestowy();
    const z = zaleznosci({ zegar });
    const swieza = await obsluzListeSeansow(() => z);
    const dane = await swieza.json();
    expect(swieza.headers.get("x-data-stale")).toBeNull();

    zegar.przewin(5 * 60_000);
    const awaria = { ...z, db: zepsutaBaza() };
    const zCache = await obsluzListeSeansow(() => awaria);
    expect(zCache.status).toBe(200);
    expect(zCache.headers.get("x-data-stale")).toBe("true");
    expect(zCache.headers.get("cache-control")).toBe("no-store");
    expect(await zCache.json()).toEqual(dane);
  });

  it("bez cache lista → 503, nie 500", async () => {
    const z = zaleznosci({ db: zepsutaBaza() });
    const odp = await obsluzListeSeansow(() => z);
    expect(odp.status).toBe(503);
    expect(odp.headers.get("retry-after")).not.toBeNull();
  });

  it("rezerwacja i zakup przy awarii bazy → 503, nie 500", async () => {
    const z = zaleznosci({ db: zepsutaBaza() });
    const rezerwacja = await zarezerwuj(z, { seatId: "E1" });
    expect(rezerwacja.status).toBe(503);
    expect(rezerwacja.cialo.error).toBe("unavailable");
    expect((await kup(z, "0f8fad5b-d9cb-469f-a165-70867728950e")).status).toBe(503);
    expect((await obsluzSzczegolySeansu(() => z, SEANS)).status).toBe(503);
  });

  it("brak bindingu D1 → 503", async () => {
    const z = zaleznosci({ db: undefined });
    expect((await zarezerwuj(z, { seatId: "E1" })).status).toBe(503);
  });

  it("zawieszona baza: żądanie kończy się 503 po timeoucie, nie wisi", async () => {
    const z = zaleznosci({ db: zawieszonaBaza(), zmienne: { DB_TIMEOUT_MS: "100" } });
    const start = Date.now();
    const odp = await zarezerwuj(z, { seatId: "E2" });
    expect(odp.status).toBe(503);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(z.straznik.stan().zapisyWToku).toBe(0);
  });
});

describe("błędne wejście → kontrolowane 4xx, nigdy 500", () => {
  const z = () => zaleznosci();
  const post = (body: BodyInit | null, naglowki: Record<string, string> = { "content-type": "application/json" }) =>
    obsluzRezerwacje(new Request("https://kasa.test/api/reservations", { method: "POST", headers: naglowki, body }), z);

  it.each([
    ["zły JSON", "{bad", 400],
    ["tablica zamiast obiektu", "[]", 400],
    ["null", "null", 400],
    ["brak pól", "{}", 400],
    ["złe typy", JSON.stringify({ eventId: 1, seatId: 2, name: [], email: {} }), 400],
    ["nieznany fotel", JSON.stringify({ eventId: SEANS, seatId: "Z99", name: "Jan", email: "jan@example.com" }), 400],
    [
      "nieistniejący seans",
      JSON.stringify({ eventId: "nie-ma-takiego", seatId: "A1", name: "Jan", email: "jan@example.com" }),
      404,
    ],
    ["za duże ciało", JSON.stringify({ eventId: SEANS, seatId: "A1", name: "x".repeat(10_000), email: "a@b.pl" }), 413],
  ])("%s → %i", async (_opis, cialo, oczekiwany) => {
    const odp = await post(cialo);
    expect(odp.status).toBe(oczekiwany);
    const json = (await odp.json()) as { error: string; message: string };
    expect(typeof json.error).toBe("string");
    expect(typeof json.message).toBe("string");
  });

  it("zły Content-Type → 400", async () => {
    expect((await post("eventId=x", { "content-type": "application/x-www-form-urlencoded" })).status).toBe(400);
  });

  it("zły Idempotency-Key → 400", async () => {
    const odp = await post(JSON.stringify({ eventId: SEANS, seatId: "A1", name: "Jan", email: "jan@example.com" }), {
      "content-type": "application/json",
      "idempotency-key": "bad key!",
    });
    expect(odp.status).toBe(400);
  });

  it("zły identyfikator rezerwacji przy zakupie → 400, nieznany → 410", async () => {
    expect((await obsluzZakup(z, "abc")).status).toBe(400);
    expect((await obsluzZakup(z, "0f8fad5b-d9cb-469f-a165-70867728950e")).status).toBe(410);
  });

  it("nieistniejący seans w szczegółach → 404", async () => {
    expect((await obsluzSzczegolySeansu(z, "nie-ma")).status).toBe(404);
    expect((await obsluzSzczegolySeansu(z, "../../etc/passwd")).status).toBe(404);
  });
});

describe("prywatność", () => {
  it("odczyty nie zawierają imion ani e-maili innych klientów", async () => {
    const zz = zaleznosci();
    await zarezerwuj(zz, { seatId: "F1", name: "Tajemnicza Osoba", email: "tajne@example.com" });
    const r = await zarezerwuj(zz, { seatId: "F2", name: "Inna Osoba", email: "inna@example.com" });
    await kup(zz, r.cialo.reservationId);
    zz.cache.szczegoly.wyczysc();

    const szczegoly = await (await obsluzSzczegolySeansu(() => zz, SEANS)).text();
    const lista = await (await obsluzListeSeansow(() => zz)).text();
    for (const tekst of [szczegoly, lista]) {
      expect(tekst).not.toMatch(/Tajemnicza|Inna Osoba|tajne@|inna@|reservationId|code/);
    }
    expect(JSON.parse(szczegoly).takenSeats.sort()).toEqual(["F1", "F2"]);
  });

  it("baza testowa jest dostępna (sanity check środowiska)", () => {
    expect(env.DB).toBeDefined();
  });
});
