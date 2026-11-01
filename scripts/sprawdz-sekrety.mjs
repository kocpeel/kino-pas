// Klucze Stripe'a mają żyć w zmiennych środowiskowych na serwerze: nie w repozytorium i nie w przeglądarce.
// Szuka prawdziwie wyglądających kluczy w plikach śledzonych przez gita, a gdy jest build, także
// w plikach wysyłanych do przeglądarki. Użycie: `npm run lint:sekrety` (kod wyjścia 1 przy znalezisku).

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const WZOR = /\b(?:sk|rk)_(?:test|live)_[0-9a-zA-Z]{20,}|\bwhsec_[0-9a-zA-Z]{20,}/;
const KATALOGI_PRZEGLADARKI = [".next/static", ".open-next/assets"];

function* plikiKatalogu(katalog) {
  for (const nazwa of readdirSync(katalog)) {
    const sciezka = join(katalog, nazwa);
    if (statSync(sciezka).isDirectory()) yield* plikiKatalogu(sciezka);
    else yield sciezka;
  }
}

function czyZawieraKlucz(plik) {
  try {
    return WZOR.test(readFileSync(plik, "utf8"));
  } catch {
    return false; // plik zniknął albo nie da się go przeczytać jako tekstu
  }
}

const sledzone = execSync("git ls-files", { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
const doPrzegladarki = KATALOGI_PRZEGLADARKI.filter(existsSync).flatMap((k) => [...plikiKatalogu(k)]);
const znalezione = [...sledzone, ...doPrzegladarki].filter(czyZawieraKlucz);

if (znalezione.length > 0) {
  console.error("Wygląda na klucz Stripe'a w:");
  for (const plik of znalezione) console.error(`  ${plik}`);
  process.exit(1);
}
console.log(`Brak kluczy Stripe'a w ${sledzone.length} plikach repozytorium i ${doPrzegladarki.length} plikach dla przeglądarki.`);
