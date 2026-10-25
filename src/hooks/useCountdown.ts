"use client";

// Licznik liczony zawsze jako różnica `expiresAt` − teraz (z poprawką na zegar serwera),
// a nie przez odejmowanie sekund, więc nie dryfuje i jest poprawny po powrocie na kartę.
// Jeden timer wyrównany do pełnych sekund, sprzątany przy odmontowaniu.

import { useEffect, useState } from "react";

export interface StanLicznika {
  /** null do pierwszego przeliczenia po zamontowaniu (brak rozjazdu SSR/hydratacji). */
  pozostaloMs: number | null;
  wygasla: boolean;
}

export function pozostaloDo(expiresAt: number, przesuniecieZegara: number, terazKlienta = Date.now()): number {
  return Math.max(0, expiresAt - (terazKlienta + przesuniecieZegara));
}

/** 872_000 → "14:32". Zaokrąglamy w górę, więc "00:00" pojawia się dopiero przy wygaśnięciu. */
export function formatujPozostalo(ms: number): string {
  const sekundy = Math.ceil(ms / 1000);
  const minuty = Math.floor(sekundy / 60);
  return `${String(minuty).padStart(2, "0")}:${String(sekundy % 60).padStart(2, "0")}`;
}

export function useCountdown(expiresAt: number | null, przesuniecieZegara = 0): StanLicznika {
  const [pozostaloMs, ustawPozostalo] = useState<number | null>(null);

  useEffect(() => {
    if (expiresAt === null) {
      ustawPozostalo(null);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tik = () => {
      clearTimeout(timer);
      const pozostalo = pozostaloDo(expiresAt, przesuniecieZegara);
      ustawPozostalo(pozostalo);
      if (pozostalo > 0) {
        // Następny tik tuż po zmianie wyświetlanej sekundy.
        const doZmiany = pozostalo % 1000 || 1000;
        timer = setTimeout(tik, doZmiany + 5);
      }
    };

    const naZmianeWidocznosci = () => {
      if (document.visibilityState === "visible") tik();
    };

    tik();
    document.addEventListener("visibilitychange", naZmianeWidocznosci);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", naZmianeWidocznosci);
    };
  }, [expiresAt, przesuniecieZegara]);

  return { pozostaloMs, wygasla: pozostaloMs === 0 };
}
