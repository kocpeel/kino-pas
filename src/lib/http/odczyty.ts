// Odczyty z cache i degradacją. Używane przez API i przez strony serwerowe,
// więc obie drogi mają te same zasady świeżości i ten sam fallback.

import { BladDomenowy, czyBladDomenowy } from "../domain/bledy";
import { czyPoprawneIdSeansu } from "../domain/rezerwacja";
import type { SeansNaLiscie, SzczegolySeansu } from "../domain/typy";
import { listaSeansow, szczegolySeansu } from "../db/zapytania-seanse";
import type { Zaleznosci } from "../zaleznosci";
import { wPuli } from "./obsluga-trasy";

const KLUCZ_LISTY = "lista";
const URL_LISTY_NA_KRAWEDZI = "https://kasa-kino.cache/lista-seansow";
const MAX_WIEK_LISTY_NA_KRAWEDZI_S = 600;
/** Mapa może być nieaktualna o sekundę: ostatnie słowo i tak ma warunkowy zapis (409). */
export const TTL_SZCZEGOLOW_MS = 1000;

export interface WynikOdczytu<T> {
  dane: T;
  /** true = dane z cache, bo baza zawiodła albo system jest przeciążony (tryb awaryjny). */
  nieaktualne: boolean;
  wiekMs: number;
}

async function listaZKrawedzi(z: Zaleznosci, teraz: number): Promise<{ wartosc: SeansNaLiscie[]; wiekMs: number } | undefined> {
  if (!z.cacheKrawedzi) return undefined;
  try {
    const odpowiedz = await z.cacheKrawedzi.match(URL_LISTY_NA_KRAWEDZI);
    if (!odpowiedz) return undefined;
    const zapis = (await odpowiedz.json()) as { seanse?: unknown; zapisano?: unknown };
    if (!Array.isArray(zapis.seanse) || typeof zapis.zapisano !== "number") return undefined;
    return { wartosc: zapis.seanse as SeansNaLiscie[], wiekMs: teraz - zapis.zapisano };
  } catch {
    return undefined;
  }
}

function zapiszListeNaKrawedzi(z: Zaleznosci, seanse: SeansNaLiscie[], teraz: number): void {
  if (!z.cacheKrawedzi) return;
  const odpowiedz = new Response(JSON.stringify({ seanse, zapisano: teraz }), {
    headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${MAX_WIEK_LISTY_NA_KRAWEDZI_S}` },
  });
  const zapis = z.cacheKrawedzi.put(URL_LISTY_NA_KRAWEDZI, odpowiedz).catch(() => {});
  z.wTle?.(zapis);
}

/** Lista seansów z liczbą wolnych foteli. Gdy D1 zawodzi, zwraca ostatnie znane dane. */
export async function pobierzRepertuar(z: Zaleznosci): Promise<WynikOdczytu<SeansNaLiscie[]>> {
  const teraz = z.zegar.teraz();
  const wpis = z.cache.lista.pobierz(KLUCZ_LISTY, teraz);
  if (wpis && wpis.wiekMs < z.konfiguracja.cacheListyMs) {
    return { dane: wpis.wartosc, nieaktualne: false, wiekMs: wpis.wiekMs };
  }
  try {
    const seanse = await wPuli(z, "lista", (db) => listaSeansow(db, teraz));
    z.cache.lista.zapisz(KLUCZ_LISTY, seanse, teraz);
    zapiszListeNaKrawedzi(z, seanse, teraz);
    return { dane: seanse, nieaktualne: false, wiekMs: 0 };
  } catch (blad) {
    const awaryjne = wpis ?? (await listaZKrawedzi(z, teraz));
    if (awaryjne) return { dane: awaryjne.wartosc, nieaktualne: true, wiekMs: awaryjne.wiekMs };
    throw blad;
  }
}

/** Seans i zajęte fotele (same `seatId`). */
export async function pobierzSzczegoly(z: Zaleznosci, eventId: string): Promise<WynikOdczytu<SzczegolySeansu>> {
  if (!czyPoprawneIdSeansu(eventId)) throw new BladDomenowy("NIE_ZNALEZIONO", { komunikat: "Nie ma takiego seansu." });
  const teraz = z.zegar.teraz();
  const wpis = z.cache.szczegoly.pobierz(eventId, teraz);
  if (wpis && wpis.wiekMs < TTL_SZCZEGOLOW_MS) return { dane: wpis.wartosc, nieaktualne: false, wiekMs: wpis.wiekMs };
  try {
    const wynik = await wPuli(z, "szczegoly", (db) => szczegolySeansu(db, eventId, teraz));
    if (!wynik) throw new BladDomenowy("NIE_ZNALEZIONO", { komunikat: "Nie ma takiego seansu." });
    z.cache.szczegoly.zapisz(eventId, wynik, teraz);
    return { dane: wynik, nieaktualne: false, wiekMs: 0 };
  } catch (blad) {
    if (czyBladDomenowy(blad) && blad.rodzaj === "NIE_ZNALEZIONO") throw blad;
    if (wpis) return { dane: wpis.wartosc, nieaktualne: true, wiekMs: wpis.wiekMs };
    throw blad;
  }
}

/** Po udanym zapisie ten izolat od razu pokazuje nowy stan mapy. */
export function uniewaznijSzczegoly(z: Zaleznosci, eventId: string): void {
  z.cache.szczegoly.usun(eventId);
}
