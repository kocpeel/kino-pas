"use client";

// Utrzymuje liczby wolnych miejsc w repertuarze aktualnymi bez ciągłego odpytywania:
// odświeża stronę (router.refresh) po powrocie przyciskiem „Wstecz" (stary render z pamięci routera),
// po powrocie na kartę i rzadko w tle, tylko gdy karta jest widoczna. Nic nie renderuje.

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { czyPrzywroconyRender } from "@/hooks/usePrzywroconyRender";

export const ODSWIEZANIE_W_TLE_MS = 60_000;
/** Bez częstszych odświeżeń niż co tyle (np. szybkie przełączanie kart). */
export const MIN_ODSTEP_MS = 5_000;

export function OdswiezanieRepertuaru({ wyrenderowano }: { wyrenderowano: number }) {
  const router = useRouter();

  useEffect(() => {
    let ostatnio = Date.now();
    const odswiez = (wymus = false) => {
      if (!wymus && Date.now() - ostatnio < MIN_ODSTEP_MS) return;
      ostatnio = Date.now();
      router.refresh();
    };

    if (czyPrzywroconyRender("repertuar", wyrenderowano)) odswiez(true);

    const naZmianeWidocznosci = () => {
      if (document.visibilityState === "visible") odswiez();
    };
    // Strona przywrócona z bfcache przeglądarki (bez ponownego montażu Reacta).
    const naPokazanie = (zdarzenie: PageTransitionEvent) => {
      if (zdarzenie.persisted) odswiez(true);
    };
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") odswiez();
    }, ODSWIEZANIE_W_TLE_MS);

    document.addEventListener("visibilitychange", naZmianeWidocznosci);
    window.addEventListener("pageshow", naPokazanie);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", naZmianeWidocznosci);
      window.removeEventListener("pageshow", naPokazanie);
    };
  }, [router, wyrenderowano]);

  return null;
}
