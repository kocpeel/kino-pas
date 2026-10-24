import { afterEach, describe, expect, it, vi } from "vitest";
import { adresKanaluNaZywo, adresSaliDev } from "../../src/lib/push/tryb-dev";

afterEach(() => vi.unstubAllEnvs());

describe("adres kanału na żywo zależnie od trybu", () => {
  it("produkcja: ścieżka na tej samej domenie (worker.ts)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SALA_DEV_URL", "http://localhost:8789");
    expect(adresKanaluNaZywo("metropolis-2026-11-06")).toBe("/api/events/metropolis-2026-11-06/live");
  });

  it("npm run dev: adres Workera sali z SALA_DEV_URL", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SALA_DEV_URL", "http://localhost:8789/");
    expect(adresSaliDev()).toBe("http://localhost:8789");
    expect(adresKanaluNaZywo("metropolis-2026-11-06")).toBe("http://localhost:8789/api/events/metropolis-2026-11-06/live");
  });

  it("samo next dev bez Workera sali: brak kanału (mapa odpytuje)", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SALA_DEV_URL", "");
    expect(adresKanaluNaZywo("metropolis-2026-11-06")).toBeNull();
  });

  it("odrzuca adres, który nie jest samym originem http(s)", () => {
    vi.stubEnv("SALA_DEV_URL", "javascript:alert(1)");
    expect(adresSaliDev()).toBeNull();
    vi.stubEnv("SALA_DEV_URL", "http://localhost:8789/inna/sciezka");
    expect(adresSaliDev()).toBeNull();
  });
});
