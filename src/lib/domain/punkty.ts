// Zasady programu punktowego (etap III). Wspólne dla wszystkich wariantów: różni się tylko cena.
// 1 punkt = 1 grosz. Punktami można zapłacić najwyżej połowę ceny, resztę kartą przez Stripe.
// Punkty za zakup liczymy tylko od części zapłaconej kartą, od pełnych złotych.

import { BladDomenowy } from "./bledy";

export const PUNKTY_POWITALNE = 1000;
export const PUNKTY_ZA_ZLOTY = 10;

/** Najwięcej punktów, jakie można wydać na bilet: połowa ceny (w groszach), w dół. */
export function maksPunktow(amount: number): number {
  return Math.floor(amount / 2);
}

/** Ile klient dopłaca kartą (grosze). */
export function doZaplatyKarta(amount: number, punkty: number): number {
  return amount - punkty;
}

/** Punkty za zakup: 10 za każdy pełny złoty zapłacony kartą. */
export function punktyZaZakup(kwotaKarta: number): number {
  return Math.floor(Math.max(0, kwotaKarta) / 100) * PUNKTY_ZA_ZLOTY;
}

/**
 * Pole `points` z ciała checkoutu. Brak = 0, czyli płatność jak w etapie II. Zła wartość albo więcej niż
 * połowa ceny to 400; za mało punktów na koncie to osobna odmowa (sprawdza ją Voucherify).
 */
export function walidujPunkty(surowe: unknown, amount: number): number {
  if (surowe === undefined || surowe === null) return 0;
  if (typeof surowe !== "number" || !Number.isSafeInteger(surowe) || surowe < 0) {
    throw new BladDomenowy("NIEPOPRAWNE_DANE", {
      komunikat: "Liczba punktów musi być nieujemną liczbą całkowitą.",
      szczegoly: { points: "Podaj liczbę całkowitą, np. 1000." },
    });
  }
  const maks = maksPunktow(amount);
  if (surowe > maks) {
    throw new BladDomenowy("NIEPOPRAWNE_DANE", {
      komunikat: `Punktami można zapłacić najwyżej połowę ceny: ${maks} pkt.`,
      szczegoly: { points: `Najwyżej ${maks} pkt.` },
    });
  }
  return surowe;
}
