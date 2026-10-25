"use client";

// „Zaktualizowano X s temu". Renderuje tekst dopiero po zamontowaniu (brak rozjazdu z SSR),
// a jedyny timer jest sprzątany przy odmontowaniu.

import { useEffect, useState } from "react";

export function CzasOdswiezenia({ kiedy }: { kiedy: number | null }) {
  const [teraz, ustawTeraz] = useState<number | null>(null);

  useEffect(() => {
    ustawTeraz(Date.now());
    const timer = setInterval(() => ustawTeraz(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (teraz === null || kiedy === null) return <span>Zaktualizowano przed chwilą</span>;
  const sekundy = Math.max(0, Math.round((teraz - kiedy) / 1000));
  return (
    <span className="cyfry">{sekundy < 2 ? "Zaktualizowano przed chwilą" : `Zaktualizowano ${sekundy} s temu`}</span>
  );
}
