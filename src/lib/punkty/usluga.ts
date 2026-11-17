// Program punktowy złożony z bindingów: bramka Voucherify, wspólny budżet wywołań (Durable Object)
// i świeżość salda z konfiguracji. Ten sam kod w Workerze aplikacji i w Workerze z Cronem.

import { wczytajKonfiguracje } from "../config";
import type { UslugaPunktow } from "../domain/konto-punktowe";
import type { LimiterZadan } from "../resilience/limiter-zadan";
import { budzetNaObiekcie } from "./budzet";
import { bramkaVoucherifyZeSrodowiska, type SrodowiskoVoucherify } from "./voucherify";

export interface SrodowiskoPunktow extends SrodowiskoVoucherify {
  LIMITER?: DurableObjectNamespace<LimiterZadan> | undefined;
  [zmienna: string]: unknown;
}

/** undefined = brak kluczy Voucherify: punkty odpowiadają 503, a płatność bez punktów działa dalej. */
export function uslugaPunktowZeSrodowiska(env: SrodowiskoPunktow, opcje: { bezBudzetu?: boolean } = {}): UslugaPunktow | undefined {
  const bramka = bramkaVoucherifyZeSrodowiska(env);
  if (!bramka) return undefined;
  const k = wczytajKonfiguracje(env);
  return {
    bramka,
    budzet: opcje.bezBudzetu
      ? undefined
      : budzetNaObiekcie(env.LIMITER, { naGodzine: k.wywolanVoucherifyNaGodzine, odczytowNaGodzine: k.odczytowVoucherifyNaGodzine }),
    swiezoscSaldaMs: k.swiezoscSaldaMs,
  };
}
