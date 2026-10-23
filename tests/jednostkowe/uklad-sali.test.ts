import { describe, expect, it } from "vitest";
import {
  czyPoprawneMiejsce,
  liczbaMiejsc,
  opisMiejsca,
  parsujMiejsce,
  rzedySali,
  wszystkieMiejsca,
} from "../../src/lib/domain/uklad-sali";

describe("układ sali A–H × 1–10", () => {
  it.each(["A1", "H10", "F7", "C5", "A10", "H1"])("akceptuje %s", (seatId) => {
    expect(czyPoprawneMiejsce(seatId)).toBe(true);
  });

  it.each([
    ["I1", "rząd poza salą"],
    ["A0", "numer zero"],
    ["A11", "numer poza rzędem"],
    ["F", "brak numeru"],
    ["", "pusty tekst"],
    ["f7", "małe litery"],
    ["A01", "zero wiodące"],
    [" F7", "spacja"],
    ["F7 ", "spacja na końcu"],
    ["7F", "odwrócona kolejność"],
    ["AA1", "dwie litery"],
  ])("odrzuca %s (%s)", (seatId) => {
    expect(czyPoprawneMiejsce(seatId)).toBe(false);
  });

  it("odrzuca wartości, które nie są tekstem", () => {
    expect(czyPoprawneMiejsce(7)).toBe(false);
    expect(czyPoprawneMiejsce(null)).toBe(false);
    expect(czyPoprawneMiejsce({ seatId: "F7" })).toBe(false);
  });

  it("rozbija identyfikator na rząd i numer", () => {
    expect(parsujMiejsce("F7")).toEqual({ rzad: "F", numer: 7 });
    expect(parsujMiejsce("H10")).toEqual({ rzad: "H", numer: 10 });
  });

  it("generuje 80 unikalnych foteli w kolejności rzędów", () => {
    const miejsca = wszystkieMiejsca();
    expect(miejsca).toHaveLength(80);
    expect(new Set(miejsca).size).toBe(80);
    expect(miejsca[0]).toBe("A1");
    expect(miejsca.at(-1)).toBe("H10");
    expect(rzedySali()).toEqual(["A", "B", "C", "D", "E", "F", "G", "H"]);
    expect(liczbaMiejsc()).toBe(80);
  });

  it("opisuje fotel po ludzku", () => {
    expect(opisMiejsca("F7")).toBe("Rząd F, miejsce 7");
  });

  it("szanuje mniejszy układ sali", () => {
    expect(czyPoprawneMiejsce("C3", { rzedy: 2, miejscaWRzedzie: 5 })).toBe(false);
    expect(czyPoprawneMiejsce("B5", { rzedy: 2, miejscaWRzedzie: 5 })).toBe(true);
  });
});
