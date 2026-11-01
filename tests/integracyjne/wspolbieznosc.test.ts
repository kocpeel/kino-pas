// W1–W6: współbieżność na prawdziwym D1. Uczciwie: lokalny D1 serializuje zapisy, więc te testy
// dowodzą poprawności WARUNKÓW w zapytaniach (jedno warunkowe UPDATE zamiast „sprawdź, potem zapisz"),
// a nie zachowania pod prawdziwym opóźnieniem sieci. Do tego służy test w tests/obciazenie.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { utworzZegarTestowy } from "../../src/lib/czas";
import {
  liczStatusy,
  odbierzKod,
  SEANS,
  stanRezerwacji,
  TTL_MS,
  wierszMiejsca,
  wyslijZdarzenie,
  zaplac,
  zarezerwuj,
  zasiej,
  zaleznosci,
  zdarzenieOplacenia,
} from "./pomocnicze";

beforeEach(() => zasiej());

describe("W1: 50 równoległych rezerwacji tego samego fotela", () => {
  it("daje dokładnie jedno 201, reszta 409", async () => {
    const z = zaleznosci();
    const wyniki = await Promise.all(
      Array.from({ length: 50 }, (_, i) => zarezerwuj(z, { seatId: "F7", email: `klient${i}@example.com` })),
    );
    expect(liczStatusy(wyniki.map((w) => w.status))).toEqual({ 201: 1, 409: 49 });

    const zwyciezca = wyniki.find((w) => w.status === 201)!;
    const wiersz = await wierszMiejsca("F7");
    expect(wiersz).toMatchObject({ status: "reserved", reservationId: zwyciezca.cialo.reservationId, version: 1 });
  });
});

describe("W2: 50 równoległych rezerwacji różnych foteli", () => {
  it("wszystkie 201 i żadna nie ginie", async () => {
    const z = zaleznosci();
    const fotele = ["A", "B", "C", "D", "E"].flatMap((r) => Array.from({ length: 10 }, (_, i) => `${r}${i + 1}`));
    const wyniki = await Promise.all(
      fotele.map((seatId, i) => zarezerwuj(z, { seatId, email: `rozne${i}@example.com` })),
    );
    expect(wyniki.every((w) => w.status === 201)).toBe(true);
    const { results } = await env.DB.prepare(
      "SELECT COUNT(*) AS n, COUNT(DISTINCT reservationId) AS unikalne FROM seats WHERE eventId = ?1 AND status = 'reserved'",
    )
      .bind(SEANS)
      .all<{ n: number; unikalne: number }>();
    expect(results[0]).toEqual({ n: 50, unikalne: 50 });
  });
});

describe("W3: równoległe dostarczenia płatności tej samej rezerwacji", () => {
  it("dwa równoległe webhooki z tym samym zdarzeniem: w bazie jeden zakup", async () => {
    const z = zaleznosci();
    const rezerwacja = await zarezerwuj(z, { seatId: "C3" });
    const zdarzenie = zdarzenieOplacenia(rezerwacja.cialo.reservationId, { paidAt: z.zegar.teraz() });
    const [a, b] = await Promise.all([wyslijZdarzenie(z, zdarzenie), wyslijZdarzenie(z, zdarzenie)]);
    expect([a.status, b.status]).toEqual([200, 200]);

    const wiersz = await wierszMiejsca("C3");
    expect(wiersz).toMatchObject({ status: "purchased", expiresAt: null, version: 2 });
    expect((await stanRezerwacji(z, rezerwacja.cialo.reservationId)).cialo.code).toBe(wiersz?.code);
  });

  it("20 równoległych odbiorów kodu po płatności daje jeden kod", async () => {
    const z = zaleznosci();
    const rezerwacja = await zarezerwuj(z, { seatId: "C4" });
    await zaplac(z, rezerwacja.cialo.reservationId);
    const wyniki = await Promise.all(Array.from({ length: 20 }, () => odbierzKod(z, rezerwacja.cialo.reservationId)));
    expect(new Set(wyniki.map((w) => w.cialo.code)).size).toBe(1);
    expect(liczStatusy(wyniki.map((w) => w.status))).toEqual({ 200: 20 });
  });
});

