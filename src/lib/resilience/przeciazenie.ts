// Load shedding z priorytetami i grodziami (bulkhead).
//
// Dwie osobne pule żądań w toku: odczyty (lista, mapa) i zapisy (rezerwacja, zakup),
// więc tłum oglądający mapę nie zajmie miejsca zakupom. W puli zapisów 25% pojemności
// jest zarezerwowane dla zakupów. Lista jest odrzucana pierwsza: także wtedy, gdy zapisy
// są mocno obciążone (wspólna baza). Priorytet: zakup > rezerwacja > szczegóły > lista > kanał.
// Nowe połączenia kanału na żywo odpadają najwcześniej (od połowy puli odczytów), bo mapa
// ma zapasowe odpytywanie, a każde połączenie to odczyt bazy w Durable Objekcie sali.
//
// Liczniki są per izolat Workera (przybliżenie obciążenia, nie globalny licznik),
// to tylko dwie liczby, więc stan nie rośnie. Przeciążenie samej bazy D1 rozpoznaje
// osobno obsługa błędów (503 + Retry-After).

import { BladDomenowy } from "../domain/bledy";

export type Priorytet = "kanal" | "lista" | "szczegoly" | "rezerwacja" | "zakup";

export interface LimityPrzeciazenia {
  maxOdczytow: number;
  maxZapisow: number;
}

const UDZIAL_DLA_NIZSZYCH = 0.75;
const UDZIAL_DLA_KANALU = 0.5;

export class StraznikPrzeciazenia {
  private odczytyWToku = 0;
  private zapisyWToku = 0;

  constructor(private limity: LimityPrzeciazenia) {}

  ustawLimity(limity: LimityPrzeciazenia): void {
    this.limity = limity;
  }

  stan(): { odczytyWToku: number; zapisyWToku: number } {
    return { odczytyWToku: this.odczytyWToku, zapisyWToku: this.zapisyWToku };
  }

  czyPrzyjac(priorytet: Priorytet): boolean {
    const { maxOdczytow, maxZapisow } = this.limity;
    switch (priorytet) {
      case "zakup":
        return this.zapisyWToku < maxZapisow;
      case "rezerwacja":
        return this.zapisyWToku < Math.max(1, Math.floor(maxZapisow * UDZIAL_DLA_NIZSZYCH));
      case "szczegoly":
        return this.odczytyWToku < maxOdczytow;
      case "lista":
        return (
          this.odczytyWToku < Math.max(1, Math.floor(maxOdczytow * UDZIAL_DLA_NIZSZYCH)) &&
          this.zapisyWToku < Math.max(1, Math.floor(maxZapisow * UDZIAL_DLA_NIZSZYCH))
        );
      case "kanal":
        return (
          this.odczytyWToku < Math.max(1, Math.floor(maxOdczytow * UDZIAL_DLA_KANALU)) &&
          this.zapisyWToku < Math.max(1, Math.floor(maxZapisow * UDZIAL_DLA_NIZSZYCH))
        );
    }
  }

  /** Zajmuje miejsce w puli albo rzuca 503. Zwraca funkcję zwalniającą (wywołaj w `finally`). */
  wejdz(priorytet: Priorytet): () => void {
    if (!this.czyPrzyjac(priorytet)) {
      throw new BladDomenowy("PRZECIAZENIE", { ponowZaS: 2 });
    }
    const zapis = priorytet === "rezerwacja" || priorytet === "zakup";
    if (zapis) this.zapisyWToku++;
    else this.odczytyWToku++;
    let zwolniono = false;
    return () => {
      if (zwolniono) return;
      zwolniono = true;
      if (zapis) this.zapisyWToku--;
      else this.odczytyWToku--;
    };
  }
}

// Jeden strażnik na izolat, wspólny dla wszystkich stron i route handlerów. Next.js pakuje je osobno
// (osobne kopie modułów), więc trzymamy go na globalThis, a nie w zmiennej modułu.
// To tylko dwie liczby całkowite ograniczone limitami (nie rosną).
const KLUCZ_STRAZNIKA = Symbol.for("kasa-kino.straznik-przeciazenia");

export function straznikDlaIzolatu(limity: LimityPrzeciazenia): StraznikPrzeciazenia {
  const globalny = globalThis as { [KLUCZ_STRAZNIKA]?: StraznikPrzeciazenia };
  const straznik = (globalny[KLUCZ_STRAZNIKA] ??= new StraznikPrzeciazenia(limity));
  straznik.ustawLimity(limity);
  return straznik;
}
