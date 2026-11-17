// Etap III bez bazy: zasady punktów (tabela z treści zadania), klasyfikacja błędów Resend, podpis Svix i mail.

import { describe, expect, it } from "vitest";
import { BladDomenowy } from "../../src/lib/domain/bledy";
import { doZaplatyKarta, maksPunktow, punktyZaZakup, walidujPunkty } from "../../src/lib/domain/punkty";
import { bladZOdpowiedzi, czyPodpisResendPoprawny, TOLERANCJA_PODPISU_S } from "../../src/lib/maile/resend";
import { mailBiletu } from "../../src/lib/maile/szablon-biletu";

describe("zasady punktów: przykład nowego klienta, który wydaje 1000 punktów", () => {
  it.each([
    ["Kino", 3200, 1600, 2200, 220],
    ["Pociąg", 8900, 4450, 7900, 790],
    ["Hotel", 24000, 12000, 23000, 2300],
    ["Koncerty", 15000, 7500, 14000, 1400],
  ])("%s: cena %i gr", (_, cena, maks, karta, zebrane) => {
    expect(maksPunktow(cena)).toBe(maks);
    expect(doZaplatyKarta(cena, 1000)).toBe(karta);
    expect(punktyZaZakup(karta)).toBe(zebrane);
  });

  it("punkty za zakup tylko od pełnych złotych zapłaconych kartą", () => {
    expect(punktyZaZakup(2299)).toBe(220);
    expect(punktyZaZakup(99)).toBe(0);
    expect(punktyZaZakup(3200)).toBe(320);
  });

  it("połowa ceny w dół (nieparzysta kwota)", () => {
    expect(maksPunktow(3201)).toBe(1600);
  });

  it("points: brak = 0; ułamek, ujemne, tekst albo ponad połowę ceny = 400 z opisem pola", () => {
    expect(walidujPunkty(undefined, 3200)).toBe(0);
    expect(walidujPunkty(1600, 3200)).toBe(1600);
    for (const zle of [1601, 10.5, -1, "1000", Number.NaN]) {
      try {
        walidujPunkty(zle, 3200);
        expect.unreachable();
      } catch (blad) {
        expect(blad).toBeInstanceOf(BladDomenowy);
        expect((blad as BladDomenowy).status).toBe(400);
        expect((blad as BladDomenowy).szczegoly).toHaveProperty("points");
      }
    }
  });
});

describe("Resend: błędy trwałe i przejściowe", () => {
  it.each([
    [403, "validation_error", "trwaly"],
    [422, "invalid_parameter", "trwaly"],
    [409, "invalid_idempotent_request", "trwaly"],
    [409, "concurrent_idempotent_requests", "przejsciowy"],
    [429, "rate_limit_exceeded", "przejsciowy"],
    [429, "daily_quota_exceeded", "przejsciowy"],
    [500, "application_error", "przejsciowy"],
    [503, "service_unavailable", "przejsciowy"],
  ])("%i %s → %s", (status, nazwa, rodzaj) => {
    expect(bladZOdpowiedzi(status, nazwa, "", null).rodzaj).toBe(rodzaj);
  });

  it("limit: Retry-After z nagłówka, dzienny limit do północy UTC", () => {
    expect(bladZOdpowiedzi(429, "rate_limit_exceeded", "", "3").ponowZaS).toBe(3);
    const doPolnocy = bladZOdpowiedzi(429, "daily_quota_exceeded", "", null).ponowZaS ?? 0;
    expect(doPolnocy).toBeGreaterThanOrEqual(60);
    expect(doPolnocy).toBeLessThanOrEqual(24 * 3600);
  });
});

