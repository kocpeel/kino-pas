// Mail z ofertą z listy oczekujących (karta C etapu IV): nazwa wydarzenia, miejsce, link do zapłaty i godzina,
// do której miejsce czeka. Ten sam styl co mail z biletem; dane od klienta i z bazy zawsze przez `ucieczka`.

import { formatujCene, formatujGodzineZSekundami, formatujTermin } from "../format";
import { opisMiejsca } from "../domain/uklad-sali";
import type { Mail } from "./resend";
import { ucieczka } from "./szablon-biletu";

export interface DaneMailaOferty {
  email: string;
  imie: string;
  film: string | null;
  startsAt: string | null;
  sala: string | null;
  seatId: string;
  /** Cena w groszach. */
  cena: number;
  /** Do kiedy miejsce czeka (epoch ms): expiresAt rezerwacji z oferty. */
  czekaDo: number;
  /** Strona płatności tej rezerwacji (z punktami albo bez). */
  adresPlatnosci: string;
  /** Strona zapisu na liście: stan i „Wypisz mnie”. */
  adresListy: string | null;
}

export function mailOferty(d: DaneMailaOferty): Mail {
  const film = d.film ?? "Seans";
  const termin = d.startsAt ? formatujTermin(d.startsAt) : null;
  const miejsce = opisMiejsca(d.seatId);
  const seans = [termin, d.sala].filter(Boolean).join(" · ");
  const godzina = formatujGodzineZSekundami(d.czekaDo);

  const tekst = [
    `Cześć ${d.imie},`,
    "",
    `zwolniło się miejsce na wydarzenie, na które czekasz: ${film}`,
    ...(seans ? [seans] : []),
    `Miejsce: ${miejsce} (${formatujCene(d.cena)})`,
    "",
    `Miejsce czeka na Ciebie do ${godzina}. Zapłać przed tą godziną, kartą albo częściowo punktami:`,
    d.adresPlatnosci,
    "",
    "Jeśli nie zapłacisz na czas, miejsce dostanie następna osoba z listy.",
    ...(d.adresListy ? ["", `Nie chcesz już czekać? Wypisz się: ${d.adresListy}`] : []),
    "",
    "Kino Pas",
  ].join("\n");

  const html = `<!doctype html>
<html lang="pl"><body style="margin:0;background:#f5f3ec;font-family:Arial,Helvetica,sans-serif;color:#1d1b16">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fffdf7;border-radius:12px;padding:24px">
<tr><td>
<p style="margin:0 0 4px;font-size:12px;letter-spacing:2px;color:#6b665a">KINO PAS · LISTA OCZEKUJĄCYCH</p>
<h1 style="margin:0 0 8px;font-size:22px">Zwolniło się miejsce: ${ucieczka(film)}</h1>
${seans ? `<p style="margin:0 0 8px;color:#4a463d">${ucieczka(seans)}</p>` : ""}
<p style="margin:0 0 16px;font-size:16px"><strong>${ucieczka(miejsce)}</strong> · ${ucieczka(formatujCene(d.cena))}</p>
<p style="margin:0 0 16px;font-size:16px">Miejsce czeka na Ciebie do <strong>${ucieczka(godzina)}</strong>.</p>
<p style="margin:0 0 20px"><a href="${ucieczka(d.adresPlatnosci)}" style="display:inline-block;background:#7a4b00;color:#fffdf7;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold">Zapłać za miejsce</a></p>
<p style="margin:0 0 8px;color:#4a463d">Możesz zapłacić kartą albo częściowo punktami. Jeśli nie zapłacisz na czas, miejsce dostanie następna osoba z listy.</p>
${d.adresListy ? `<p style="margin:16px 0 0;font-size:13px"><a href="${ucieczka(d.adresListy)}" style="color:#7a4b00">Nie chcę już czekać: wypisz mnie z listy</a></p>` : ""}
<p style="margin:20px 0 0;font-size:12px;color:#6b665a">Cześć ${ucieczka(d.imie)}, ten mail dostajesz, bo zapisałeś się na listę oczekujących. Kino Pas</p>
</td></tr></table>
</td></tr></table>
</body></html>`;

  return {
    do: d.email,
    temat: `Zwolniło się miejsce: ${film}, ${miejsce} (czeka do ${godzina})`,
    html,
    tekst,
    tagi: [{ name: "typ", value: "oferta" }],
  };
}
