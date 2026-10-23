// Formatowanie dat seansów w strefie kina (Europe/Warsaw), niezależnie od strefy serwera i przeglądarki.

const STREFA = "Europe/Warsaw";

const krotka = new Intl.DateTimeFormat("pl-PL", {
  timeZone: STREFA,
  weekday: "short",
  day: "numeric",
  month: "numeric",
});
const godzina = new Intl.DateTimeFormat("pl-PL", { timeZone: STREFA, hour: "2-digit", minute: "2-digit" });
const pelna = new Intl.DateTimeFormat("pl-PL", {
  timeZone: STREFA,
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

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

/** "piątek, 6 listopada 2026" */
export function formatujDatePelna(iso: string): string {
  return pelna.format(new Date(iso));
}

/** "pt 6.11 · 19:30" */
export function formatujTermin(iso: string): string {
  return `${formatujDzien(iso)} · ${formatujGodzine(iso)}`;
}
