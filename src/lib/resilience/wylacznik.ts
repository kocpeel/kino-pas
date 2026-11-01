// Bezpiecznik (circuit breaker) dla cudzego systemu. Gdy Stripe nie odpowiada, każde kliknięcie „Zapłać”
// czekałoby na kolejny timeout. Po serii awarii odmawiamy od razu, a po przerwie próbujemy znowu:
// udana próba zamyka bezpiecznik, a nieudana otwiera go na kolejną przerwę.
// Stan jest per izolat Workera (dwie liczby), więc to ochrona przybliżona, jak load shedding.

export class WylacznikOtwarty extends Error {
  constructor(readonly ponowZaS: number) {
    super(`Bezpiecznik otwarty, następna próba za ${ponowZaS} s.`);
    this.name = "WylacznikOtwarty";
  }
}

export interface OpcjeWylacznika {
  progPorazek?: number;
  przerwaMs?: number;
  teraz?: () => number;
}

export class Wylacznik {
  private porazki = 0;
  private otwartyDo = 0;
  private readonly progPorazek: number;
  private readonly przerwaMs: number;
  private readonly teraz: () => number;

  constructor({ progPorazek = 5, przerwaMs = 30_000, teraz = Date.now }: OpcjeWylacznika = {}) {
    this.progPorazek = progPorazek;
    this.przerwaMs = przerwaMs;
    this.teraz = teraz;
  }

  /** `czyAwaria` odróżnia awarię systemu od błędu po naszej stronie, np. złych parametrów. */
  async wykonaj<T>(praca: () => Promise<T>, czyAwaria: (blad: unknown) => boolean): Promise<T> {
    const pozostalo = this.otwartyDo - this.teraz();
    if (pozostalo > 0) throw new WylacznikOtwarty(Math.ceil(pozostalo / 1000));
    try {
      const wynik = await praca();
      this.porazki = 0;
      return wynik;
    } catch (blad) {
      if (czyAwaria(blad)) {
        this.porazki++;
        if (this.porazki >= this.progPorazek) this.otwartyDo = this.teraz() + this.przerwaMs;
      }
      throw blad;
    }
  }
}
