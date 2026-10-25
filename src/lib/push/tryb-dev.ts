// Gdzie jest kanał na żywo w danym trybie:
// - produkcja i `npm run preview`: worker.ts, ta sama domena co strona,
// - `npm run dev`: osobny Worker sali (workers/sala-dev), bo `next dev` nie uruchamia worker.ts;
//   jego adres ustawia scripts/dev.mjs w zmiennej SALA_DEV_URL,
// - samo `next dev` bez Workera sali: kanału nie ma, mapa używa odpytywania.

import { sciezkaNaZywo } from "./protokol";

export function czyNextDev(): boolean {
  return typeof process !== "undefined" && process.env.NODE_ENV === "development";
}

/** Adres Workera sali w `npm run dev` (np. http://localhost:8789) albo null. */
export function adresSaliDev(): string | null {
  const adres = typeof process !== "undefined" ? process.env.SALA_DEV_URL : undefined;
  return adres && /^https?:\/\/[^/]+\/?$/.test(adres) ? adres.replace(/\/$/, "") : null;
}

/** Adres kanału dla mapy: ścieżka na tej samej domenie, adres Workera sali w dev albo null (bez kanału). */
export function adresKanaluNaZywo(eventId: string): string | null {
  if (!czyNextDev()) return sciezkaNaZywo(eventId);
  const sala = adresSaliDev();
  return sala ? `${sala}${sciezkaNaZywo(eventId)}` : null;
}
