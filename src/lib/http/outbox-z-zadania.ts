// Joby outboxu uruchamiane przez żądania: od razu po zdarzeniu (np. płatności) i „leniwie” przy odczycie,
// tak jak wygasanie rezerwacji z etapu I. Cron co minutę zostaje siatką bezpieczeństwa, a claim w outboksie
// gwarantuje, że każdy job wykona się raz, kto by go nie wziął (żądanie, budzik czy Cron).

import { przetworzOutbox, type UslugiOutboxu } from "../domain/outbox";
import { zTimeoutem } from "../resilience/timeout";
import type { Zaleznosci } from "../zaleznosci";

export function uslugiOutboxu(z: Zaleznosci): UslugiOutboxu {
  return { platnosci: z.platnosci, punkty: z.punkty, maile: z.maile };
}

/**
 * W outboksie są joby na teraz (albo zmienił się termin). Na Cloudflare budzi budzik outboxu, który wykona je
 * w terminie; bez niego (`next dev`, e2e) robi to w tle samo żądanie, zaczynając od `najpierw`.
 */
export function ruszOutbox(z: Zaleznosci, najpierw: readonly string[] = []): void {
  if (z.budzik) {
    z.budzik();
    return;
  }
  if (!z.db || !z.wTle) return;
  const praca = przetworzOutbox(z.db, uslugiOutboxu(z), { zegar: z.zegar, limit: najpierw.length + 3, najpierw });
  z.wTle(praca.catch((blad: unknown) => console.warn("Outbox w tle żądania:", blad instanceof Error ? blad.message : blad)));
}

/** Ile najdłużej żądanie czeka na dokończenie jobów klienta. Potem odpowiada, a joby kończą się w tle. */
const CZAS_NA_DOKONCZENIE_MS = 6000;

/**
 * Dokańcza wskazane joby przed odpowiedzią. Np. GET /api/loyalty zaraz po końcu porzuconej płatności: strażnik
 * wygasza sesję i oddaje punkty, zanim podamy saldo (kryterium: saldo wraca najpóźniej 15 s po `expiresAt`).
 * Tylko te joby: żądanie klienta nie robi cudzej pracy.
 */
export async function dokonczTeraz(z: Zaleznosci, ids: readonly string[]): Promise<void> {
  if (ids.length === 0 || !z.db) return;
  const praca = przetworzOutbox(z.db, uslugiOutboxu(z), {
    zegar: z.zegar,
    limit: ids.length,
    najpierw: ids,
    tylkoTe: true,
  });
  z.wTle?.(praca.catch(() => undefined));
  try {
    await zTimeoutem(praca, CZAS_NA_DOKONCZENIE_MS);
  } catch (blad) {
    console.warn("Dokończenie jobów klienta w żądaniu:", blad instanceof Error ? blad.message : blad);
  }
  // Job mógł się odłożyć (np. konto zajęte): budzik ustawi się na nowy termin.
  z.budzik?.();
}
