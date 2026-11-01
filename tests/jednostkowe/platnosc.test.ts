import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import type { WierszRezerwacji } from "../../src/lib/db/zapytania-platnosci";
import { stanDlaKlienta, statusRezerwacji } from "../../src/lib/domain/platnosc";
import { MAX_PROB, opoznieniePonowienia } from "../../src/lib/domain/outbox";
import { formatujCene, formatujGodzineZSekundami } from "../../src/lib/format";
import { BladApi } from "../../src/lib/klient/api";
import { opiszBlad } from "../../src/lib/klient/komunikaty";
import { bramkaZeSrodowiska, czyKluczTestowy, zweryfikujZdarzenie } from "../../src/lib/platnosci/stripe";
import { Wylacznik, WylacznikOtwarty } from "../../src/lib/resilience/wylacznik";

describe("godzina końca rezerwacji na stronie płatności", () => {
  it("w strefie kina, z sekundami", () => {
    expect(formatujGodzineZSekundami(Date.UTC(2026, 10, 6, 18, 30, 5))).toBe("19:30:05");
  });
});

describe("formatowanie ceny", () => {
  it.each([
    [3200, "32 zł"],
    [8900, "89 zł"],
    [3250, "32,50 zł"],
    [3205, "32,05 zł"],
    [50, "0,50 zł"],
  ])("%i groszy → %s", (grosze, tekst) => {
    expect(formatujCene(grosze)).toBe(tekst);
  });
});

function wiersz(zmiany: Partial<WierszRezerwacji> = {}): WierszRezerwacji {
  return {
    id: "r",
    eventId: "e",
    seatId: "A1",
    amount: 3200,
    expiresAt: 1000,
    stripeSessionId: null,
    stripeSessionUrl: null,
    paymentIntentId: null,
    refundStatus: null,
    seatStatus: "reserved",
    code: null,
    movie: null,
    hall: null,
    startsAt: null,
    ...zmiany,
  };
}

describe("status rezerwacji", () => {
  it("held do expiresAt − 1 ms, potem expired", () => {
    expect(statusRezerwacji(wiersz(), 999)).toBe("held");
    expect(statusRezerwacji(wiersz(), 1000)).toBe("expired");
  });

  it("paid niezależnie od czasu; fotel z innym właścicielem albo wolny to expired", () => {
    expect(statusRezerwacji(wiersz({ seatStatus: "purchased" }), 99_999)).toBe("paid");
    expect(statusRezerwacji(wiersz({ seatStatus: null }), 1)).toBe("expired");
    expect(statusRezerwacji(wiersz({ seatStatus: "free" }), 1)).toBe("expired");
  });

  it("odpowiedź ma kod tylko dla opłaconej i tylko, gdy wolno go pokazać", () => {
    const oplacona = wiersz({ seatStatus: "purchased", code: "ABCD-1234" });
    expect(stanDlaKlienta(oplacona, 1)).toEqual({ status: "paid", amount: 3200, expiresAt: 1000, code: "ABCD-1234" });
    expect(stanDlaKlienta(wiersz({ code: "ABCD-1234" }), 1)).toEqual({ status: "held", amount: 3200, expiresAt: 1000 });
    expect(stanDlaKlienta(wiersz({ refundStatus: "pending" }), 2000)).toEqual({
      status: "expired",
      amount: 3200,
      expiresAt: 1000,
      refund: "pending",
    });
  });
});

describe("outbox: backoff", () => {
  it("podwaja się od minuty do godziny", () => {
    expect([1, 2, 3, 7, 8].map(opoznieniePonowienia)).toEqual([60_000, 120_000, 240_000, 3_600_000, 3_600_000]);
  });

  it("razem z limitem prób wytrzymuje godzinną awarię Stripe'a", () => {
    let razem = 0;
    for (let proba = 1; proba < MAX_PROB; proba++) razem += opoznieniePonowienia(proba);
    expect(razem).toBeGreaterThan(60 * 60_000);
  });
});

