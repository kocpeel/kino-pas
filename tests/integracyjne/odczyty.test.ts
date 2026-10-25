// Świeżość odczytów (repertuar, mapa) i koszt odpytywania: cache z unieważnianiem po zapisie,
// ograniczona nieświeżość między izolatami i warunkowe GET (ETag → 304).

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { utworzZegarTestowy } from "../../src/lib/czas";
import { obsluzListeSeansow, obsluzSzczegolySeansu } from "../../src/lib/http/trasy";
import type { SeansNaLiscie } from "../../src/lib/domain/typy";
import { kup, SEANS, TTL_MS, zadanieGet, zarezerwuj, zasiej, zaleznosci } from "./pomocnicze";

beforeEach(() => zasiej());

type Z = ReturnType<typeof zaleznosci>;

async function wolne(z: Z, eventId = SEANS): Promise<number> {
  const lista = (await (await obsluzListeSeansow(zadanieGet(), () => z)).json()) as SeansNaLiscie[];
  return lista.find((s) => s.id === eventId)!.freeSeats;
}

describe("repertuar: liczba wolnych miejsc", () => {
  it("rezerwacja (jeszcze nie kupiona) od razu zmniejsza liczbę wolnych w tym samym izolacie", async () => {
    const z = zaleznosci();
    expect(await wolne(z)).toBe(80); // lista trafia do cache izolatu
    expect((await zarezerwuj(z, { seatId: "A1" })).status).toBe(201);
    expect(await wolne(z)).toBe(79); // cache unieważniony przez zapis
  });

  it("inny izolat widzi zmianę najpóźniej po TTL cache listy (EVENTS_CACHE_SECONDS = 5)", async () => {
    const zegar = utworzZegarTestowy();
    const izolatA = zaleznosci({ zegar, zmienne: { EVENTS_CACHE_SECONDS: "5" } });
    const izolatB = zaleznosci({ zegar, zmienne: { EVENTS_CACHE_SECONDS: "5" } });
    expect(await wolne(izolatA)).toBe(80);
    await zarezerwuj(izolatB, { seatId: "A2" });
    zegar.przewin(4_999);
    expect(await wolne(izolatA)).toBe(80); // ograniczona nieświeżość: < 5 s
    zegar.przewin(1);
    expect(await wolne(izolatA)).toBe(79);
  });

  it("kupiony bilet też zajmuje miejsce, a wygasła rezerwacja wraca do puli", async () => {
    const zegar = utworzZegarTestowy();
    const z = zaleznosci({ zegar });
    const kupiona = await zarezerwuj(z, { seatId: "B1", email: "b1@example.com" });
    await kup(z, kupiona.cialo.reservationId);
    await zarezerwuj(z, { seatId: "B2", email: "b2@example.com" });
    expect(await wolne(z)).toBe(78);
    zegar.przewin(TTL_MS);
    expect(await wolne(z)).toBe(79); // B2 wygasła bez udziału Crona
  });
});

describe("warunkowe GET (ETag / 304)", () => {
  it("mapa: ten sam stan → 304 bez treści; po rezerwacji → 200 z nowym ETagiem", async () => {
    const z = zaleznosci();
    const pierwsza = await obsluzSzczegolySeansu(zadanieGet(`/api/events/${SEANS}`), () => z, SEANS);
    const etag = pierwsza.headers.get("etag")!;
    expect(pierwsza.status).toBe(200);
    expect(etag).toBeTruthy();

    const bezZmian = await obsluzSzczegolySeansu(
      zadanieGet(`/api/events/${SEANS}`, { "if-none-match": etag }),
      () => z,
      SEANS,
    );
    expect(bezZmian.status).toBe(304);
    expect(await bezZmian.text()).toBe("");
    expect(bezZmian.headers.get("etag")).toBe(etag);

    await zarezerwuj(z, { seatId: "C1" });
    const poZmianie = await obsluzSzczegolySeansu(
      zadanieGet(`/api/events/${SEANS}`, { "if-none-match": etag }),
      () => z,
      SEANS,
    );
    expect(poZmianie.status).toBe(200);
    expect(poZmianie.headers.get("etag")).not.toBe(etag);
    expect(((await poZmianie.json()) as { takenSeats: string[] }).takenSeats).toEqual(["C1"]);
  });

  it("ETag nie zależy od kolejności rezerwacji (posortowane takenSeats)", async () => {
    const z1 = zaleznosci();
    await zarezerwuj(z1, { seatId: "D2", email: "d2@example.com" });
    await zarezerwuj(z1, { seatId: "D1", email: "d1@example.com" });
    const a = (await obsluzSzczegolySeansu(zadanieGet(), () => zaleznosci(), SEANS)).headers.get("etag");
    const b = (await obsluzSzczegolySeansu(zadanieGet(), () => zaleznosci(), SEANS)).headers.get("etag");
    expect(a).toBe(b);
  });

  it("lista: If-None-Match z aktualnym ETagiem → 304", async () => {
    const z = zaleznosci();
    const etag = (await obsluzListeSeansow(zadanieGet(), () => z)).headers.get("etag")!;
    const odp = await obsluzListeSeansow(zadanieGet("/api/events", { "if-none-match": `"inny", ${etag}` }), () => z);
    expect(odp.status).toBe(304);
  });
});

describe("koszt zapytań", () => {
  it("odczyt zajętych foteli korzysta z indeksu (eventId, status, expiresAt), a nie skanu sali", async () => {
    const plan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT seatId FROM seats
        WHERE eventId = ?2 AND status IN ('purchased', 'reserved') AND (status = 'purchased' OR expiresAt > ?1)`,
    )
      .bind(0, SEANS)
      .all<{ detail: string }>();
    expect(plan.results.map((w) => w.detail).join(" ")).toMatch(/USING COVERING INDEX seats_event_status_expires_idx/);
  });
});
