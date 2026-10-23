// Ogranicza czas oczekiwania na operację (np. zapytanie D1). Timer jest zawsze sprzątany.
// Uwaga: D1 nie da się anulować, więc zapis może się jeszcze wykonać. Dlatego klient
// ponawia rezerwację z tym samym Idempotency-Key, a zakup jest idempotentny przez stan.

import { BladDomenowy, type RodzajBledu } from "../domain/bledy";

export async function zTimeoutem<T>(
  operacja: Promise<T>,
  ms: number,
  rodzaj: RodzajBledu = "NIEDOSTEPNE",
): Promise<T> {
  let uchwyt: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, odrzuc) => {
    uchwyt = setTimeout(() => {
      odrzuc(new BladDomenowy(rodzaj, { ponowZaS: 2, komunikat: "Serwer nie odpowiedział na czas. Spróbuj ponownie." }));
    }, ms);
  });
  try {
    return await Promise.race([operacja, limit]);
  } finally {
    clearTimeout(uchwyt);
  }
}
