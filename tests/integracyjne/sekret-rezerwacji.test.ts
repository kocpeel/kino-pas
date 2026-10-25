// Sekret rezerwacji: sam identyfikator rezerwacji (widoczny w adresie) nie wystarcza,
// żeby kupić bilet ani zobaczyć jego kod. Potrzebne jest ciasteczko z przeglądarki, która rezerwowała.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ciasteczkoZOdpowiedzi, kup, wierszMiejsca, zarezerwuj, zasiej, zaleznosci } from "./pomocnicze";

beforeEach(() => zasiej());

const KLUCZ = "sekret-test-klucz-0001";

describe("sekret rezerwacji w ciasteczku", () => {
  it("baza przechowuje tylko skrót sekretu, nie sam sekret", async () => {
    const r = await zarezerwuj(zaleznosci(), { seatId: "A1" });
    const sekret = ciasteczkoZOdpowiedzi(r.naglowki)!.split("=")[1]!;
    const wiersz = await wierszMiejsca("A1");
    expect(wiersz?.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(wiersz?.secretHash).not.toContain(sekret);
  });

  it("bez ciasteczka albo z cudzym nie da się kupić cudzej rezerwacji (403)", async () => {
    const z = zaleznosci();
    const moja = await zarezerwuj(z, { seatId: "B1", email: "ja@example.com" });
    const cudza = await zarezerwuj(z, { seatId: "B2", email: "ktos@example.com" });

    const bezCiasteczka = await kup(z, moja.cialo.reservationId, { ciasteczko: null });
    expect(bezCiasteczka.status).toBe(403);
    expect(bezCiasteczka.cialo.error).toBe("reservation_forbidden");

    const zCudzym = await kup(z, moja.cialo.reservationId, { ciasteczko: ciasteczkoZOdpowiedzi(cudza.naglowki) });
    expect(zCudzym.status).toBe(403);
    expect((await wierszMiejsca("B1"))?.status).toBe("reserved");

    expect((await kup(z, moja.cialo.reservationId)).status).toBe(201);
  });

  it("kod kupionego biletu widzi tylko właściciel: powtórka zakupu bez ciasteczka → 403, nie kod", async () => {
    const z = zaleznosci();
    const r = await zarezerwuj(z, { seatId: "C1" });
    const kod = (await kup(z, r.cialo.reservationId)).cialo.code;
    const obcy = await kup(z, r.cialo.reservationId, { ciasteczko: null });
    expect(obcy.status).toBe(403);
    expect(JSON.stringify(obcy.cialo)).not.toContain(kod);
    expect((await kup(z, r.cialo.reservationId)).cialo.code).toBe(kod);
  });

  it("powtórka rezerwacji z tym samym kluczem wydaje nowy sekret, a stary przestaje działać", async () => {
    const z = zaleznosci();
    const pierwsza = await zarezerwuj(z, { seatId: "D1" }, { klucz: KLUCZ });
    const staryCiasteczko = ciasteczkoZOdpowiedzi(pierwsza.naglowki);
    const powtorka = await zarezerwuj(z, { seatId: "D1" }, { klucz: KLUCZ });
    expect(powtorka.naglowki.get("idempotent-replayed")).toBe("true");
    const noweCiasteczko = ciasteczkoZOdpowiedzi(powtorka.naglowki);
    expect(noweCiasteczko).not.toBe(staryCiasteczko);

    expect((await kup(z, pierwsza.cialo.reservationId, { ciasteczko: staryCiasteczko })).status).toBe(403);
    expect((await kup(z, pierwsza.cialo.reservationId, { ciasteczko: noweCiasteczko })).status).toBe(201);
  });

  it("wygasła rezerwacja z cudzym ciasteczkiem → 410 (nie zdradzamy więcej niż przy braku rezerwacji)", async () => {
    const z = zaleznosci();
    const r = await zarezerwuj(z, { seatId: "E1" });
    z.zegar.przewin(10 * 60_000);
    expect((await kup(z, r.cialo.reservationId, { ciasteczko: null })).status).toBe(410);
  });

  it("rezerwacja sprzed wprowadzenia sekretów (secretHash NULL) da się kupić bez ciasteczka", async () => {
    const z = zaleznosci();
    const r = await zarezerwuj(z, { seatId: "F1" });
    await env.DB.prepare("UPDATE seats SET secretHash = NULL WHERE reservationId = ?1").bind(r.cialo.reservationId).run();
    expect((await kup(z, r.cialo.reservationId, { ciasteczko: null })).status).toBe(201);
  });

  it("sprzątanie wygasłych czyści też skrót sekretu", async () => {
    const z = zaleznosci();
    await zarezerwuj(z, { seatId: "G1" });
    const { zwolnijWygasleRezerwacje } = await import("../../src/lib/db/zapytania-miejsca");
    await zwolnijWygasleRezerwacje(env.DB, z.zegar.teraz() + 10 * 60_000);
    expect((await wierszMiejsca("G1"))?.secretHash).toBeNull();
  });
});
