// Kontrakt API: dokładne kształty odpowiedzi, przez pełną ścieżkę Request → Worker → D1.

import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { SEANSE } from "../../seed/generuj-seed";
import { SEANS, zadanieRezerwacji, zasiej } from "./pomocnicze";

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
  it("201 → dokładnie { reservationId, expiresAt }", async () => {
    const odp = await exports.default.fetch(zadanieRezerwacji({ seatId: "A1", email: "k2@example.com" }, { ip: "10.1.1.2" }));
    expect(odp.status).toBe(201);
    expect(odp.headers.get("cache-control")).toBe("no-store");
    const cialo = (await odp.json()) as Record<string, unknown>;
    expect(Object.keys(cialo).sort()).toEqual(["expiresAt", "reservationId"]);
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
  it("201 → dokładnie { code }; powtórka 200 z tym samym kodem (sam identyfikator, bez ciasteczek)", async () => {
    const rezerwacja = await exports.default.fetch(zadanieRezerwacji({ seatId: "A3", email: "k5@example.com" }, { ip: "10.1.1.5" }));
    const r = (await rezerwacja.json()) as { reservationId: string };
    const zakup = () => fetchWorkera(`/api/reservations/${r.reservationId}/purchase`, { method: "POST" });
    const pierwszy = await zakup();
    expect(pierwszy.status).toBe(201);
    const kod = (await pierwszy.json()) as Record<string, unknown>;
    expect(Object.keys(kod)).toEqual(["code"]);
    const drugi = await zakup();
    expect(drugi.status).toBe(200);
    expect(await drugi.json()).toEqual(kod);
  });

  it("rezerwacja nie ustawia ciasteczek: klient bez pamięci ciasteczek przechodzi całą ścieżkę", async () => {
    const odp = await exports.default.fetch(zadanieRezerwacji({ seatId: "A4", email: "k6@example.com" }, { ip: "10.1.1.6" }));
    expect(odp.status).toBe(201);
    expect(odp.headers.get("set-cookie")).toBeNull();
  });

  it("410 dla nieznanej/wygasłej rezerwacji", async () => {
    const odp = await fetchWorkera("/api/reservations/0f8fad5b-d9cb-469f-a165-70867728950e/purchase", { method: "POST" });
    expect(odp.status).toBe(410);
    expect(((await odp.json()) as { error: string }).error).toBe("reservation_expired");
  });
});
