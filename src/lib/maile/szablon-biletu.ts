// Mail z biletem (karta C etapu III): kod, seans, miejsce i podsumowanie zakupu: ile kartą, ile punktami
// i ile punktów klient zebrał. Proste HTML z inline'owymi stylami (klienty poczty nie czytają arkuszy)
// i wersja tekstowa. Dane od klienta (imię) i z bazy zawsze przez `ucieczka`.

import { formatujCene, formatujTermin } from "../format";
import { opisMiejsca } from "../domain/uklad-sali";
import type { Mail } from "./resend";

export interface DaneMailaBiletu {
  email: string;
  imie: string;
  kod: string;
  film: string | null;
  startsAt: string | null;
  sala: string | null;
  seatId: string;
  /** Grosze zapłacone kartą. */
  kwotaKarta: number;
  punktyUzyte: number;
  punktyZebrane: number;
  /** Strona biletu w sklepie; null, gdy nie znamy adresu. */
  adresBiletu: string | null;
  reservationId: string;
}

export function ucieczka(tekst: string): string {
  return tekst.replace(/[&<>"']/g, (z) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[z] as string);
}

export function opisPunktow(punkty: number): string {
  return punkty > 0 ? `${punkty} pkt (${formatujCene(punkty)})` : "nie użyto";
}

export function mailBiletu(d: DaneMailaBiletu): Mail {
  const film = d.film ?? "Seans";
  const termin = d.startsAt ? formatujTermin(d.startsAt) : null;
  const miejsce = opisMiejsca(d.seatId);
  const seans = [termin, d.sala, miejsce].filter(Boolean).join(" · ");
  const wiersze: [string, string][] = [
    ["Zapłacono kartą", formatujCene(d.kwotaKarta)],
    ["Zapłacono punktami", opisPunktow(d.punktyUzyte)],
    ["Zebrane punkty", `+${d.punktyZebrane} pkt`],
  ];

  const tekst = [
    `Cześć ${d.imie},`,
    "",
    `oto Twój bilet: ${film}`,
    seans,
    "",
    `Kod biletu: ${d.kod}`,
    "Pokaż go przy wejściu na salę.",
    "",
    ...wiersze.map(([k, v]) => `${k}: ${v}`),
    ...(d.adresBiletu ? ["", `Bilet w sklepie: ${d.adresBiletu}`] : []),
    "",
    "Kino Pas",
  ].join("\n");

  const komorka = "padding:6px 0;border-bottom:1px solid #e5e2d8";
  const html = `<!doctype html>
<html lang="pl"><body style="margin:0;background:#f5f3ec;font-family:Arial,Helvetica,sans-serif;color:#1d1b16">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fffdf7;border-radius:12px;padding:24px">
<tr><td>
<p style="margin:0 0 4px;font-size:12px;letter-spacing:2px;color:#6b665a">KINO PAS · BILET WSTĘPU</p>
<h1 style="margin:0 0 8px;font-size:22px">${ucieczka(film)}</h1>
<p style="margin:0 0 16px;color:#4a463d">${ucieczka(seans)}</p>
<p style="margin:0 0 4px;font-size:12px;letter-spacing:2px;color:#6b665a">KOD BILETU</p>
<p style="margin:0 0 4px;font-size:30px;font-family:'Courier New',monospace;font-weight:bold;letter-spacing:4px">${ucieczka(d.kod)}</p>
<p style="margin:0 0 20px;color:#4a463d">Pokaż ten kod przy wejściu na salę.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">
${wiersze.map(([k, v]) => `<tr><td style="${komorka};color:#4a463d">${ucieczka(k)}</td><td align="right" style="${komorka};font-weight:bold">${ucieczka(v)}</td></tr>`).join("\n")}
</table>
${d.adresBiletu ? `<p style="margin:20px 0 0"><a href="${ucieczka(d.adresBiletu)}" style="color:#7a4b00">Otwórz bilet w sklepie</a></p>` : ""}
<p style="margin:20px 0 0;font-size:12px;color:#6b665a">Cześć ${ucieczka(d.imie)}, dziękujemy za zakup. Kino Pas</p>
</td></tr></table>
</td></tr></table>
</body></html>`;

  return {
    do: d.email,
    temat: `Bilet: ${film}${termin ? `, ${termin}` : ""} (kod ${d.kod})`,
    html,
    tekst,
    tagi: [{ name: "typ", value: "bilet" }],
  };
}
