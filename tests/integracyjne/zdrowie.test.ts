// /api/zdrowie i alerty Workera sprzątającego (kontrola co minutę, stan w alert_state).

import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { obsluzZdrowie } from "../../src/lib/http/trasy";
import { kontrolaZdrowia } from "../../workers/sprzatanie/src/zdrowie";
import { zasiej, zaleznosci, zepsutaBaza } from "./pomocnicze";

const MINUTA = 60_000;

beforeEach(async () => {
  await zasiej();
  await env.DB.prepare("DELETE FROM alert_state").run();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/zdrowie", () => {
  it("200 z czasem odpowiedzi bazy", async () => {
    const odp = await exports.default.fetch(new Request("https://kasa.test/api/zdrowie"));
    expect(odp.status).toBe(200);
    expect(odp.headers.get("cache-control")).toBe("no-store");
    const cialo = (await odp.json()) as { status: string; db: { latencyMs: number }; loadShedding: { capacity: number } };
    expect(cialo.status).toBe("ok");
    expect(cialo.db.latencyMs).toBeGreaterThanOrEqual(0);
    expect(cialo.loadShedding.capacity).toBe(1);
  });

  it("baza nie działa → 503, nie 500", async () => {
    const odp = await obsluzZdrowie(() => zaleznosci({ db: zepsutaBaza() }));
    expect(odp.status).toBe(503);
  });
});

/** Udawany główny Worker: kolejne odpowiedzi /api/zdrowie z listy. */
function aplikacja(statusy: number[]): Fetcher {
  let i = 0;
  return {
    fetch: async () => {
      const status = statusy[Math.min(i++, statusy.length - 1)]!;
      return status === 200
        ? Response.json({ status: "ok", db: { latencyMs: 12 } })
        : Response.json({ error: "unavailable" }, { status });
    },
  } as unknown as Fetcher;
}

describe("alerty z kontroli zdrowia", () => {
  it("alert po 2 nieudanych kontrolach, przypomnienie po 30 min, jedna wiadomość po naprawie", async () => {
    const wyslane: string[] = [];
    const wyslij = async (_adres: string, tresc: object) => wyslane.push((tresc as { text: string }).text);
    const srodowisko = {
      DB: env.DB,
      APLIKACJA: aplikacja([503, 503, 503, 503, 200, 200]),
      ALERT_WEBHOOK_URL: "https://hooks.example/alert",
    };
    let t = 1_000_000;
    const kontrola = async (poMs: number) => kontrolaZdrowia(srodowisko, { teraz: (t += poMs), wyslij });

    await kontrola(0); // 1. porażka: jeszcze cisza (pojedynczy błysk)
    expect(wyslane).toEqual([]);
    await kontrola(MINUTA); // 2. porażka: alert
    expect(wyslane).toEqual([expect.stringMatching(/^🔴 .*HTTP 503 \(unavailable\)/)]);
    await kontrola(MINUTA); // nadal źle, ale przypomnienie dopiero po 30 min
    expect(wyslane).toHaveLength(1);
    await kontrola(30 * MINUTA);
    expect(wyslane).toHaveLength(2);
    await kontrola(MINUTA); // naprawione
    expect(wyslane[2]).toMatch(/^🟢 Kino Pas działa znowu/);
    await kontrola(MINUTA); // dalej dobrze: cisza
    expect(wyslane).toHaveLength(3);
  });

  it("bez webhooka alert trafia tylko do logów (jedna linia JSON z polem alert)", async () => {
    const logi = vi.spyOn(console, "error").mockImplementation(() => {});
    logi.mockClear(); // ten sam szpieg co w beforeEach: bez wywołań z poprzednich testów
    const srodowisko = { DB: env.DB, APLIKACJA: aplikacja([500]) };
    await kontrolaZdrowia(srodowisko, { teraz: 1 });
    await kontrolaZdrowia(srodowisko, { teraz: 2 });
    const alerty = logi.mock.calls.map((w) => String(w[0])).filter((l) => l.startsWith("{"));
    expect(alerty).toHaveLength(1);
    expect(JSON.parse(alerty[0]!)).toMatchObject({ alert: "kasa-kino", poziom: "problem" });
  });

  it("przy niedostępnej bazie stanu alert idzie od razu (lepiej za często niż wcale)", async () => {
    const wyslane: object[] = [];
    await kontrolaZdrowia(
      { DB: zepsutaBaza(), APLIKACJA: aplikacja([503]), ALERT_WEBHOOK_URL: "https://hooks.example/alert" },
      { teraz: 1, wyslij: async (_a, tresc) => wyslane.push(tresc) },
    );
    expect(wyslane).toHaveLength(1);
  });

  it("awaria webhooka nie przerywa kontroli", async () => {
    const srodowisko = { DB: env.DB, APLIKACJA: aplikacja([503]), ALERT_WEBHOOK_URL: "https://hooks.example/alert" };
    const wyslij = () => Promise.reject(new Error("webhook down"));
    await kontrolaZdrowia(srodowisko, { teraz: 1, wyslij });
    await expect(kontrolaZdrowia(srodowisko, { teraz: 2, wyslij })).resolves.toMatchObject({ ok: false });
  });
});
