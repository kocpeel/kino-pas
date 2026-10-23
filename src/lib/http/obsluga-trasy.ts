// Wrapper wspólny dla wszystkich route handlerów: zależności, mapowanie błędów,
// pule load sheddingu i timeout na pracę z bazą.

import { BladDomenowy, czyBladDomenowy } from "../domain/bledy";
import { zTimeoutem } from "../resilience/timeout";
import type { Priorytet } from "../resilience/przeciazenie";
import type { Zaleznosci } from "../zaleznosci";
import { odpowiedzBledu } from "./odpowiedzi";

export type DostawcaZaleznosci = () => Zaleznosci;

/** Wywołuje handler i zamienia każdy wyjątek na kontrolowaną odpowiedź. */
export async function obsluzTrase(
  dostawca: DostawcaZaleznosci,
  handler: (z: Zaleznosci) => Promise<Response>,
): Promise<Response> {
  try {
    return await handler(dostawca());
  } catch (blad) {
    return odpowiedzBledu(blad);
  }
}

export function wymagajBazy(z: Zaleznosci): D1Database {
  if (!z.db) throw new BladDomenowy("NIEDOSTEPNE", { komunikat: "Baza danych jest niedostępna." });
  return z.db;
}

/**
 * Wykonuje pracę na bazie w puli danego priorytetu (503 przy przeciążeniu) i z timeoutem.
 * Każdy błąd spoza domeny (awaria D1, zerwane połączenie) staje się 503 zamiast 500,
 * bo dla klienta znaczy to samo: „spróbuj za chwilę".
 */
export async function wPuli<T>(
  z: Zaleznosci,
  priorytet: Priorytet,
  praca: (db: D1Database) => Promise<T>,
): Promise<T> {
  const zwolnij = z.straznik.wejdz(priorytet);
  try {
    const db = wymagajBazy(z);
    return await zTimeoutem(praca(db), z.konfiguracja.timeoutBazyMs);
  } catch (blad) {
    if (czyBladDomenowy(blad)) throw blad;
    console.error(`Błąd bazy (${priorytet}):`, blad);
    throw new BladDomenowy("NIEDOSTEPNE", { przyczyna: blad, ponowZaS: 2 });
  } finally {
    zwolnij();
  }
}
