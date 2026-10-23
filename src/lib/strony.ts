// Wspólne wczytywanie danych dla stron serwerowych. `cache` z Reacta deduplikuje
// odczyt w obrębie jednego renderu (np. strona + metadane).

import { cache } from "react";
import { zaleznosciZadania } from "./db/kontekst";
import { czyBladDomenowy } from "./domain/bledy";
import type { SzczegolySeansu } from "./domain/typy";
import { pobierzSzczegoly } from "./http/odczyty";

export type StanSeansu =
  | { rodzaj: "ok"; dane: SzczegolySeansu; nieaktualne: boolean }
  | { rodzaj: "brak" }
  | { rodzaj: "niedostepne" };

export const wczytajSeans = cache(async (eventId: string): Promise<StanSeansu> => {
  try {
    const wynik = await pobierzSzczegoly(zaleznosciZadania(), eventId);
    return { rodzaj: "ok", dane: wynik.dane, nieaktualne: wynik.nieaktualne };
  } catch (blad) {
    if (czyBladDomenowy(blad) && blad.rodzaj === "NIE_ZNALEZIONO") return { rodzaj: "brak" };
    console.error("Seans niedostępny:", blad);
    return { rodzaj: "niedostepne" };
  }
});

/** Pierwsza wartość parametru adresu (Next podaje string | string[] | undefined). */
export function parametr(wartosc: string | string[] | undefined): string | null {
  const pierwsza = Array.isArray(wartosc) ? wartosc[0] : wartosc;
  return typeof pierwsza === "string" && pierwsza.length > 0 ? pierwsza : null;
}
