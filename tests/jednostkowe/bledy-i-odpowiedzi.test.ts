import { describe, expect, it } from "vitest";
import { BladKonfiguracji } from "../../src/lib/config";
import { BladDomenowy, statusHttp, type RodzajBledu } from "../../src/lib/domain/bledy";
import { odpowiedzBledu } from "../../src/lib/http/odpowiedzi";

describe("mapowanie błędów domenowych na kody HTTP", () => {
  it.each<[RodzajBledu, number]>([
    ["NIEPOPRAWNE_DANE", 400],
    ["ZA_DUZE_ZADANIE", 413],
    ["NIE_ZNALEZIONO", 404],
    ["ZAJETE", 409],
    ["WYGASLA", 410],
    ["KLUCZ_UZYTY", 422],
    ["LIMIT_ZAPYTAN", 429],
    ["LIMIT_REZERWACJI", 429],
    ["PRZECIAZENIE", 503],
    ["NIEDOSTEPNE", 503],
  ])("%s → %i", (rodzaj, status) => {
    expect(statusHttp(rodzaj)).toBe(status);
    expect(new BladDomenowy(rodzaj).status).toBe(status);
  });
});

describe("odpowiedź błędu", () => {
  it("ma stały kształt { error, message } i nie trafia do cache", async () => {
    const odp = odpowiedzBledu(new BladDomenowy("ZAJETE"));
    expect(odp.status).toBe(409);
    expect(odp.headers.get("cache-control")).toBe("no-store");
    expect(await odp.json()).toEqual({ error: "seat_taken", message: "Ten fotel został właśnie zajęty." });
  });

  it("dodaje Retry-After dla 429 i 503", () => {
    expect(odpowiedzBledu(new BladDomenowy("LIMIT_ZAPYTAN", { ponowZaS: 60 })).headers.get("retry-after")).toBe("60");
    expect(odpowiedzBledu(new BladDomenowy("PRZECIAZENIE")).headers.get("retry-after")).toBe("2");
  });

  it("dołącza błędy pól", async () => {
    const odp = odpowiedzBledu(new BladDomenowy("NIEPOPRAWNE_DANE", { szczegoly: { email: "zły" } }));
    expect(((await odp.json()) as { details?: unknown }).details).toEqual({ email: "zły" });
  });

  it("nieznany wyjątek → 500 bez szczegółów wewnętrznych", async () => {
    const odp = odpowiedzBledu(new Error("SELECT * FROM sekrety"));
    expect(odp.status).toBe(500);
    expect(JSON.stringify(await odp.json())).not.toContain("SELECT");
  });

  it("błąd konfiguracji → 500 z czytelnym kodem", async () => {
    const odp = odpowiedzBledu(new BladKonfiguracji("zła wartość"));
    expect(odp.status).toBe(500);
    expect(((await odp.json()) as { error: string }).error).toBe("server_misconfigured");
  });
});
