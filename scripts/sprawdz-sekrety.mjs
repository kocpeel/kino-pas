// Klucze Stripe'a, Voucherify i Resend mają żyć w zmiennych środowiskowych na serwerze: nie w repozytorium
// i nie w przeglądarce. Szuka prawdziwie wyglądających kluczy w plikach repozytorium (śledzonych i nowych),
// a gdy jest build, także w plikach wysyłanych do przeglądarki. Klucz Voucherify nie ma stałego prefiksu,
// więc dodatkowo szukamy dokładnych wartości sekretów z lokalnych plików env (poza gitem; w CI ich nie ma).
// Użycie: `npm run lint:sekrety` (kod wyjścia 1 przy znalezisku).

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const WZOR = /\b(?:sk|rk)_(?:test|live)_[0-9a-zA-Z]{20,}|\bwhsec_[0-9a-zA-Z+/=]{20,}|\bre_[0-9a-zA-Z_]{20,}/;
const KATALOGI_PRZEGLADARKI = [".next/static", ".open-next/assets"];
const PLIKI_ENV = [".dev.vars", ".env.produkcja", ".env.staging", ".env.cloudflare"];
const NAZWA_SEKRETU = /SECRET|KEY|TOKEN/;
const MIN_DLUGOSC_SEKRETU = 16;

function* plikiKatalogu(katalog) {
  for (const nazwa of readdirSync(katalog)) {
    const sciezka = join(katalog, nazwa);
    if (statSync(sciezka).isDirectory()) yield* plikiKatalogu(sciezka);
    else yield sciezka;
  }
}

/** Wartości sekretów z lokalnych plików env. Same wartości zostają w pamięci, nigdy w wyniku. */
function sekretyLokalne() {
  const wartosci = new Set();
  for (const plik of PLIKI_ENV.filter(existsSync)) {
    for (const linia of readFileSync(plik, "utf8").split(/\r?\n/)) {
      const dopasowanie = /^([A-Z0-9_]+)=(.+)$/.exec(linia.trim());
      if (dopasowanie && NAZWA_SEKRETU.test(dopasowanie[1]) && dopasowanie[2].trim().length >= MIN_DLUGOSC_SEKRETU) {
        wartosci.add(dopasowanie[2].trim());
      }
    }
  }
  return [...wartosci];
}

const SEKRETY = sekretyLokalne();

function czyZawieraKlucz(plik) {
  try {
    const tresc = readFileSync(plik, "utf8");
    return WZOR.test(tresc) || SEKRETY.some((sekret) => tresc.includes(sekret));
  } catch {
    return false; // plik zniknął albo nie da się go przeczytać jako tekstu
  }
}

const sledzone = execSync("git ls-files --cached --others --exclude-standard", { encoding: "utf8" })
  .split(/\r?\n/)
  .filter((plik) => plik && existsSync(plik));
const doPrzegladarki = KATALOGI_PRZEGLADARKI.filter(existsSync).flatMap((k) => [...plikiKatalogu(k)]);
const znalezione = [...sledzone, ...doPrzegladarki].filter(czyZawieraKlucz);

if (znalezione.length > 0) {
  console.error("Wygląda na klucz (Stripe, Voucherify albo Resend) w:");
  for (const plik of znalezione) console.error(`  ${plik}`);
  process.exit(1);
}
console.log(
  `Brak kluczy w ${sledzone.length} plikach repozytorium i ${doPrzegladarki.length} plikach dla przeglądarki` +
    (SEKRETY.length ? ` (także ${SEKRETY.length} wartości z lokalnych plików env).` : "."),
);