describe("podpis Svix webhooka Resend", () => {
  const SEKRET = `whsec_${btoa("sekret-testowy-resend-0123456789")}`;
  const TERAZ = 1_793_000_000_000;

  async function podpis(id: string, ts: number, cialo: string, sekret = SEKRET): Promise<string> {
    const surowe = atob(sekret.slice("whsec_".length));
    const klucz = await crypto.subtle.importKey("raw", Uint8Array.from(surowe, (z) => z.charCodeAt(0)), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
    const bajty = new Uint8Array(await crypto.subtle.sign("HMAC", klucz, new TextEncoder().encode(`${id}.${ts}.${cialo}`)));
    return `v1,${btoa(String.fromCharCode(...bajty))}`;
  }

  it("dobry podpis przechodzi, także jako jeden z kilku w nagłówku", async () => {
    const ts = TERAZ / 1000;
    const cialo = '{"type":"email.delivered"}';
    const dobry = await podpis("msg_1", ts, cialo);
    expect(await czyPodpisResendPoprawny(cialo, { id: "msg_1", timestamp: String(ts), podpis: dobry }, SEKRET, TERAZ)).toBe(true);
    expect(await czyPodpisResendPoprawny(cialo, { id: "msg_1", timestamp: String(ts), podpis: `v1,stary ${dobry}` }, SEKRET, TERAZ)).toBe(true);
  });

  it("zmienione ciało, inny sekret, brak nagłówka albo stary znacznik czasu → odrzucony", async () => {
    const ts = TERAZ / 1000;
    const cialo = '{"type":"email.delivered"}';
    const dobry = await podpis("msg_1", ts, cialo);
    const naglowki = { id: "msg_1", timestamp: String(ts), podpis: dobry };
    expect(await czyPodpisResendPoprawny(`${cialo} `, naglowki, SEKRET, TERAZ)).toBe(false);
    expect(await czyPodpisResendPoprawny(cialo, { ...naglowki, podpis: await podpis("msg_1", ts, cialo, `whsec_${btoa("inny")}`) }, SEKRET, TERAZ)).toBe(false);
    expect(await czyPodpisResendPoprawny(cialo, { ...naglowki, podpis: null }, SEKRET, TERAZ)).toBe(false);
    const stary = ts - TOLERANCJA_PODPISU_S - 1;
    expect(await czyPodpisResendPoprawny(cialo, { id: "msg_1", timestamp: String(stary), podpis: await podpis("msg_1", stary, cialo) }, SEKRET, TERAZ)).toBe(false);
  });
});

describe("mail z biletem", () => {
  const dane = {
    email: "delivered+jan@resend.dev",
    imie: 'Jan "<script>"',
    kod: "ABCD-1234",
    film: "Gabinet doktora Caligari",
    startsAt: "2026-11-08T17:15:00.000Z",
    sala: "Sala 1",
    seatId: "H10",
    kwotaKarta: 2200,
    punktyUzyte: 1000,
    punktyZebrane: 220,
    adresBiletu: "https://kasa.test/bilet/x?seans=s&miejsce=H10",
    reservationId: "x",
  };

  it("podsumowanie: ile kartą, ile punktami i ile punktów zebrał", () => {
    const mail = mailBiletu(dane);
    expect(mail.do).toBe("delivered+jan@resend.dev");
    expect(mail.temat).toContain("ABCD-1234");
    expect(mail.tekst).toContain("Zapłacono kartą: 22 zł");
    expect(mail.tekst).toContain("Zapłacono punktami: 1000 pkt (10 zł)");
    expect(mail.tekst).toContain("Zebrane punkty: +220 pkt");
    expect(mail.tekst).toContain("Rząd H, miejsce 10");
  });

  it("dane z zewnątrz w HTML są uciekane", () => {
    const mail = mailBiletu(dane);
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("Jan &quot;&lt;script&gt;&quot;");
  });

  it("bez punktów: „nie użyto”", () => {
    expect(mailBiletu({ ...dane, punktyUzyte: 0, kwotaKarta: 3200, punktyZebrane: 320 }).tekst).toContain("Zapłacono punktami: nie użyto");
  });
});
