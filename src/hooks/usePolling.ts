"use client";

// Okresowe odświeżanie z: AbortController na każde żądanie, pauzą przy ukrytej karcie,
// backoffem przy błędach i zatrzymaniem po kilku porażkach (wtedy `odswiez()` wznawia).
// Wszystkie timery i nasłuchy są sprzątane przy odmontowaniu.

import { useCallback, useEffect, useRef, useState } from "react";
import { czyPrzerwane, opoznienieBackoff } from "@/lib/klient/api";

export interface OpcjePollingu<T> {
  interwalMs: number;
  maxPorazek?: number;
  wlaczony?: boolean;
  poczatkoweDane?: T;
}

export interface StanPollingu<T> {
  dane: T | undefined;
  blad: Error | undefined;
  /** true po `maxPorazek` porażkach z rzędu; polling stoi do wywołania `odswiez()`. */
  zatrzymany: boolean;
  /** Epoch ms ostatniego udanego pobrania (null przed pierwszym). */
  ostatniaAktualizacja: number | null;
  odswiez: () => void;
}

interface Stan<T> {
  dane: T | undefined;
  blad: Error | undefined;
  zatrzymany: boolean;
  ostatniaAktualizacja: number | null;
}

export function usePolling<T>(
  pobierz: (sygnal: AbortSignal) => Promise<T>,
  { interwalMs, maxPorazek = 4, wlaczony = true, poczatkoweDane }: OpcjePollingu<T>,
): StanPollingu<T> {
  const [stan, ustawStan] = useState<Stan<T>>({
    dane: poczatkoweDane,
    blad: undefined,
    zatrzymany: false,
    ostatniaAktualizacja: null,
  });
  const [cykl, ustawCykl] = useState(0);
  const pobierzRef = useRef(pobierz);
  const natychmiastRef = useRef(false);

  useEffect(() => {
    pobierzRef.current = pobierz;
  });

  useEffect(() => {
    if (!wlaczony) return;
    let aktywny = true;
    let porazki = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let kontroler: AbortController | null = null;

    const zaplanuj = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(krok, ms);
    };

    async function krok() {
      if (!aktywny || kontroler) return;
      // Ukryta karta: nic nie pobieramy, wznowi nas zdarzenie visibilitychange.
      if (document.visibilityState === "hidden") return;
      kontroler = new AbortController();
      try {
        const dane = await pobierzRef.current(kontroler.signal);
        if (!aktywny) return;
        porazki = 0;
        ustawStan({ dane, blad: undefined, zatrzymany: false, ostatniaAktualizacja: Date.now() });
        zaplanuj(interwalMs);
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

    const naZmianeWidocznosci = () => {
      if (document.visibilityState === "visible") {
        if (porazki < maxPorazek) zaplanuj(0);
      } else {
        clearTimeout(timer);
        kontroler?.abort();
      }
    };

    document.addEventListener("visibilitychange", naZmianeWidocznosci);
    zaplanuj(natychmiastRef.current ? 0 : interwalMs);
    natychmiastRef.current = false;

    return () => {
      aktywny = false;
      clearTimeout(timer);
      kontroler?.abort();
      document.removeEventListener("visibilitychange", naZmianeWidocznosci);
    };
  }, [interwalMs, maxPorazek, wlaczony, cykl]);

  const odswiez = useCallback(() => {
    natychmiastRef.current = true;
    ustawStan((s) => ({ ...s, blad: undefined, zatrzymany: false }));
    ustawCykl((c) => c + 1);
  }, []);

  return { ...stan, odswiez };
}
