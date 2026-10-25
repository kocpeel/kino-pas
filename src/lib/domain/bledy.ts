// Błędy domenowe i ich jedyne mapowanie na kody HTTP.

export type RodzajBledu =
  | "NIEPOPRAWNE_DANE"
  | "ZA_DUZE_ZADANIE"
  | "NIE_ZNALEZIONO"
  | "ZAJETE"
  | "WYGASLA"
  | "BRAK_DOSTEPU"
  | "KLUCZ_UZYTY"
  | "LIMIT_ZAPYTAN"
  | "LIMIT_REZERWACJI"
  | "PRZECIAZENIE"
  | "NIEDOSTEPNE";

interface OpisBledu {
  status: number;
  /** Stały, maszynowy kod w odpowiedzi API (`error`). */
  kod: string;
  /** Domyślny komunikat dla człowieka (`message`). */
  komunikat: string;
}

export const OPISY_BLEDOW: Record<RodzajBledu, OpisBledu> = {
  NIEPOPRAWNE_DANE: { status: 400, kod: "invalid_input", komunikat: "Niepoprawne dane żądania." },
  ZA_DUZE_ZADANIE: { status: 413, kod: "payload_too_large", komunikat: "Żądanie jest za duże." },
  NIE_ZNALEZIONO: { status: 404, kod: "not_found", komunikat: "Nie znaleziono." },
  ZAJETE: { status: 409, kod: "seat_taken", komunikat: "Ten fotel został właśnie zajęty." },
  WYGASLA: {
    status: 410,
    kod: "reservation_expired",
    komunikat: "Rezerwacja wygasła, fotel wrócił do puli.",
  },
  BRAK_DOSTEPU: {
    status: 403,
    kod: "reservation_forbidden",
    komunikat: "Tę rezerwację można kupić i obejrzeć tylko w przeglądarce, w której została zrobiona.",
  },
  KLUCZ_UZYTY: {
    status: 422,
    kod: "idempotency_key_reused",
    komunikat: "Ten klucz idempotencji został już użyty z innymi danymi.",
  },
  LIMIT_ZAPYTAN: {
    status: 429,
    kod: "rate_limited",
    komunikat: "Za dużo prób w krótkim czasie. Odczekaj chwilę i spróbuj ponownie.",
  },
  LIMIT_REZERWACJI: {
    status: 429,
    kod: "too_many_active_reservations",
    komunikat: "Masz już maksymalną liczbę aktywnych rezerwacji. Kup bilety albo poczekaj, aż wygasną.",
  },
  PRZECIAZENIE: {
    status: 503,
    kod: "overloaded",
    komunikat: "System jest przeciążony, spróbuj za chwilę.",
  },
  NIEDOSTEPNE: {
    status: 503,
    kod: "unavailable",
    komunikat: "Rezerwacje są chwilowo niedostępne. Spróbuj za chwilę.",
  },
};

export interface OpcjeBledu {
  komunikat?: string;
  /** Sekundy do podania w nagłówku Retry-After. */
  ponowZaS?: number;
  /** Szczegóły dla klienta, np. błędy pól formularza. */
  szczegoly?: Record<string, string>;
  przyczyna?: unknown;
}

export class BladDomenowy extends Error {
  readonly rodzaj: RodzajBledu;
  readonly ponowZaS: number | undefined;
  readonly szczegoly: Record<string, string> | undefined;

  constructor(rodzaj: RodzajBledu, opcje: OpcjeBledu = {}) {
    super(opcje.komunikat ?? OPISY_BLEDOW[rodzaj].komunikat, { cause: opcje.przyczyna });
    this.name = "BladDomenowy";
    this.rodzaj = rodzaj;
    this.ponowZaS = opcje.ponowZaS;
    this.szczegoly = opcje.szczegoly;
  }

  get status(): number {
    return OPISY_BLEDOW[this.rodzaj].status;
  }

  get kod(): string {
    return OPISY_BLEDOW[this.rodzaj].kod;
  }
}

export function czyBladDomenowy(blad: unknown): blad is BladDomenowy {
  return blad instanceof BladDomenowy;
}

export function statusHttp(rodzaj: RodzajBledu): number {
  return OPISY_BLEDOW[rodzaj].status;
}
