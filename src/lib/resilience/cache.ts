// Mały cache odczytów z limitem wpisów i TTL. Służy dwóm celom:
// 1) świeże dane (wiek < TTL) oszczędzają bazę,
// 2) dane przeterminowane (wiek < maxWiekAwaryjny) są fallbackiem, gdy D1 zawodzi.
// Wpisy starsze niż maxWiekAwaryjny są usuwane, a liczba wpisów jest ograniczona (LRU),
// więc cache nie rośnie w nieskończoność w długo żyjącym izolacie.

export interface WpisCache<T> {
  wartosc: T;
  zapisano: number;
}

export class CacheZLimitem<T> {
  private readonly wpisy = new Map<string, WpisCache<T>>();

  constructor(
    private readonly maxWpisow: number,
    private readonly maxWiekAwaryjnyMs: number,
  ) {}

  pobierz(klucz: string, teraz: number): (WpisCache<T> & { wiekMs: number }) | undefined {
    const wpis = this.wpisy.get(klucz);
    if (!wpis) return undefined;
    const wiekMs = teraz - wpis.zapisano;
    if (wiekMs > this.maxWiekAwaryjnyMs) {
      this.wpisy.delete(klucz);
      return undefined;
    }
    // Odświeżenie pozycji LRU.
    this.wpisy.delete(klucz);
    this.wpisy.set(klucz, wpis);
    return { ...wpis, wiekMs };
  }

  zapisz(klucz: string, wartosc: T, teraz: number): void {
    this.wpisy.delete(klucz);
    this.wpisy.set(klucz, { wartosc, zapisano: teraz });
    while (this.wpisy.size > this.maxWpisow) {
      const najstarszy = this.wpisy.keys().next().value;
      if (najstarszy === undefined) break;
      this.wpisy.delete(najstarszy);
    }
  }

  usun(klucz: string): void {
    this.wpisy.delete(klucz);
  }

  wyczysc(): void {
    this.wpisy.clear();
  }

  get rozmiar(): number {
    return this.wpisy.size;
  }
}
