// Runtime Workerów traktuje każdy nazwany eksport pliku wejściowego jak punkt wejścia: klasa albo handler.
// Stała albo zwykła funkcja obok `export default` może wywrócić start Workera, a testy jednostkowe
// i integracyjne tego nie zobaczą, bo importują moduł bezpośrednio.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PLIKI_WEJSCIOWE = ["worker.ts", "workers/sprzatanie/src/index.ts", "workers/sala-dev/index.ts", "tests/integracyjne/worker-testowy.ts"];

describe("pliki wejściowe Workerów", () => {
  it.each(PLIKI_WEJSCIOWE)("%s eksportuje tylko handler i klasy Durable Objectów", (plik) => {
    const eksporty = readFileSync(plik, "utf8")
      .split(/\r?\n/)
      .filter((linia) => /^export\s/.test(linia))
      .filter((linia) => !/^export default\b/.test(linia) && !/^export (type|interface)\b/.test(linia))
      .filter((linia) => !/^export \{ [A-Z]\w+ \} from /.test(linia));
    expect(eksporty).toEqual([]);
  });
});
