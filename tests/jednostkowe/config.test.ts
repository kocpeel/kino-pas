import { describe, expect, it } from "vitest";
import { BladKonfiguracji, DOMYSLNY_TTL_S, wczytajKonfiguracje } from "../../src/lib/config";

describe("konfiguracja z env", () => {
  it("czyta TTL rezerwacji (test: 2 min)", () => {
    expect(wczytajKonfiguracje({ RESERVATION_TTL_SECONDS: "120" }).ttlMs).toBe(120_000);
  });

  it("brak wartości → domyślne 15 min", () => {
    expect(wczytajKonfiguracje({}).ttlMs).toBe(DOMYSLNY_TTL_S * 1000);
    expect(wczytajKonfiguracje({ RESERVATION_TTL_SECONDS: "" }).ttlMs).toBe(15 * 60 * 1000);
  });

  it.each(["abc", "0", "-5", "1.5", "99999999"])("niepoprawny TTL %j → czytelny błąd", (wartosc) => {
    expect(() => wczytajKonfiguracje({ RESERVATION_TTL_SECONDS: wartosc })).toThrow(BladKonfiguracji);
    expect(() => wczytajKonfiguracje({ RESERVATION_TTL_SECONDS: wartosc })).toThrow(/RESERVATION_TTL_SECONDS/);
  });

  it("limit na e-mail 0 wyłącza limit", () => {
    expect(wczytajKonfiguracje({ MAX_ACTIVE_RESERVATIONS_PER_EMAIL: "0" }).limitAktywnychNaEmail).toBe(0);
  });
});
