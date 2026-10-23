import { describe, expect, it } from "vitest";
import {
  czyPoprawneIdRezerwacji,
  czyPoprawneIdSeansu,
  czyPoprawnyKluczIdempotencji,
  MAX_DLUGOSC_IMIENIA,
  normalizujEmail,
  normalizujImie,
} from "../../src/lib/domain/dane-klienta";
import { BladDomenowy } from "../../src/lib/domain/bledy";
import { walidujRezerwacje } from "../../src/lib/domain/rezerwacja";

describe("normalizacja e-maila", () => {
  it("zmienia na małe litery i obcina spacje dookoła", () => {
    expect(normalizujEmail("  Jan.Kowalski@Example.COM  ")).toBe("jan.kowalski@example.com");
  });

  it.each(["jan kowalski@example.com", "jan@", "@example.com", "jan@example", "", "   ", "jan@@example.com", "jan@.pl"])(
    "odrzuca %j",
    (email) => {
      expect(normalizujEmail(email)).toBeNull();
    },
  );

  it("odrzuca za długi adres", () => {
    expect(normalizujEmail(`${"a".repeat(250)}@example.com`)).toBeNull();
  });

  it("odrzuca wartości niebędące tekstem", () => {
    expect(normalizujEmail(42)).toBeNull();
    expect(normalizujEmail(undefined)).toBeNull();
  });
});

describe("normalizacja imienia", () => {
  it("scala białe znaki i obcina końce", () => {
    expect(normalizujImie("  Anna \t  Maria  ")).toBe("Anna Maria");
  });

  it("zachowuje polskie znaki i normalizuje Unicode (NFC)", () => {
    const rozlozone = "Zósia"; // ó jako o + akcent
    expect(normalizujImie(rozlozone)).toBe("Zósia");
    expect(normalizujImie("Łucja Żółć")).toBe("Łucja Żółć");
  });

  it("odrzuca za krótkie i za długie", () => {
    expect(normalizujImie("A")).toBeNull();
    expect(normalizujImie(" ")).toBeNull();
    expect(normalizujImie("x".repeat(MAX_DLUGOSC_IMIENIA + 1))).toBeNull();
    expect(normalizujImie("x".repeat(MAX_DLUGOSC_IMIENIA))).not.toBeNull();
  });

  it("odrzuca znaki sterujące", () => {
    expect(normalizujImie("Jan\u0000")).toBeNull();
    expect(normalizujImie("Jan\u007f")).toBeNull();
  });
});

describe("identyfikatory i klucze", () => {
  it("rozpoznaje UUID rezerwacji", () => {
    expect(czyPoprawneIdRezerwacji("0f8fad5b-d9cb-469f-a165-70867728950e")).toBe(true);
    expect(czyPoprawneIdRezerwacji("abc")).toBe(false);
    expect(czyPoprawneIdRezerwacji("0F8FAD5B-D9CB-469F-A165-70867728950E")).toBe(false);
  });

  it("rozpoznaje identyfikator seansu", () => {
    expect(czyPoprawneIdSeansu("metropolis-2026-11-06")).toBe(true);
    expect(czyPoprawneIdSeansu("../etc")).toBe(false);
    expect(czyPoprawneIdSeansu("")).toBe(false);
  });

  it("waliduje Idempotency-Key", () => {
    expect(czyPoprawnyKluczIdempotencji("0f8fad5b-d9cb-469f-a165-70867728950e")).toBe(true);
    expect(czyPoprawnyKluczIdempotencji("krotki")).toBe(false);
    expect(czyPoprawnyKluczIdempotencji("ze spacją w środku")).toBe(false);
    expect(czyPoprawnyKluczIdempotencji("x".repeat(129))).toBe(false);
  });
});

describe("walidacja wejścia rezerwacji", () => {
  it("zwraca znormalizowane dane", () => {
    expect(
      walidujRezerwacje({ eventId: "metropolis-2026-11-06", seatId: "F7", name: " Jan ", email: "JAN@EXAMPLE.COM" }),
    ).toEqual({ eventId: "metropolis-2026-11-06", seatId: "F7", name: "Jan", email: "jan@example.com" });
  });

  it("zbiera błędy wszystkich pól naraz (400)", () => {
    try {
      walidujRezerwacje({ eventId: 1, seatId: "I1", name: "", email: "x" });
      expect.unreachable();
    } catch (blad) {
      expect(blad).toBeInstanceOf(BladDomenowy);
      const b = blad as BladDomenowy;
      expect(b.status).toBe(400);
      expect(Object.keys(b.szczegoly ?? {}).sort()).toEqual(["email", "eventId", "name", "seatId"]);
    }
  });
});
