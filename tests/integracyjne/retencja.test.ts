// Retencja danych osobowych: Cron raz na dobę anonimizuje kupione bilety N dni po seansie.

import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SEANSE } from "../../seed/generuj-seed";
import cron, { CRON_RETENCJI, retencja } from "../../workers/sprzatanie/src/index";
import { INNY_SEANS, kup, SEANS, wierszMiejsca, zarezerwuj, zasiej, zaleznosci } from "./pomocnicze";

const DOBA_MS = 24 * 60 * 60 * 1000;
const POCZATEK_SEANSU = Date.parse(SEANSE[0]!.startsAt);

beforeEach(async () => {
  await zasiej();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

async function kupiony(seatId: string, eventId = SEANS) {
  const z = zaleznosci();
  const r = await zarezerwuj(z, { eventId, seatId, name: "Anna Kupująca", email: "anna@example.com" }, { klucz: `ret-${eventId}-${seatId}` });
  const { code } = (await kup(z, r.cialo.reservationId)).cialo;
  return { reservationId: r.cialo.reservationId, code };
}

describe("retencja danych osobowych", () => {
  it("30 dni po seansie kupiony bilet traci imię, e-mail, sekret i klucz; zostaje kod i status", async () => {
    const { code, reservationId } = await kupiony("A1");
    expect(await retencja({ DB: env.DB }, POCZATEK_SEANSU + 30 * DOBA_MS + 1)).toBe(1);
    expect(await wierszMiejsca("A1")).toMatchObject({
      status: "purchased",
      code,
      reservationId,
      customerName: null,
      email: null,
      secretHash: null,
      idempotencyKey: null,
    });
    // Drugi przebieg nie ma już czego anonimizować.
    expect(await retencja({ DB: env.DB }, POCZATEK_SEANSU + 31 * DOBA_MS)).toBe(0);
  });

  it("przed upływem retencji i dla późniejszych seansów niczego nie rusza", async () => {
    await kupiony("A2");
    await kupiony("A2", INNY_SEANS);
    expect(await retencja({ DB: env.DB }, POCZATEK_SEANSU + 29 * DOBA_MS)).toBe(0);
    expect((await wierszMiejsca("A2"))?.email).toBe("anna@example.com");
    // Granica dla pierwszego seansu minęła, dla drugiego (dzień później) jeszcze nie.
    expect(await retencja({ DB: env.DB }, POCZATEK_SEANSU + 30 * DOBA_MS + 60_000)).toBe(1);
    expect((await wierszMiejsca("A2", INNY_SEANS))?.email).toBe("anna@example.com");
  });

  it("zła wartość DATA_RETENTION_DAYS nie kasuje danych za wcześnie (używa 30 dni)", async () => {
    await kupiony("A3");
    expect(await retencja({ DB: env.DB, DATA_RETENTION_DAYS: "0" }, POCZATEK_SEANSU + DOBA_MS)).toBe(0);
    expect(await retencja({ DB: env.DB, DATA_RETENTION_DAYS: "abc" }, POCZATEK_SEANSU + 31 * DOBA_MS)).toBe(1);
  });

  it("handler scheduled uruchamia retencję tylko dla dobowego crona", async () => {
    await kupiony("A4");
    await env.DB.prepare("UPDATE events SET startsAt = '2000-01-01T00:00:00.000Z' WHERE id = ?1").bind(SEANS).run();

    const coMinute = createExecutionContext();
    await cron.scheduled(createScheduledController({ cron: "* * * * *" }), { DB: env.DB }, coMinute);
    await waitOnExecutionContext(coMinute);
    expect((await wierszMiejsca("A4"))?.email).toBe("anna@example.com");

    const raz = createExecutionContext();
    await cron.scheduled(createScheduledController({ cron: CRON_RETENCJI }), { DB: env.DB }, raz);
    await waitOnExecutionContext(raz);
    expect((await wierszMiejsca("A4"))?.email).toBeNull();
  });
});
