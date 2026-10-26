// Ścisły rate limiter na Durable Object: jeden obiekt na klucz (skrót IP albo e-maila).
// Binding Workers Rate Limiting liczy w przybliżeniu (osobno w każdej lokalizacji), więc do limitu,
// który ma naprawdę działać, używamy obiektu: żądania do jednego obiektu są obsługiwane po kolei,
// a między odczytem trafień a ich zapisem nie ma `await`, więc sprawdzenie i zapis są atomowe.
//
// Alarm po upływie najdłuższego okna kasuje zapis: obiekty nieaktywnych klientów nie trzymają danych.
// Ten plik importuje "cloudflare:workers", więc trafia tylko do worker.ts (nie do pakietu Next.js).

import { DurableObject } from "cloudflare:workers";
import { zegarSystemowy } from "../czas";
import { ocenProbe, type RegulaLimitu } from "./limit-zapytan";

const KLUCZ_TRAFIEN = "trafienia";
/** Kiedy najnowsze trafienie wypada z najdłuższego okna (wtedy zapis można skasować). */
const KLUCZ_WYGASA = "wygasa";

export class LimiterZadan extends DurableObject {
  // Kopia zapisu w pamięci; najwyżej max(limit) znaczników czasu.
  private trafienia: number[] | null = null;

  async sprobuj(reguly: RegulaLimitu[]): Promise<{ dozwolone: boolean; ponowZaMs: number }> {
    if (reguly.length === 0) return { dozwolone: true, ponowZaMs: 0 };
    // Bramka wejściowa obiektu nie wpuszcza kolejnego żądania w trakcie tego odczytu.
    this.trafienia ??= (await this.ctx.storage.get<number[]>(KLUCZ_TRAFIEN)) ?? [];
    const teraz = zegarSystemowy.teraz();
    const ocena = ocenProbe(this.trafienia, reguly, teraz);
    this.trafienia = ocena.trafienia;
    if (ocena.dozwolone) {
      // Stan w pamięci jest już zaktualizowany, więc czekanie na zapis nie psuje atomowości.
      const wygasa = teraz + Math.max(...reguly.map((r) => r.oknoS * 1000));
      await this.ctx.storage.put({ [KLUCZ_TRAFIEN]: ocena.trafienia, [KLUCZ_WYGASA]: wygasa });
      await this.ctx.storage.setAlarm(wygasa);
    }
    return { dozwolone: ocena.dozwolone, ponowZaMs: ocena.ponowZaMs };
  }

  /**
   * Sprzątanie po ciszy. Kasujemy tylko nasze klucze (nie `deleteAll`, które w alarmie przerwanym
   * nowym `setAlarm` kończyło się błędem wewnętrznym) i tylko wtedy, gdy w międzyczasie nie przyszła
   * nowa próba; inaczej przestawiamy alarm na nowy termin.
   */
  async alarm(): Promise<void> {
    try {
      const wygasa = (await this.ctx.storage.get<number>(KLUCZ_WYGASA)) ?? 0;
      if (zegarSystemowy.teraz() < wygasa) {
        await this.ctx.storage.setAlarm(wygasa);
        return;
      }
      this.trafienia = null;
      await this.ctx.storage.delete([KLUCZ_TRAFIEN, KLUCZ_WYGASA]);
    } catch (blad) {
      // Zapis zostaje, a następna próba i tak ustawi nowy alarm: nic się nie psuje.
      console.warn("Limiter: sprzątanie po alarmie nie powiodło się", blad);
    }
  }
}
