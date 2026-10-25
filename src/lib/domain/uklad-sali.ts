// Układ sali: rzędy A–H × miejsca 1–10. Czysta logika, bez zależności,
// importowana też przez seed (Node z type stripping), więc bez składni wyłącznie-TS.

export interface UkladSali {
  rzedy: number;
  miejscaWRzedzie: number;
}

export const DOMYSLNY_UKLAD: UkladSali = { rzedy: 8, miejscaWRzedzie: 10 };

const LITERY = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// Wielkie litery są celowe: "f7" jest odrzucane, a nie po cichu poprawiane,
// żeby jeden fotel miał dokładnie jedną reprezentację w adresach i w bazie.
const WZOR_MIEJSCA = /^([A-Z])([1-9][0-9]?)$/;

export function literaRzedu(indeks: number): string {
  const litera = LITERY[indeks];
  if (litera === undefined) throw new RangeError(`Brak litery dla rzędu ${indeks}`);
  return litera;
}

export function rzedySali(uklad: UkladSali = DOMYSLNY_UKLAD): string[] {
  return Array.from({ length: uklad.rzedy }, (_, i) => literaRzedu(i));
}

export function wszystkieMiejsca(uklad: UkladSali = DOMYSLNY_UKLAD): string[] {
  const wynik: string[] = [];
  for (const rzad of rzedySali(uklad)) {
    for (let numer = 1; numer <= uklad.miejscaWRzedzie; numer++) wynik.push(`${rzad}${numer}`);
  }
  return wynik;
}

export interface Miejsce {
  rzad: string;
  numer: number;
}

/** Zwraca rząd i numer albo null, gdy `seatId` nie istnieje w tym układzie. */
export function parsujMiejsce(seatId: unknown, uklad: UkladSali = DOMYSLNY_UKLAD): Miejsce | null {
  if (typeof seatId !== "string") return null;
  const dopasowanie = WZOR_MIEJSCA.exec(seatId);
  if (!dopasowanie) return null;
  const rzad = dopasowanie[1] as string;
  const numer = Number(dopasowanie[2]);
  const indeksRzedu = LITERY.indexOf(rzad);
  if (indeksRzedu < 0 || indeksRzedu >= uklad.rzedy) return null;
  if (numer < 1 || numer > uklad.miejscaWRzedzie) return null;
  return { rzad, numer };
}

export function czyPoprawneMiejsce(seatId: unknown, uklad: UkladSali = DOMYSLNY_UKLAD): seatId is string {
  return parsujMiejsce(seatId, uklad) !== null;
}

/** "F7" → "Rząd F, miejsce 7". */
export function opisMiejsca(seatId: string): string {
  const miejsce = parsujMiejsce(seatId, { rzedy: 26, miejscaWRzedzie: 99 });
  return miejsce ? `Rząd ${miejsce.rzad}, miejsce ${miejsce.numer}` : seatId;
}

export function liczbaMiejsc(uklad: UkladSali = DOMYSLNY_UKLAD): number {
  return uklad.rzedy * uklad.miejscaWRzedzie;
}
