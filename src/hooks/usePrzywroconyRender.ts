"use client";

// Next.js przy „Wstecz" pokazuje stronę z pamięci routera, czyli stary render serwera.
// Strona dostaje od serwera znacznik renderu; jeśli komponent montuje się ponownie z TYM SAMYM
// znacznikiem, oglądamy dane z pamięci i trzeba je od razu odświeżyć.
// Porównanie znaczników (zamiast wieku liczonego zegarem przeglądarki) nie zależy od rozjazdu zegarów.
// Natychmiastowy ponowny montaż (StrictMode w dev) nie jest powrotem: liczy się dopiero przerwa > 50 ms.

import { useEffect, useRef } from "react";

const MIN_PRZERWA_MS = 50;

// Jeden wpis na stronę (klucz), więc rozmiar ogranicza liczba różnych stron w karcie.
const ostatnie = new Map<string, { znacznik: number; odmontowano: number | null }>();

/** Wywołuje `akcja`, gdy ten sam render serwera został pokazany ponownie (np. po „Wstecz"). */
export function usePoPrzywroceniu(klucz: string, znacznikRenderu: number | undefined, akcja: () => void): void {
  const akcjaRef = useRef(akcja);
  useEffect(() => {
    akcjaRef.current = akcja;
  });

  useEffect(() => {
    if (znacznikRenderu === undefined) return;
    const poprzedni = ostatnie.get(klucz);
    const przywrocony =
      poprzedni?.znacznik === znacznikRenderu &&
      poprzedni.odmontowano !== null &&
      Date.now() - poprzedni.odmontowano > MIN_PRZERWA_MS;
    const wpis = { znacznik: znacznikRenderu, odmontowano: null as number | null };
    ostatnie.set(klucz, wpis);
    if (przywrocony) akcjaRef.current();
    return () => {
      wpis.odmontowano = Date.now();
    };
  }, [klucz, znacznikRenderu]);
}
