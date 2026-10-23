import { afterEach, describe, expect, it, vi } from "vitest";
import { generujKodBiletu } from "../../src/lib/domain/rezerwacja";
import { BladDomenowy } from "../../src/lib/domain/bledy";
import { opoznienieBackoff } from "../../src/lib/klient/api";
import { CacheZLimitem } from "../../src/lib/resilience/cache";
import { sprawdzLimityRezerwacji, type Limiter } from "../../src/lib/resilience/limit-zapytan";
import { StraznikPrzeciazenia } from "../../src/lib/resilience/przeciazenie";
import { zTimeoutem } from "../../src/lib/resilience/timeout";

describe("kod biletu", () => {
  it("ma format XXXX-XXXX z alfabetu bez I, L, O, U", () => {
    for (let i = 0; i < 200; i++) {
      expect(generujKodBiletu()).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    }
  });

  it("jest losowy", () => {
    const kody = new Set(Array.from({ length: 500 }, () => generujKodBiletu()));
    expect(kody.size).toBe(500);
  });
});

describe("backoff z pełnym jitterem", () => {
  it("mieści się w [0, min(max, baza·2^n)]", () => {
    expect(opoznienieBackoff(0, () => 1)).toBe(300);
    expect(opoznienieBackoff(2, () => 1)).toBe(1200);
    expect(opoznienieBackoff(10, () => 1)).toBe(4000);
    expect(opoznienieBackoff(3, () => 0)).toBe(0);
  });
});

describe("ograniczony cache", () => {
  it("usuwa najstarsze wpisy ponad limit (LRU)", () => {
    const cache = new CacheZLimitem<number>(2, 10_000);
    cache.zapisz("a", 1, 0);
    cache.zapisz("b", 2, 0);
    cache.pobierz("a", 1); // „a" świeżo użyte
    cache.zapisz("c", 3, 2);
    expect(cache.rozmiar).toBe(2);
    expect(cache.pobierz("b", 3)).toBeUndefined();
    expect(cache.pobierz("a", 3)?.wartosc).toBe(1);
  });

  it("zapomina wpisy starsze niż maksymalny wiek", () => {
    const cache = new CacheZLimitem<number>(5, 1000);
    cache.zapisz("a", 1, 0);
    expect(cache.pobierz("a", 999)?.wiekMs).toBe(999);
    expect(cache.pobierz("a", 1001)).toBeUndefined();
    expect(cache.rozmiar).toBe(0);
  });
});

describe("load shedding z priorytetami", () => {
  it("przy zapełnionej puli zapisów odrzuca rezerwacje, a zakup jeszcze przechodzi", () => {
    const straznik = new StraznikPrzeciazenia({ maxOdczytow: 4, maxZapisow: 4 });
    const zwolnij = [straznik.wejdz("rezerwacja"), straznik.wejdz("rezerwacja"), straznik.wejdz("rezerwacja")];
    expect(straznik.czyPrzyjac("rezerwacja")).toBe(false); // 3 ≥ 75% z 4
    expect(straznik.czyPrzyjac("zakup")).toBe(true);
    expect(() => straznik.wejdz("rezerwacja")).toThrow(BladDomenowy);
    const zakup = straznik.wejdz("zakup");
    expect(straznik.czyPrzyjac("zakup")).toBe(false);
    zakup();
    zwolnij.forEach((z) => z());
    expect(straznik.stan()).toEqual({ odczytyWToku: 0, zapisyWToku: 0 });
  });

  it("lista odpada pierwsza: także wtedy, gdy obciążone są zapisy", () => {
    const straznik = new StraznikPrzeciazenia({ maxOdczytow: 100, maxZapisow: 4 });
    const zwolnij = [straznik.wejdz("zakup"), straznik.wejdz("zakup"), straznik.wejdz("zakup")];
    expect(straznik.czyPrzyjac("lista")).toBe(false);
    expect(straznik.czyPrzyjac("szczegoly")).toBe(true);
    zwolnij.forEach((z) => z());
    expect(straznik.czyPrzyjac("lista")).toBe(true);
  });

  it("grodzie: tłum odczytów nie blokuje zakupów", () => {
    const straznik = new StraznikPrzeciazenia({ maxOdczytow: 2, maxZapisow: 2 });
    straznik.wejdz("szczegoly");
    straznik.wejdz("szczegoly");
    expect(straznik.czyPrzyjac("szczegoly")).toBe(false);
    expect(straznik.czyPrzyjac("zakup")).toBe(true);
  });

  it("podwójne zwolnienie nie psuje licznika", () => {
    const straznik = new StraznikPrzeciazenia({ maxOdczytow: 2, maxZapisow: 2 });
    const zwolnij = straznik.wejdz("zakup");
    zwolnij();
    zwolnij();
    expect(straznik.stan().zapisyWToku).toBe(0);
  });
});

describe("timeout", () => {
  afterEach(() => vi.useRealTimers());

  it("przerywa wolną operację błędem 503 i sprząta timer", async () => {
    vi.useFakeTimers();
    const wynik = zTimeoutem(new Promise(() => {}), 100);
    vi.advanceTimersByTime(100);
    await expect(wynik).rejects.toMatchObject({ rodzaj: "NIEDOSTEPNE", status: 503 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("szybka operacja zwraca wynik i nie zostawia timera", async () => {
    vi.useFakeTimers();
    await expect(zTimeoutem(Promise.resolve(7), 100)).resolves.toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("rate limiting", () => {
  const limiter = (wolno: boolean): Limiter => ({ limit: async () => ({ success: wolno }) });

  it("przekroczenie → 429 z Retry-After równym oknu", async () => {
    await expect(
      sprawdzLimityRezerwacji({ ip: limiter(false) }, { ip: "1.1.1.1", email: "a@b.pl" }, 60),
    ).rejects.toMatchObject({ status: 429, ponowZaS: 60 });
  });

  it("limit e-maila działa niezależnie od IP", async () => {
    await expect(
      sprawdzLimityRezerwacji({ ip: limiter(true), email: limiter(false) }, { ip: "1.1.1.1", email: "a@b.pl" }, 60),
    ).rejects.toMatchObject({ status: 429 });
  });

  it("e-mail trafia do limitera jako skrót, nie jawnie", async () => {
    const klucze: string[] = [];
    const zapisujacy: Limiter = { limit: async ({ key }) => (klucze.push(key), { success: true }) };
    await sprawdzLimityRezerwacji({ email: zapisujacy }, { ip: "1.1.1.1", email: "jan@example.com" }, 60);
    expect(klucze[0]).toMatch(/^email:[0-9a-f]{32}$/);
    expect(klucze[0]).not.toContain("jan");
  });

  it("awaria limitera nie blokuje sprzedaży", async () => {
    const zepsuty: Limiter = { limit: async () => Promise.reject(new Error("down")) };
    const ostrzezenie = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      sprawdzLimityRezerwacji({ ip: zepsuty }, { ip: "1.1.1.1", email: "a@b.pl" }, 60),
    ).resolves.toBeUndefined();
    ostrzezenie.mockRestore();
  });
});
