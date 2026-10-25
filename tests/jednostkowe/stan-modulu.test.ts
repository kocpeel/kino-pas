import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error moduł .mjs bez typów
import { znajdzNaruszenia } from "../../scripts/sprawdz-stan-modulu.mjs";

interface Naruszenie {
  plik: string;
  linia: number;
  opis: string;
}

describe("brak rosnącego stanu na poziomie modułu (Worker)", () => {
  it("kod serwerowy jest czysty", () => {
    expect(znajdzNaruszenia() as Naruszenie[]).toEqual([]);
  });

  it("wykrywa typowe źródła wycieków", () => {
    const katalog = mkdtempSync(join(tmpdir(), "stan-modulu-"));
    try {
      mkdirSync(join(katalog, "src"));
      writeFileSync(
        join(katalog, "src", "zly.ts"),
        [
          "const sesje = new Map<string, string>();",
          "let licznik = 0;",
          "export const log = [];",
          "setInterval(() => {}, 1000);",
          "// stan-modulu: ograniczony",
          "const dozwolony = new Map();",
          "function f() { const lokalna = new Map(); return lokalna; }",
        ].join("\n"),
      );
      const naruszenia = znajdzNaruszenia(katalog, ["src"]) as Naruszenie[];
      expect(naruszenia.map((n) => n.linia)).toEqual([1, 2, 3, 4]);
    } finally {
      rmSync(katalog, { recursive: true, force: true });
    }
  });
});
