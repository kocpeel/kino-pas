import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { utworzZegarTestowy } from "../../src/lib/czas";
import { kup, SEANS, TTL_MS, wierszMiejsca, wolneZapisy, zarezerwuj, zasiej, zaleznosci } from "./pomocnicze";

beforeEach(() => zasiej());

const KLUCZ = "0f8fad5b-d9cb-469f-a165-70867728950e";

async function liczbaRezerwacji(email: string): Promise<number> {
  const w = await env.DB.prepare("SELECT COUNT(*) AS n FROM seats WHERE email = ?1 AND status = 'reserved'")
    .bind(email)
    .first<{ n: number }>();
  return w?.n ?? 0;
}

describe("Idempotency-Key w POST rezerwacji", () => {
  it("ten sam klucz + te same dane: drugi POST zwraca to samo, w bazie jedna rezerwacja", async () => {
    const z = zaleznosci();
    const pierwsza = await zarezerwuj(z, { seatId: "F7", email: "idem@example.com" }, { klucz: KLUCZ });
    const druga = await zarezerwuj(z, { seatId: "F7", email: "IDEM@example.com " }, { klucz: KLUCZ });
    expect(pierwsza.status).toBe(201);
    expect(druga.status).toBe(201);
    expect(druga.cialo).toEqual(pierwsza.cialo);
    expect(druga.naglowki.get("idempotent-replayed")).toBe("true");
    expect(await liczbaRezerwacji("idem@example.com")).toBe(1);
  });

  it("równoległe powtórki z tym samym kluczem też dają jedną rezerwację", async () => {
    const z = zaleznosci();
    const wyniki = await Promise.all(
      Array.from({ length: 10 }, () => zarezerwuj(z, { seatId: "F8", email: "rownolegle@example.com" }, { klucz: KLUCZ })),
    );
    expect(wyniki.every((w) => w.status === 201)).toBe(true);
    expect(new Set(wyniki.map((w) => w.cialo.reservationId)).size).toBe(1);
    expect(await liczbaRezerwacji("rownolegle@example.com")).toBe(1);
  });

  it("ten sam klucz + inne dane → 422", async () => {
    const z = zaleznosci();
    await zarezerwuj(z, { seatId: "F7" }, { klucz: KLUCZ });
    const innyFotel = await zarezerwuj(z, { seatId: "F9" }, { klucz: KLUCZ });
    const innyEmail = await zarezerwuj(z, { seatId: "F7", email: "ktos@example.com" }, { klucz: KLUCZ });
    expect(innyFotel.status).toBe(422);
    expect(innyEmail.status).toBe(422);
    expect(innyFotel.cialo.error).toBe("idempotency_key_reused");
    expect((await wierszMiejsca("F9"))?.status).toBe("free");
  });

  it("równoległe użycie klucza dla dwóch różnych foteli: jeden 201, drugi 422", async () => {
    const z = zaleznosci();
    const wyniki = await Promise.all([
      zarezerwuj(z, { seatId: "E1" }, { klucz: KLUCZ }),
      zarezerwuj(z, { seatId: "E2" }, { klucz: KLUCZ }),
    ]);
    expect(wyniki.map((w) => w.status).sort()).toEqual([201, 422]);
  });

  it("powtórka po wygaśnięciu pierwszej rezerwacji = nowe żądanie (nowa rezerwacja)", async () => {
    const zegar = utworzZegarTestowy();
    const z = zaleznosci({ zegar });
    const pierwsza = await zarezerwuj(z, { seatId: "F7" }, { klucz: KLUCZ });
    zegar.przewin(TTL_MS + 5);
    const powtorka = await zarezerwuj(z, { seatId: "F7" }, { klucz: KLUCZ });
    expect(powtorka.status).toBe(201);
    expect(powtorka.naglowki.get("idempotent-replayed")).toBeNull();
    expect(powtorka.cialo.reservationId).not.toBe(pierwsza.cialo.reservationId);
    expect(powtorka.cialo.expiresAt).toBe(zegar.teraz() + TTL_MS);
  });

  it("powtórka po zakupie tej rezerwacji → 409 (fotel już kupiony)", async () => {
    const z = zaleznosci();
    const r = await zarezerwuj(z, { seatId: "F7" }, { klucz: KLUCZ });
    await kup(z, r.cialo.reservationId);
    const powtorka = await zarezerwuj(z, { seatId: "F7" }, { klucz: KLUCZ });
    expect(powtorka.status).toBe(409);
  });

  it("retry po timeoucie: zapis się udał, odpowiedź nie dotarła, ponowienie nie dubluje rezerwacji", async () => {
    // Timeout serwera 50 ms, a odpowiedź z bazy przychodzi po 200 ms (zapis już wykonany).
    const wolna = zaleznosci({ db: wolneZapisy(env.DB, 200), zmienne: { DB_TIMEOUT_MS: "50" } });
    const pierwsza = await zarezerwuj(wolna, { seatId: "G7", email: "timeout@example.com" }, { klucz: KLUCZ });
    expect(pierwsza.status).toBe(503);
    expect(pierwsza.naglowki.get("retry-after")).not.toBeNull();
    await new Promise((r) => setTimeout(r, 250));

    const ponowienie = await zarezerwuj(zaleznosci(), { seatId: "G7", email: "timeout@example.com" }, { klucz: KLUCZ });
    expect(ponowienie.status).toBe(201);
    expect(ponowienie.naglowki.get("idempotent-replayed")).toBe("true");
    expect(await liczbaRezerwacji("timeout@example.com")).toBe(1);
  });
});

describe("idempotentny zakup", () => {
  it("powtórzony zakup po sukcesie: ten sam kod; 201 za pierwszym razem, potem 200", async () => {
    const z = zaleznosci();
    const r = await zarezerwuj(z, { seatId: "H5" });
    const pierwszy = await kup(z, r.cialo.reservationId);
    const drugi = await kup(z, r.cialo.reservationId);
    const trzeci = await kup(z, r.cialo.reservationId);
    expect([pierwszy.status, drugi.status, trzeci.status]).toEqual([201, 200, 200]);
    expect(drugi.cialo).toEqual(pierwszy.cialo);
    expect(trzeci.cialo).toEqual(pierwszy.cialo);
    expect(pierwszy.cialo.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  });

  it("powtórzony zakup działa także po czasie TTL (kupiony bilet nie wygasa)", async () => {
    const zegar = utworzZegarTestowy();
    const z = zaleznosci({ zegar });
    const r = await zarezerwuj(z, { seatId: "H6" });
    const kod = (await kup(z, r.cialo.reservationId)).cialo.code;
    zegar.przewin(5 * TTL_MS);
    expect((await kup(z, r.cialo.reservationId)).cialo.code).toBe(kod);
  });

  it("retry zakupu po timeoucie zwraca kod zapisany przez pierwszą próbę", async () => {
    const r = await zarezerwuj(zaleznosci(), { seatId: "H7" });
    const wolna = zaleznosci({ db: wolneZapisy(env.DB, 200), zmienne: { DB_TIMEOUT_MS: "50" } });
    expect((await kup(wolna, r.cialo.reservationId)).status).toBe(503);
    await new Promise((res) => setTimeout(res, 250));
    const ponowienie = await kup(zaleznosci(), r.cialo.reservationId);
    expect(ponowienie.status).toBe(200);
    expect(ponowienie.cialo.code).toBe((await wierszMiejsca("H7", SEANS))?.code);
  });
});
