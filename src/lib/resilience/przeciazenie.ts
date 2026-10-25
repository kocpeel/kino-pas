// Load shedding z priorytetami i grodziami (bulkhead).
//
// Dwie osobne pule żądań w toku: odczyty (lista, mapa) i zapisy (rezerwacja, zakup),
// więc tłum oglądający mapę nie zajmie miejsca zakupom. W puli zapisów 25% pojemności
// jest zarezerwowane dla zakupów. Lista jest odrzucana pierwsza: także wtedy, gdy zapisy
// są mocno obciążone (wspólna baza). Priorytet: zakup > rezerwacja > szczegóły > lista > kanał.
// Nowe połączenia kanału na żywo odpadają najwcześniej (od połowy puli odczytów), bo mapa
// ma zapasowe odpytywanie, a każde połączenie to odczyt bazy w Durable Objekcie sali.
//
// Liczniki są per izolat Workera (przybliżenie obciążenia, nie globalny licznik). Dlatego strażnik
// patrzy też na sygnał wspólny dla wszystkich izolatów: opóźnienie bazy D1 (średnia wykładnicza z ostatnich
// zapytań). Gdy baza zwalnia, każdy izolat sam zmniejsza swoje pule proporcjonalnie (cel / opóźnienie,
// najmniej do 25%), więc zalew z wielu izolatów i tak hamuje. Zakupy zawsze mają pełną pulę.
// Stan to kilka liczb, nie rośnie.

import { BladDomenowy } from "../domain/bledy";

export type Priorytet = "kanal" | "lista" | "szczegoly" | "rezerwacja" | "zakup";

export interface LimityPrzeciazenia {
  maxOdczytow: number;
  maxZapisow: number;
  /** Docelowe opóźnienie bazy; powyżej niego pule maleją. Brak albo 0 = bez reakcji na opóźnienie. */
  celOpoznieniaMs?: number;
}

const UDZIAL_DLA_NIZSZYCH = 0.75;
const UDZIAL_DLA_KANALU = 0.5;
const MIN_WSPOLCZYNNIK = 0.25;
/** Waga nowego pomiaru w średniej wykładniczej. */
const WAGA_POMIARU = 0.2;
/** Po takiej przerwie bez pomiarów stara średnia nic nie mówi o bazie. */
const WAZNOSC_POMIARU_MS = 10_000;

export class StraznikPrzeciazenia {
  private odczytyWToku = 0;
  private zapisyWToku = 0;
  private opoznienieMs: number | null = null;
  private ostatniPomiar = 0;

  constructor(
    private limity: LimityPrzeciazenia,
    private readonly teraz: () => number = Date.now,
  ) {}

  ustawLimity(limity: LimityPrzeciazenia): void {
    this.limity = limity;
  }

  stan(): { odczytyWToku: number; zapisyWToku: number } {
    return { odczytyWToku: this.odczytyWToku, zapisyWToku: this.zapisyWToku };
  }

  /** Czas odpowiedzi bazy (awarię albo timeout zgłaszaj jako pełny timeout). */
  zanotujOpoznienie(ms: number): void {
    const t = this.teraz();
    const poprzednie = this.opoznienieMs;
    const swieze = poprzednie !== null && t - this.ostatniPomiar <= WAZNOSC_POMIARU_MS;
    this.opoznienieMs = swieze ? poprzednie + WAGA_POMIARU * (ms - poprzednie) : ms;
    this.ostatniPomiar = t;
  }

  /** Ułamek pojemności pul (1 = pełna) wynikający z opóźnienia bazy. */
  wspolczynnik(): number {
    const cel = this.limity.celOpoznieniaMs;
    if (!cel || this.opoznienieMs === null || this.teraz() - this.ostatniPomiar > WAZNOSC_POMIARU_MS) return 1;
    return Math.min(1, Math.max(MIN_WSPOLCZYNNIK, cel / this.opoznienieMs));
  }

  zdrowieBazy(): { opoznienieMs: number | null; wspolczynnik: number } {
    const ms = this.opoznienieMs === null ? null : Math.round(this.opoznienieMs);
    return { opoznienieMs: ms, wspolczynnik: this.wspolczynnik() };
  }

  czyPrzyjac(priorytet: Priorytet): boolean {
    const k = this.wspolczynnik();
    const maxZapisow = this.limity.maxZapisow;
    const maxOdczytow = Math.max(1, Math.floor(this.limity.maxOdczytow * k));
    const maxZapisowNizszych = Math.max(1, Math.floor(maxZapisow * k));
    switch (priorytet) {
      case "zakup":
        return this.zapisyWToku < maxZapisow;
      case "rezerwacja":
        return this.zapisyWToku < Math.max(1, Math.floor(maxZapisowNizszych * UDZIAL_DLA_NIZSZYCH));
      case "szczegoly":
        return this.odczytyWToku < maxOdczytow;
      case "lista":
        return (
          this.odczytyWToku < Math.max(1, Math.floor(maxOdczytow * UDZIAL_DLA_NIZSZYCH)) &&
          this.zapisyWToku < Math.max(1, Math.floor(maxZapisowNizszych * UDZIAL_DLA_NIZSZYCH))
        );
      case "kanal":
        return (
          this.odczytyWToku < Math.max(1, Math.floor(maxOdczytow * UDZIAL_DLA_KANALU)) &&
          this.zapisyWToku < Math.max(1, Math.floor(maxZapisowNizszych * UDZIAL_DLA_NIZSZYCH))
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
// To tylko kilka liczb (nie rosną).
const KLUCZ_STRAZNIKA = Symbol.for("kasa-kino.straznik-przeciazenia");

export function straznikDlaIzolatu(limity: LimityPrzeciazenia): StraznikPrzeciazenia {
  const globalny = globalThis as { [KLUCZ_STRAZNIKA]?: StraznikPrzeciazenia };
  const straznik = (globalny[KLUCZ_STRAZNIKA] ??= new StraznikPrzeciazenia(limity));
  straznik.ustawLimity(limity);
  return straznik;
}
