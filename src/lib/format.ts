// Formatowanie dat seansów w strefie kina (Europe/Warsaw), niezależnie od strefy serwera i przeglądarki,
// i cen w groszach.

const STREFA = "Europe/Warsaw";

const krotka = new Intl.DateTimeFormat("pl-PL", {
  timeZone: STREFA,
  weekday: "short",
  day: "numeric",
  month: "numeric",
});
const godzina = new Intl.DateTimeFormat("pl-PL", { timeZone: STREFA, hour: "2-digit", minute: "2-digit" });
const godzinaZSekundami = new Intl.DateTimeFormat("pl-PL", {
  timeZone: STREFA,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const pelna = new Intl.DateTimeFormat("pl-PL", {
  timeZone: STREFA,
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

/** 3200 → "32 zł", 3250 → "32,50 zł". Kwoty w całym systemie są w groszach, jak w API. */
export function formatujCene(grosze: number): string {
  const zlote = Math.floor(grosze / 100);
  const reszta = grosze % 100;
  return reszta === 0 ? `${zlote} zł` : `${zlote},${String(reszta).padStart(2, "0")} zł`;
}

/** "pt 6.11" */
export function formatujDzien(iso: string): string {
  const czesci = krotka.formatToParts(new Date(iso));
  const dzienTygodnia = (czesci.find((c) => c.type === "weekday")?.value ?? "").replace(/\.$/, "");
  const dzien = czesci.find((c) => c.type === "day")?.value ?? "";
  const miesiac = czesci.find((c) => c.type === "month")?.value ?? "";
  return `${dzienTygodnia} ${dzien}.${miesiac}`;
}

/** "19:30" */
export function formatujGodzine(iso: string): string {
  return godzina.format(new Date(iso));
}

/** "19:30:05" */
export function formatujGodzineZSekundami(ms: number): string {
  return godzinaZSekundami.format(new Date(ms));
}

/** "piątek, 6 listopada 2026" */
export function formatujDatePelna(iso: string): string {
  return pelna.format(new Date(iso));
}

/** "pt 6.11 · 19:30" */
export function formatujTermin(iso: string): string {
  return `${formatujDzien(iso)} · ${formatujGodzine(iso)}`;
}