describe("W4: płatność równolegle z wygaśnięciem", () => {
  it("na granicy expiresAt wynik jest zawsze spójny: albo bilet, albo nowy właściciel, nigdy oba", async () => {
    const zegarKlienta = utworzZegarTestowy();
    const kupujacy = zaleznosci({ zegar: zegarKlienta });
    const fotele = Array.from({ length: 10 }, (_, i) => `G${i + 1}`);

    for (const seatId of fotele) {
      zegarKlienta.ustaw(Date.UTC(2026, 10, 6, 12));
      const rezerwacja = await zarezerwuj(kupujacy, { seatId, email: `kupujacy-${seatId}@example.com` });
      const { expiresAt, reservationId } = rezerwacja.cialo;

      // Płatność tuż przed granicą i nowa rezerwacja innej osoby dokładnie na granicy, równolegle.
      const przedGranica = zaleznosci({ zegar: utworzZegarTestowy(expiresAt - 1) });
      const naGranicy = zaleznosci({ zegar: utworzZegarTestowy(expiresAt) });
      const [platnosc, przejecie] = await Promise.all([
        zaplac(przedGranica, reservationId, { paymentIntent: `pi_${seatId}` }),
        zarezerwuj(naGranicy, { seatId, email: `ktos-inny-${seatId}@example.com` }),
      ]);
      expect(platnosc.status).toBe(200);

      const wiersz = await wierszMiejsca(seatId);
      const kupiono = wiersz?.status === "purchased";
      const przejeto = przejecie.status === 201;
      expect(kupiono !== przejeto).toBe(true);
      expect(wiersz?.reservationId).toBe(kupiono ? reservationId : przejecie.cialo.reservationId);
      if (!przejeto) expect(przejecie.status).toBe(409);
    }
  });

  it("płatność dokładnie w chwili expiresAt nie daje biletu, a sekundę wcześniej daje", async () => {
    const zegar = utworzZegarTestowy();
    const z = zaleznosci({ zegar });
    const a = await zarezerwuj(z, { seatId: "H1" });
    const b = await zarezerwuj(z, { seatId: "H2", email: "b@example.com" });

    await zaplac(z, a.cialo.reservationId, { paidAt: a.cialo.expiresAt });
    expect((await wierszMiejsca("H1"))?.status).toBe("reserved");
    await zaplac(z, b.cialo.reservationId, { paidAt: b.cialo.expiresAt - 1000 });
    expect((await wierszMiejsca("H2"))?.status).toBe("purchased");
  });
});

describe("W5: rezerwacja wygasłego fotela przez dwie osoby naraz", () => {
  it("jedna wygrywa, druga dostaje 409", async () => {
    const zegar = utworzZegarTestowy();
    const z = zaleznosci({ zegar });
    await zarezerwuj(z, { seatId: "E5", email: "pierwszy@example.com" });
    zegar.przewin(TTL_MS + 1);

    const wyniki = await Promise.all([
      zarezerwuj(z, { seatId: "E5", email: "druga@example.com" }),
      zarezerwuj(z, { seatId: "E5", email: "trzeci@example.com" }),
    ]);
    expect(wyniki.map((w) => w.status).sort()).toEqual([201, 409]);
  });
});

describe("W6: limit aktywnych rezerwacji na e-mail", () => {
  it("N+10 równoległych żądań z jednego e-maila → w bazie nie więcej niż limit", async () => {
    const limit = 4;
    const z = zaleznosci({ zmienne: { MAX_ACTIVE_RESERVATIONS_PER_EMAIL: String(limit) } });
    const fotele = Array.from({ length: limit + 10 }, (_, i) => `${"ABCDEFGH"[i % 8]}${Math.floor(i / 8) + 1}`);
    const wyniki = await Promise.all(fotele.map((seatId) => zarezerwuj(z, { seatId, email: "chciwy@example.com" })));

    expect(liczStatusy(wyniki.map((w) => w.status))).toEqual({ 201: limit, 429: 10 });
    expect(wyniki.filter((w) => w.status === 429).every((w) => w.cialo.error === "too_many_active_reservations")).toBe(
      true,
    );
    const wiersz = await env.DB.prepare("SELECT COUNT(*) AS n FROM seats WHERE email = ?1 AND status = 'reserved'")
      .bind("chciwy@example.com")
      .first<{ n: number }>();
    expect(wiersz?.n).toBe(limit);
  });

  it("limit podaje Retry-After do wygaśnięcia najstarszej rezerwacji, a po niej znowu można", async () => {
    const zegar = utworzZegarTestowy();
    const z = zaleznosci({ zegar, zmienne: { MAX_ACTIVE_RESERVATIONS_PER_EMAIL: "1" } });
    expect((await zarezerwuj(z, { seatId: "A1" })).status).toBe(201);
    zegar.przewin(20_000);
    const odmowa = await zarezerwuj(z, { seatId: "A2" });
    expect(odmowa.status).toBe(429);
    expect(odmowa.naglowki.get("retry-after")).toBe(String((TTL_MS - 20_000) / 1000));
    zegar.przewin(TTL_MS);
    expect((await zarezerwuj(z, { seatId: "A2" })).status).toBe(201);
  });

  it("limit można wyłączyć (0)", async () => {
    const z = zaleznosci({ zmienne: { MAX_ACTIVE_RESERVATIONS_PER_EMAIL: "0" } });
    const wyniki = await Promise.all(
      Array.from({ length: 10 }, (_, i) => zarezerwuj(z, { seatId: `B${i + 1}`, email: "bez-limitu@example.com" })),
    );
    expect(wyniki.every((w) => w.status === 201)).toBe(true);
  });
});
