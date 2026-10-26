import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { utworzZegarTestowy } from "../../src/lib/czas";
import { obsluzListeSeansow, obsluzRezerwacje, obsluzSzczegolySeansu, obsluzZakup } from "../../src/lib/http/trasy";
import type { Limiter } from "../../src/lib/resilience/limit-zapytan";
import { StraznikPrzeciazenia } from "../../src/lib/resilience/przeciazenie";
import {
  kup,
  SEANS,
  zadanieGet,
  zadanieZakupu,
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

/** Ten sam skrót klucza co w limit-zapytan.ts (pierwsze 16 bajtów SHA-256, hex). */
async function skrotTestowy(tekst: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tekst)));
  return Array.from(hash.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

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

  // Pełna ścieżka Workera z prawdziwym Durable Objectem `LimiterZadan` (limit 3 próby/min na IP i na e-mail,
  // 5 rezerwacji na IP w czasie TTL; wrangler.test.jsonc). Bindingi Rate Limiting są tu luźne.
  const wyslij = (seatId: string, email: string, ip: string) =>
    exports.default.fetch(zadanieRezerwacji({ seatId, email }, { ip }));

  it("ścisły limiter (Durable Object): 20 równoległych prób z jednego IP → dokładnie 3 przechodzą", async () => {
    const odpowiedzi = await Promise.all(
      Array.from({ length: 20 }, (_, i) => wyslij(`B${(i % 10) + 1}`, `rownolegle${i}@example.com`, "9.9.9.9")),
    );
    const statusy = odpowiedzi.map((o) => o.status);
    expect(statusy.filter((s) => s !== 429)).toHaveLength(3);
    for (const odp of odpowiedzi.filter((o) => o.status === 429)) {
      const ponow = Number(odp.headers.get("retry-after"));
      expect(ponow).toBeGreaterThanOrEqual(1);
      expect(ponow).toBeLessThanOrEqual(60);
    }
    // Inny adres ma własny limit.
    expect((await wyslij("C1", "inny-adres@example.com", "8.8.8.8")).status).toBe(201);
  });

  it("ścisły limiter: limit na e-mail działa niezależnie od IP", async () => {
    const statusy: number[] = [];
    for (let i = 1; i <= 4; i++) statusy.push((await wyslij(`D${i}`, "ten-sam@example.com", `10.9.0.${i}`)).status);
    // Czwarta: limit prób na e-mail (3/min); limit aktywnych rezerwacji (4) jeszcze by przepuścił.
    expect(statusy).toEqual([201, 201, 201, 429]);
  });

  it("jeden adres IP nie trzyma więcej foteli niż limit rezerwacji w czasie TTL (5 na 120 s)", async () => {
    // Pięć rezerwacji z ostatnich 120 s, ale żadnej z ostatniej minuty: limit minutowy by przepuścił.
    const teraz = Date.now();
    const obiekt = env.LIMITER!.get(env.LIMITER!.idFromName(`rezerwacje:ip:${await skrotTestowy("7.7.7.7")}`));
    await runInDurableObject(obiekt, (_instancja, stan) =>
      stan.storage.put("trafienia", [teraz - 100_000, teraz - 90_000, teraz - 80_000, teraz - 70_000, teraz - 65_000]),
    );
    const odp = await wyslij("E1", "ttl@example.com", "7.7.7.7");
    expect(odp.status).toBe(429);
    // Miejsce zwolni się, gdy najstarsza z pięciu (sprzed 100 s) wypadnie z okna 120 s.
    expect(Number(odp.headers.get("retry-after"))).toBeGreaterThanOrEqual(19);
    expect(Number(odp.headers.get("retry-after"))).toBeLessThanOrEqual(21);
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

    const lista = await obsluzListeSeansow(zadanieGet(), () => z);
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
    expect((await obsluzListeSeansow(zadanieGet(), () => z)).status).toBe(200);
    zegar.przewin(61_000); // cache już nieświeży
    const zajete = [straznik.wejdz("zakup"), straznik.wejdz("zakup"), straznik.wejdz("zakup")];
    const odp = await obsluzListeSeansow(zadanieGet(), () => z);
    expect(odp.status).toBe(200);
    expect(odp.headers.get("x-data-stale")).toBe("true");
    zajete.forEach((zwolnij) => zwolnij());
  });
});

