"use client";

// Okresowe odświeżanie z: AbortController na każde żądanie, pauzą przy ukrytej karcie,
// backoffem przy błędach i zatrzymaniem po kilku porażkach (wtedy `odswiez()` wznawia).
//
// Interwał jest adaptacyjny: gdy kolejne odpowiedzi nic nie zmieniają, rośnie (× `mnoznik`
// aż do `maxInterwalMs`), a wraca do `interwalMs`, gdy coś się zmieni, użytkownik wróci na kartę
// albo zawoła `przyspiesz()` (np. przy interakcji z mapą). Na spokojnej sali to kilka razy mniej żądań.
// Wszystkie timery i nasłuchy są sprzątane przy odmontowaniu.

import { useCallback, useEffect, useRef, useState } from "react";
import { czyPrzerwane, opoznienieBackoff } from "@/lib/klient/api";

export interface OpcjePollingu<T> {
  /** Interwał bazowy (po zmianie danych i po interakcji). */
  interwalMs: number;
  /** Górna granica interwału, gdy dane się nie zmieniają. Domyślnie = interwalMs (bez adaptacji). */
  maxInterwalMs?: number;
  mnoznik?: number;
  /** Opóźnienie pierwszego pobrania. Domyślnie interwalMs (dane startowe dał serwer). */
  pierwszeZaMs?: number;
  maxPorazek?: number;
  wlaczony?: boolean;
  /** Czy nowe dane różnią się od poprzednich. Domyślnie porównanie referencji. */
  czyZmiana?: (poprzednie: T | undefined, nowe: T) => boolean;
}

export interface StanPollingu<T> {
  dane: T | undefined;
  blad: Error | undefined;
  /** true po `maxPorazek` porażkach z rzędu; polling stoi do wywołania `odswiez()`. */
  zatrzymany: boolean;
  /** Epoch ms ostatniego udanego sprawdzenia (także „bez zmian"); null przed pierwszym. */
  ostatniaAktualizacja: number | null;
  odswiez: () => void;
  /** Wraca do interwału bazowego (np. użytkownik właśnie patrzy na mapę). */
  przyspiesz: () => void;
}

interface Stan<T> {
  dane: T | undefined;
  blad: Error | undefined;
  zatrzymany: boolean;
  ostatniaAktualizacja: number | null;
}

const domyslnaZmiana = <T,>(a: T | undefined, b: T) => !Object.is(a, b);

export function usePolling<T>(
  pobierz: (sygnal: AbortSignal, poprzednie: T | undefined) => Promise<T>,
  {
    interwalMs,
    maxInterwalMs = interwalMs,
    mnoznik = 1.5,
    pierwszeZaMs,
    maxPorazek = 4,
    wlaczony = true,
    czyZmiana = domyslnaZmiana,
  }: OpcjePollingu<T>,
): StanPollingu<T> {
  const [stan, ustawStan] = useState<Stan<T>>({
    dane: undefined,
    blad: undefined,
    zatrzymany: false,
    ostatniaAktualizacja: null,
  });
  const [cykl, ustawCykl] = useState(0);
  const pobierzRef = useRef(pobierz);
  const czyZmianaRef = useRef(czyZmiana);
  const natychmiastRef = useRef(false);
  const przyspieszRef = useRef<() => void>(() => {});

  useEffect(() => {
    pobierzRef.current = pobierz;
    czyZmianaRef.current = czyZmiana;
  });

  useEffect(() => {
    if (!wlaczony) return;
    let aktywny = true;
    let porazki = 0;
    let biezacyInterwal = interwalMs;
    let poprzednie: T | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let zaplanowanoNa = 0;
    let kontroler: AbortController | null = null;

    const zaplanuj = (ms: number) => {
      clearTimeout(timer);
      zaplanowanoNa = Date.now() + ms;
      timer = setTimeout(krok, ms);
    };

    async function krok() {
      if (!aktywny || kontroler) return;
      // Ukryta karta: nic nie pobieramy, wznowi nas zdarzenie visibilitychange.
      if (document.visibilityState === "hidden") return;
      kontroler = new AbortController();
      try {
        const dane = await pobierzRef.current(kontroler.signal, poprzednie);
        if (!aktywny) return;
        porazki = 0;
        const zmiana = czyZmianaRef.current(poprzednie, dane);
        biezacyInterwal = zmiana ? interwalMs : Math.min(maxInterwalMs, Math.round(biezacyInterwal * mnoznik));
        poprzednie = dane;
        ustawStan({ dane, blad: undefined, zatrzymany: false, ostatniaAktualizacja: Date.now() });
        zaplanuj(biezacyInterwal);
      } catch (blad) {
        if (!aktywny || czyPrzerwane(blad)) return;
        porazki++;
        const zatrzymany = porazki >= maxPorazek;
        ustawStan((s) => ({ ...s, blad: blad instanceof Error ? blad : new Error(String(blad)), zatrzymany }));
        if (!zatrzymany) zaplanuj(interwalMs + opoznienieBackoff(porazki));
      } finally {
        kontroler = null;
      }
    }

    przyspieszRef.current = () => {
      if (!aktywny || porazki >= maxPorazek) return;
      biezacyInterwal = interwalMs;
      // Następne sprawdzenie najpóźniej za interwał bazowy.
      if (!kontroler && zaplanowanoNa - Date.now() > interwalMs) zaplanuj(interwalMs);
    };

    const naZmianeWidocznosci = () => {
      if (document.visibilityState === "visible") {
        biezacyInterwal = interwalMs;
        if (porazki < maxPorazek) zaplanuj(0);
      } else {
        clearTimeout(timer);
        kontroler?.abort();
      }
    };

    document.addEventListener("visibilitychange", naZmianeWidocznosci);
    zaplanuj(natychmiastRef.current ? 0 : (pierwszeZaMs ?? interwalMs));
    natychmiastRef.current = false;

    return () => {
      aktywny = false;
      przyspieszRef.current = () => {};
      clearTimeout(timer);
      kontroler?.abort();
      document.removeEventListener("visibilitychange", naZmianeWidocznosci);
    };
  }, [interwalMs, maxInterwalMs, mnoznik, pierwszeZaMs, maxPorazek, wlaczony, cykl]);

  const odswiez = useCallback(() => {
    natychmiastRef.current = true;
    ustawStan((s) => ({ ...s, blad: undefined, zatrzymany: false }));
    ustawCykl((c) => c + 1);
  }, []);

  const przyspiesz = useCallback(() => przyspieszRef.current(), []);

  return { ...stan, odswiez, przyspiesz };
}
