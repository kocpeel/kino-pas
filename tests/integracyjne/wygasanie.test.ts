// Wygasanie jest leniwe: o ważności decyduje porównanie expiresAt z czasem żądania.
// Cron tylko sprząta, więc wszystkie te testy przechodzą bez uruchamiania crona.

import { createScheduledController, createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { utworzZegarTestowy } from "../../src/lib/czas";
import { zwolnijWygasleRezerwacje } from "../../src/lib/db/zapytania-miejsca";
import { obsluzSzczegolySeansu } from "../../src/lib/http/trasy";
import cron, { sprzataj } from "../../workers/sprzatanie/src/index";
import { kup, SEANS, TTL_MS, wierszMiejsca, zarezerwuj, zasiej, zaleznosci } from "./pomocnicze";

beforeEach(() => zasiej());

async function zajete(z: ReturnType<typeof zaleznosci>): Promise<string[]> {
  z.cache.szczegoly.wyczysc();
  const odp = await obsluzSzczegolySeansu(() => z, SEANS);
  return ((await odp.json()) as { takenSeats: string[] }).takenSeats;
}

describe("granica ważności", () => {
  it("rezerwacja jest ważna do expiresAt − 1 ms, a od expiresAt wygasła", async () => {
    const zegar = utworzZegarTestowy();
    const z = zaleznosci({ zegar });
    const { cialo } = await zarezerwuj(z, { seatId: "D4" });
    expect(cialo.expiresAt).toBe(zegar.teraz() + TTL_MS);

    zegar.ustaw(cialo.expiresAt - 1);
    expect(await zajete(z)).toContain("D4");
    expect((await zarezerwuj(z, { seatId: "D4", email: "inny@example.com" })).status).toBe(409);

    zegar.ustaw(cialo.expiresAt);
    expect(await zajete(z)).not.toContain("D4");
  });

  it("zakup po wygaśnięciu → 410 z komunikatem o powrocie fotela do puli", async () => {
    const zegar = utworzZegarTestowy();
    const z = zaleznosci({ zegar });
    const { cialo } = await zarezerwuj(z, { seatId: "D5" });
    zegar.przewin(TTL_MS + 1);
    const zakup = await kup(z, cialo.reservationId);
    expect(zakup.status).toBe(410);
    expect(zakup.cialo).toEqual({ error: "reservation_expired", message: "Rezerwacja wygasła, fotel wrócił do puli." });
  });

  it("po wygaśnięciu fotel można zarezerwować ponownie, a stary reservationId nie kupi nowej rezerwacji", async () => {
    const zegar = utworzZegarTestowy();
    const z = zaleznosci({ zegar });
    const stara = await zarezerwuj(z, { seatId: "D6", email: "stary@example.com" });
    zegar.przewin(TTL_MS);
    const nowa = await zarezerwuj(z, { seatId: "D6", email: "nowy@example.com" });
    expect(nowa.status).toBe(201);
    expect(nowa.cialo.reservationId).not.toBe(stara.cialo.reservationId);

    expect((await kup(z, stara.cialo.reservationId)).status).toBe(410);
    expect((await kup(z, nowa.cialo.reservationId)).status).toBe(201);
    expect(await wierszMiejsca("D6")).toMatchObject({ email: "nowy@example.com", status: "purchased" });
  });

  it("kupiony bilet nie wygasa", async () => {
    const zegar = utworzZegarTestowy();
    const z = zaleznosci({ zegar });
    const { cialo } = await zarezerwuj(z, { seatId: "D7" });
    await kup(z, cialo.reservationId);
    zegar.przewin(10 * TTL_MS);
    expect(await zajete(z)).toContain("D7");
    expect((await zarezerwuj(z, { seatId: "D7", email: "x@example.com" })).status).toBe(409);
  });

  it("TTL z env: 2 minuty", async () => {
    const zegar = utworzZegarTestowy();
    const z = zaleznosci({ zegar, zmienne: { RESERVATION_TTL_SECONDS: "120" } });
    const { cialo } = await zarezerwuj(z, { seatId: "D8" });
    expect(cialo.expiresAt - zegar.teraz()).toBe(120_000);
  });
});

describe("sprzątanie (Cron)", () => {
  it("zwalnia tylko wygasłe, nie rusza ważnych ani kupionych i czyści dane osobowe", async () => {
    const zegar = utworzZegarTestowy();
    const z = zaleznosci({ zegar });
    const wygasla = await zarezerwuj(z, { seatId: "A1", name: "Wygasła", email: "wygasla@example.com" });
    const kupiona = await zarezerwuj(z, { seatId: "A2", email: "kupiona@example.com" });
    await kup(z, kupiona.cialo.reservationId);
    zegar.przewin(TTL_MS - 1000);
    await zarezerwuj(z, { seatId: "A3", email: "wazna@example.com" });
    zegar.przewin(1000); // A1 wygasła dokładnie teraz, A3 ważna jeszcze ~2 min

    expect(wygasla.status).toBe(201);
    const zwolnione = await zwolnijWygasleRezerwacje(env.DB, zegar.teraz());
    expect(zwolnione).toBe(1);

    expect(await wierszMiejsca("A1")).toMatchObject({
      status: "free",
      reservationId: null,
      expiresAt: null,
      customerName: null,
      email: null,
      idempotencyKey: null,
      code: null,
    });
    expect(await wierszMiejsca("A2")).toMatchObject({ status: "purchased", email: "kupiona@example.com" });
    expect(await wierszMiejsca("A3")).toMatchObject({ status: "reserved", email: "wazna@example.com" });
  });

  it("powtórne uruchomienie nic nie psuje", async () => {
    const zegar = utworzZegarTestowy();
    const z = zaleznosci({ zegar });
    await zarezerwuj(z, { seatId: "B1" });
    zegar.przewin(TTL_MS);
    expect(await zwolnijWygasleRezerwacje(env.DB, zegar.teraz())).toBe(1);
    expect(await zwolnijWygasleRezerwacje(env.DB, zegar.teraz())).toBe(0);
    expect((await zarezerwuj(z, { seatId: "B1", email: "po-cronie@example.com" })).status).toBe(201);
  });

  it("handler scheduled Workera sprzątającego działa na tej samej bazie", async () => {
    await env.DB.prepare(
      `UPDATE seats SET status = 'reserved', reservationId = 'stara', expiresAt = 1, email = 'x@example.com'
        WHERE eventId = ?1 AND seatId = 'C1'`,
    )
      .bind(SEANS)
      .run();
    const ctx = createExecutionContext();
    await cron.scheduled(createScheduledController(), { DB: env.DB }, ctx);
    await waitOnExecutionContext(ctx);
    expect(await wierszMiejsca("C1")).toMatchObject({ status: "free", email: null });
    expect(await sprzataj({ DB: env.DB })).toBe(0);
  });
});