describe("awaria bazy", () => {
  it("lista seansów z cache z oznaczeniem: dane sprzed chwili", async () => {
    const zegar = utworzZegarTestowy();
    const z = zaleznosci({ zegar });
    const swieza = await obsluzListeSeansow(zadanieGet(), () => z);
    const dane = await swieza.json();
    expect(swieza.headers.get("x-data-stale")).toBeNull();

    zegar.przewin(5 * 60_000);
    const awaria = { ...z, db: zepsutaBaza() };
    const zCache = await obsluzListeSeansow(zadanieGet(), () => awaria);
    expect(zCache.status).toBe(200);
    expect(zCache.headers.get("x-data-stale")).toBe("true");
    expect(zCache.headers.get("cache-control")).toBe("no-store");
    expect(await zCache.json()).toEqual(dane);
  });

  it("bez cache lista → 503, nie 500", async () => {
    const z = zaleznosci({ db: zepsutaBaza() });
    const odp = await obsluzListeSeansow(zadanieGet(), () => z);
    expect(odp.status).toBe(503);
    expect(odp.headers.get("retry-after")).not.toBeNull();
  });

  it("rezerwacja i zakup przy awarii bazy → 503, nie 500", async () => {
    const z = zaleznosci({ db: zepsutaBaza() });
    const rezerwacja = await zarezerwuj(z, { seatId: "E1" });
    expect(rezerwacja.status).toBe(503);
    expect(rezerwacja.cialo.error).toBe("unavailable");
    expect((await kup(z, "0f8fad5b-d9cb-469f-a165-70867728950e")).status).toBe(503);
    expect((await obsluzSzczegolySeansu(zadanieGet(), () => z, SEANS)).status).toBe(503);
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
    expect((await obsluzZakup(zadanieZakupu("abc"), z, "abc")).status).toBe(400);
    const nieznana = "0f8fad5b-d9cb-469f-a165-70867728950e";
    expect((await obsluzZakup(zadanieZakupu(nieznana), z, nieznana)).status).toBe(410);
  });

  it("nieistniejący seans w szczegółach → 404", async () => {
    expect((await obsluzSzczegolySeansu(zadanieGet(), z, "nie-ma")).status).toBe(404);
    expect((await obsluzSzczegolySeansu(zadanieGet(), z, "../../etc/passwd")).status).toBe(404);
  });
});

describe("prywatność", () => {
  it("odczyty nie zawierają imion ani e-maili innych klientów", async () => {
    const zz = zaleznosci();
    await zarezerwuj(zz, { seatId: "F1", name: "Tajemnicza Osoba", email: "tajne@example.com" });
    const r = await zarezerwuj(zz, { seatId: "F2", name: "Inna Osoba", email: "inna@example.com" });
    await kup(zz, r.cialo.reservationId);
    zz.cache.szczegoly.wyczysc();

    const szczegoly = await (await obsluzSzczegolySeansu(zadanieGet(), () => zz, SEANS)).text();
    const lista = await (await obsluzListeSeansow(zadanieGet(), () => zz)).text();
    for (const tekst of [szczegoly, lista]) {
      expect(tekst).not.toMatch(/Tajemnicza|Inna Osoba|tajne@|inna@|reservationId|code/);
    }
    expect(JSON.parse(szczegoly).takenSeats.sort()).toEqual(["F1", "F2"]);
  });

  it("baza testowa jest dostępna (sanity check środowiska)", () => {
    expect(env.DB).toBeDefined();
  });
});