describe("bezpiecznik", () => {
  const awaria = () => Promise.reject(new Error("Stripe nie odpowiada"));
  const zawsze = () => true;

  it("po serii awarii odmawia od razu, a po przerwie próbuje znowu", async () => {
    let t = 0;
    const praca = vi.fn(awaria);
    const w = new Wylacznik({ progPorazek: 3, przerwaMs: 30_000, teraz: () => t });
    for (let i = 0; i < 3; i++) await expect(w.wykonaj(praca, zawsze)).rejects.toThrow("Stripe nie odpowiada");

    await expect(w.wykonaj(praca, zawsze)).rejects.toMatchObject({ name: "WylacznikOtwarty", ponowZaS: 30 });
    expect(praca).toHaveBeenCalledTimes(3);

    t = 30_000;
    await expect(w.wykonaj(async () => "ok", zawsze)).resolves.toBe("ok");
    // Po sukcesie liczenie zaczyna się od nowa.
    await expect(w.wykonaj(praca, zawsze)).rejects.toThrow("Stripe nie odpowiada");
    await expect(w.wykonaj(async () => "ok", zawsze)).resolves.toBe("ok");
  });

  it("nieudana próba po przerwie od razu otwiera go znowu", async () => {
    let t = 0;
    const w = new Wylacznik({ progPorazek: 1, przerwaMs: 1000, teraz: () => t });
    await expect(w.wykonaj(awaria, zawsze)).rejects.toThrow("Stripe");
    t = 1000;
    await expect(w.wykonaj(awaria, zawsze)).rejects.toThrow("Stripe");
    await expect(w.wykonaj(awaria, zawsze)).rejects.toBeInstanceOf(WylacznikOtwarty);
  });

  it("błędy po naszej stronie go nie otwierają", async () => {
    const w = new Wylacznik({ progPorazek: 1 });
    await expect(w.wykonaj(awaria, () => false)).rejects.toThrow("Stripe");
    await expect(w.wykonaj(async () => "ok", zawsze)).resolves.toBe("ok");
  });
});

describe("konfiguracja Stripe'a", () => {
  it("działa tylko na kluczach testowych", () => {
    expect(czyKluczTestowy("sk_test_abc")).toBe(true);
    expect(czyKluczTestowy("rk_test_abc")).toBe(true);
    expect(czyKluczTestowy("sk_live_abc")).toBe(false);
    expect(czyKluczTestowy("rk_live_abc")).toBe(false);
  });

  it("brak klucza i klucz produkcyjny wyłączają płatności", () => {
    const blad = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(bramkaZeSrodowiska({})).toBeUndefined();
    expect(bramkaZeSrodowiska({ STRIPE_SECRET_KEY: "sk_live_abc" })).toBeUndefined();
    expect(blad).toHaveBeenCalledOnce();
    expect(String(blad.mock.calls[0]?.[0])).not.toContain("sk_live_abc");
    blad.mockRestore();
    expect(bramkaZeSrodowiska({ STRIPE_SECRET_KEY: "sk_test_abc" })).toBeDefined();
  });
});

describe("podpis webhooka", () => {
  const SEKRET = "whsec_jednostkowy";
  const cialo = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", created: 1, data: { object: {} } });
  const podpisz = (payload: string, secret = SEKRET, timestamp?: number) =>
    Stripe.webhooks.generateTestHeaderStringAsync({
      payload,
      secret,
      ...(timestamp !== undefined ? { timestamp } : {}),
      cryptoProvider: Stripe.createSubtleCryptoProvider(),
    });

  it("poprawny podpis: zdarzenie z surowego ciała", async () => {
    const zdarzenie = await zweryfikujZdarzenie(cialo, await podpisz(cialo), SEKRET);
    expect(zdarzenie.id).toBe("evt_1");
  });

  it.each([
    ["inny sekret", async () => zweryfikujZdarzenie(cialo, await podpisz(cialo, "whsec_inny"), SEKRET)],
    ["zmienione ciało", async () => zweryfikujZdarzenie(`${cialo} `, await podpisz(cialo), SEKRET)],
    ["nagłówek-śmieć", async () => zweryfikujZdarzenie(cialo, "t=1,v1=abc", SEKRET)],
    ["za stary znacznik czasu", async () => zweryfikujZdarzenie(cialo, await podpisz(cialo, SEKRET, Math.floor(Date.now() / 1000) - 3600), SEKRET)],
  ])("%s → błąd invalid_signature (400)", async (_opis, proba) => {
    await expect(proba()).rejects.toMatchObject({ status: 400, kod: "invalid_signature" });
  });
});

describe("komunikaty płatności", () => {
  it("niedostępne płatności: rezerwacja bezpieczna, można ponowić", () => {
    expect(opiszBlad(new BladApi(503, "payments_unavailable", "x"))).toMatchObject({
      tytul: "Płatności są chwilowo niedostępne",
      akcja: "ponow",
    });
  });

  it("już opłacona to nie „fotel zajęty”", () => {
    expect(opiszBlad(new BladApi(409, "reservation_already_paid", "x")).tytul).toBe("Ta rezerwacja jest już opłacona");
    expect(opiszBlad(new BladApi(409, "seat_taken", "x")).tytul).toBe("Ten fotel został właśnie zajęty");
  });
});
