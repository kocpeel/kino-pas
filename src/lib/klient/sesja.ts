// sessionStorage z try/catch (bywa niedostępny: tryb prywatny, zablokowane dane witryny).
// To tylko pamięć do wyświetlania. Prawdą jest zawsze odpowiedź serwera.

const PREFIKS = "kasa-kino:";

function magazyn(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function zapisz(klucz: string, wartosc: unknown): void {
  try {
    magazyn()?.setItem(PREFIKS + klucz, JSON.stringify(wartosc));
  } catch {
    // Brak miejsca albo zablokowany magazyn: aplikacja działa dalej bez tej pamięci.
  }
}

function odczytaj(klucz: string): unknown {
  try {
    const surowe = magazyn()?.getItem(PREFIKS + klucz);
    return surowe ? (JSON.parse(surowe) as unknown) : null;
  } catch {
    return null;
  }
}

function usun(klucz: string): void {
  try {
    magazyn()?.removeItem(PREFIKS + klucz);
  } catch {
    // jw.
  }
}

export interface ZapisRezerwacji {
  reservationId: string;
  eventId: string;
  seatId: string;
  expiresAt: number;
  /** Czas utworzenia według zegara serwera, do paska postępu. */
  utworzono: number;
  przesuniecieZegara: number;
  name: string;
  email: string;
}

function czyZapisRezerwacji(x: unknown): x is ZapisRezerwacji {
  if (typeof x !== "object" || x === null) return false;
  const z = x as Record<string, unknown>;
  return (
    typeof z.reservationId === "string" &&
    typeof z.eventId === "string" &&
    typeof z.seatId === "string" &&
    typeof z.expiresAt === "number" &&
    typeof z.utworzono === "number" &&
    typeof z.przesuniecieZegara === "number" &&
    typeof z.name === "string" &&
    typeof z.email === "string"
  );
}

export function zapiszRezerwacje(rezerwacja: ZapisRezerwacji): void {
  zapisz(`rezerwacja:${rezerwacja.reservationId}`, rezerwacja);
}

export function odczytajRezerwacje(reservationId: string): ZapisRezerwacji | null {
  const zapis = odczytaj(`rezerwacja:${reservationId}`);
  return czyZapisRezerwacji(zapis) && zapis.reservationId === reservationId ? zapis : null;
}

export function zapiszKodBiletu(reservationId: string, code: string): void {
  zapisz(`bilet:${reservationId}`, { code });
}

export function odczytajKodBiletu(reservationId: string): string | null {
  const zapis = odczytaj(`bilet:${reservationId}`) as { code?: unknown } | null;
  return typeof zapis?.code === "string" ? zapis.code : null;
}

/**
 * Klucz idempotencji formularza dla danego fotela. Przeżywa odświeżenie strony,
 * więc ponowienie po timeoucie nie utworzy drugiej rezerwacji.
 */
export function kluczFormularza(eventId: string, seatId: string, nowy: () => string): string {
  const nazwa = `klucz:${eventId}:${seatId}`;
  const zapisany = odczytaj(nazwa);
  if (typeof zapisany === "string" && zapisany.length >= 8) return zapisany;
  const klucz = nowy();
  zapisz(nazwa, klucz);
  return klucz;
}

export function usunKluczFormularza(eventId: string, seatId: string): void {
  usun(`klucz:${eventId}:${seatId}`);
}
