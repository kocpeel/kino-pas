// Kontrakt API: dokładne kształty odpowiedzi, przez pełną ścieżkę Request → Worker → D1.

import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { SEANSE } from "../../seed/generuj-seed";
import { SEANS, zadanieRezerwacji, zadanieWebhooka, zasiej, zdarzenieOplacenia } from "./pomocnicze";

beforeEach(() => zasiej());

const fetchWorkera = (sciezka: string, init?: RequestInit) => exports.default.fetch(new Request(`https://kasa.test${sciezka}`, init));

describe("GET /api/events", () => {
  it("zwraca listę seansów z liczbą wolnych foteli", async () => {
    const odp = await fetchWorkera("/api/events");
    expect(odp.status).toBe(200);
    expect(odp.headers.get("content-type")).toMatch(/^application\/json/);
    expect(odp.headers.get("cache-control")).toMatch(/s-maxage=5,/);
    expect(odp.headers.get("etag")).toMatch(/^W\/"[0-9a-f]{8}-[0-9a-f]+"$/);
    const lista = (await odp.json()) as unknown[];
    expect(lista).toHaveLength(SEANSE.length);
    expect(lista[0]).toEqual({
      id: SEANSE[0]!.id,
      movie: SEANSE[0]!.movie,
      startsAt: SEANSE[0]!.startsAt,
      hall: SEANSE[0]!.hall,
      rowsCount: 8,
      seatsPerRow: 10,
      price: 3200,
      totalSeats: 80,
      freeSeats: 80,
    });
  });
});

describe("GET /api/events/:id", () => {
  it("zwraca { event, takenSeats } z samymi seatId", async () => {
    await exports.default.fetch(zadanieRezerwacji({ seatId: "F7", email: "k1@example.com" }, { ip: "10.1.1.1" }));
    const odp = await fetchWorkera(`/api/events/${SEANS}`);
    expect(odp.status).toBe(200);
    expect(Object.keys((await odp.clone().json()) as object).sort()).toEqual(["event", "takenSeats"]);
    expect(await odp.json()).toEqual({
      event: {
        id: SEANS,
        movie: SEANSE[0]!.movie,
        startsAt: SEANSE[0]!.startsAt,
        hall: SEANSE[0]!.hall,
        rowsCount: 8,
        seatsPerRow: 10,
        price: 3200,
      },
      takenSeats: ["F7"],
    });
  });

  it("404 dla nieznanego seansu", async () => {
    const odp = await fetchWorkera("/api/events/nie-ma");
    expect(odp.status).toBe(404);
    expect(await odp.json()).toEqual({ error: "not_found", message: "Nie ma takiego seansu." });
  });
});

describe("POST /api/reservations", () => {
  it("201 → dokładnie { reservationId, expiresAt, amount }", async () => {
    const odp = await exports.default.fetch(zadanieRezerwacji({ seatId: "A1", email: "k2@example.com" }, { ip: "10.1.1.2" }));
    expect(odp.status).toBe(201);
    expect(odp.headers.get("cache-control")).toBe("no-store");
    const cialo = (await odp.json()) as Record<string, unknown>;
    expect(Object.keys(cialo).sort()).toEqual(["amount", "expiresAt", "reservationId"]);
    expect(cialo.amount).toBe(3200);
    expect(cialo.reservationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof cialo.expiresAt).toBe("number");
  });

  it("409 → { error: seat_taken, message }", async () => {
    await exports.default.fetch(zadanieRezerwacji({ seatId: "A2", email: "k3@example.com" }, { ip: "10.1.1.3" }));
    const odp = await exports.default.fetch(zadanieRezerwacji({ seatId: "A2", email: "b@example.com" }, { ip: "10.1.1.4" }));
    expect(odp.status).toBe(409);
    expect(await odp.json()).toEqual({ error: "seat_taken", message: "Ten fotel został właśnie zajęty." });
  });
});

describe("POST /api/reservations/:id/purchase", () => {
  const zakup = (id: string, naglowki: Record<string, string> = {}) =>
    fetchWorkera(`/api/reservations/${id}/purchase`, { method: "POST", headers: naglowki });

  async function rezerwacja(seatId: string, nr: number) {
    const odp = await exports.default.fetch(zadanieRezerwacji({ seatId, email: `k${nr}@example.com` }, { ip: `10.1.1.${nr}` }));
    return { odp, id: ((await odp.clone().json()) as { reservationId: string }).reservationId };
  }

  it("bez płatności 402, a po płatności dokładnie { code }, ten sam przy każdej powtórce", async () => {
    const { id } = await rezerwacja("A3", 5);
    const bezPlatnosci = await zakup(id);
    expect(bezPlatnosci.status).toBe(402);
    expect(((await bezPlatnosci.json()) as { error: string }).error).toBe("payment_required");

    expect((await exports.default.fetch(await zadanieWebhooka(zdarzenieOplacenia(id)))).status).toBe(200);
    const pierwszy = await zakup(id);
    expect(pierwszy.status).toBe(200);
    const kod = (await pierwszy.json()) as Record<string, unknown>;
    expect(Object.keys(kod)).toEqual(["code"]);
    expect(await (await zakup(id)).json()).toEqual(kod);
  });

  it("rezerwacja nie ustawia ciasteczek: klient bez pamięci ciasteczek przechodzi całą ścieżkę", async () => {
    const { odp } = await rezerwacja("A4", 6);
    expect(odp.status).toBe(201);
    expect(odp.headers.get("set-cookie")).toBeNull();
  });

  it("410 dla nieznanej/wygasłej rezerwacji", async () => {
    const odp = await zakup("0f8fad5b-d9cb-469f-a165-70867728950e");
    expect(odp.status).toBe(410);
    expect(((await odp.json()) as { error: string }).error).toBe("reservation_expired");
  });
});

describe("POST /api/webhooks/stripe i GET /api/reservations/:id", () => {
  it("zły podpis 400, a po prawdziwym płatność, status paid i kod", async () => {
    const utworzona = await exports.default.fetch(zadanieRezerwacji({ seatId: "B3", email: "k7@example.com" }, { ip: "10.1.1.7" }));
    const { reservationId, expiresAt } = (await utworzona.json()) as { reservationId: string; expiresAt: number };
    const stan = async () => (await fetchWorkera(`/api/reservations/${reservationId}`)).json();
    expect(await stan()).toEqual({ status: "held", amount: 3200, expiresAt });

    const zdarzenie = zdarzenieOplacenia(reservationId);
    const zly = await exports.default.fetch(await zadanieWebhooka(zdarzenie, { sekret: "whsec_inny" }));
    expect(zly.status).toBe(400);
    expect(await stan()).toEqual({ status: "held", amount: 3200, expiresAt });

    const dobry = await exports.default.fetch(await zadanieWebhooka(zdarzenie));
    expect(dobry.status).toBe(200);
    expect(await dobry.json()).toEqual({ received: true });
    expect(await stan()).toEqual({ status: "paid", amount: 3200, expiresAt, code: expect.stringMatching(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/) });
  });

  it("nieznana rezerwacja 404, zły identyfikator 400", async () => {
    expect((await fetchWorkera("/api/reservations/0f8fad5b-d9cb-469f-a165-70867728950e")).status).toBe(404);
    expect((await fetchWorkera("/api/reservations/abc")).status).toBe(400);
    expect((await fetchWorkera("/api/reservations/abc/checkout", { method: "POST" })).status).toBe(400);
  });
});
