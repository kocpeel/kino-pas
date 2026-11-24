// Budżet wywołań Voucherify. Sandbox przyjmuje 100 wywołań na godzinę na projekt, a przekroczenie blokuje API.
// Liczymy je sami, wspólnie dla Workera aplikacji i Workera z Cronem (ten sam Durable Object `LimiterZadan`),
// z zapasem. Odczyty salda (GET /api/loyalty) mogą zająć tylko część budżetu, żeby zawsze zostały wywołania
// na wydanie, oddanie i naliczenie punktów (priorytety jak w E05).

import { lancuchLimiterow, limiterNaObiekcie } from "../resilience/limit-zapytan";
import type { LimiterZadan } from "../resilience/limiter-zadan";
import { zTimeoutem } from "../resilience/timeout";

export type RodzajWywolania = "zapis" | "odczyt";

export interface BudzetWywolan {
  /** Zgoda na jedno wywołanie albo czas, po którym zwolni się miejsce. */
  zgoda(rodzaj: RodzajWywolania): Promise<{ ok: true } | { ok: false; ponowZaS: number }>;
}

const GODZINA_S = 3600;
const TIMEOUT_BUDZETU_MS = 1000;

export function budzetNaObiekcie(
  przestrzen: DurableObjectNamespace<LimiterZadan> | undefined,
  limity: { naGodzine: number; odczytowNaGodzine: number },
): BudzetWywolan | undefined {
  const wspolny = limiterNaObiekcie(przestrzen, "voucherify", [{ limit: limity.naGodzine, oknoS: GODZINA_S }]);
  if (!wspolny) return undefined;
  const dlaOdczytu = lancuchLimiterow(
    limiterNaObiekcie(przestrzen, "voucherify-odczyty", [{ limit: limity.odczytowNaGodzine, oknoS: GODZINA_S }]),
    wspolny,
  )!;
  return {
    async zgoda(rodzaj) {
      try {
        const wynik = await zTimeoutem((rodzaj === "odczyt" ? dlaOdczytu : wspolny).limit({ key: "budzet" }), TIMEOUT_BUDZETU_MS);
        return wynik.success ? { ok: true } : { ok: false, ponowZaS: Math.max(1, wynik.ponowZaS ?? 60) };
      } catch (blad) {
        // Jak limitery rezerwacji: awaria licznika nie blokuje sprzedaży, a 429 od Voucherify i tak obsłużymy.
        console.warn("Budżet Voucherify niedostępny, przepuszczam wywołanie", blad);
        return { ok: true };
      }
    },
  };
}
