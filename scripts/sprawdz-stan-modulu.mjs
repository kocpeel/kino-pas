// Statyczny test na wycieki w Workerze: szuka stanu na poziomie modułu, który może rosnąć
// przez cały czas życia izolatu (Map/Set/tablice, `let`, setInterval) w kodzie serwerowym.
// Świadomie ograniczony stan oznacz komentarzem `// stan-modulu: <uzasadnienie>` w linii powyżej.
// Użycie: `npm run lint:wycieki` (kod wyjścia 1 przy naruszeniach).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const KORZEN = fileURLToPath(new URL("..", import.meta.url));
export const KATALOGI_SERWEROWE = ["src/lib", "src/app/api", "workers"];
const POMIJANE = new Set(["src/lib/klient", "node_modules"]);

const REGULY = [
  { wzor: /^(export\s+)?(const|let|var)\s+\w+[^=]*=\s*new\s+(Map|Set|WeakMap|Array)\b/, opis: "kolekcja na poziomie modułu" },
  { wzor: /^(export\s+)?(const|let|var)\s+\w+[^=]*=\s*\[\s*\]/, opis: "pusta tablica na poziomie modułu" },
  { wzor: /^(export\s+)?let\s+/, opis: "zmienny stan modułu (let)" },
  { wzor: /\bsetInterval\s*\(/, opis: "setInterval po stronie serwera", wszedzie: true },
];

function* pliki(katalog) {
  for (const nazwa of readdirSync(katalog)) {
    // Katalogi ukryte (.wrangler, .next…) to wygenerowane artefakty, nie nasz kod.
    if (nazwa.startsWith(".")) continue;
    const sciezka = join(katalog, nazwa);
    const wzgledna = relative(KORZEN, sciezka).replaceAll("\\", "/");
    if ([...POMIJANE].some((p) => wzgledna === p || wzgledna.startsWith(`${p}/`))) continue;
    if (statSync(sciezka).isDirectory()) yield* pliki(sciezka);
    else if (/\.(ts|tsx|mjs|js)$/.test(nazwa) && !nazwa.endsWith(".d.ts")) yield sciezka;
  }
}

export function znajdzNaruszenia(korzen = KORZEN, katalogi = KATALOGI_SERWEROWE) {
  const naruszenia = [];
  for (const katalog of katalogi) {
    let istnieje = true;
    try {
      statSync(join(korzen, katalog));
    } catch {
      istnieje = false;
    }
    if (!istnieje) continue;
    for (const plik of pliki(join(korzen, katalog))) {
      const linie = readFileSync(plik, "utf8").split(/\r?\n/);
      linie.forEach((linia, i) => {
        const poprzednia = linie[i - 1] ?? "";
        if (/\/\/\s*stan-modulu:/.test(poprzednia)) return;
        for (const regula of REGULY) {
          const tekst = regula.wszedzie ? linia : linia.replace(/\s+$/, "");
          if (!regula.wszedzie && /^\s/.test(linia)) continue;
          if (regula.wzor.test(tekst)) {
            naruszenia.push({ plik: relative(korzen, plik).replaceAll("\\", "/"), linia: i + 1, opis: regula.opis });
          }
        }
      });
    }
  }
  return naruszenia;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const naruszenia = znajdzNaruszenia();
  for (const n of naruszenia) console.error(`${n.plik}:${n.linia}  ${n.opis}`);
  if (naruszenia.length > 0) {
    console.error(`\n${naruszenia.length} naruszeń. Oznacz świadomy, ograniczony stan komentarzem // stan-modulu: …`);
    process.exit(1);
  }
  console.log("Brak nieograniczonego stanu na poziomie modułu w kodzie serwerowym.");
}
