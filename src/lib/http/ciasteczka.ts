// Ciasteczko z sekretem rezerwacji. HttpOnly (niedostępne dla skryptów), Secure, SameSite=Strict
// i ścieżka ograniczona do jednej rezerwacji, więc przeglądarka wysyła je tylko do
// /api/reservations/<ta-rezerwacja>/… (np. zakup). Ważne 90 dni: po zakupie służy do ponownego
// pokazania kodu biletu w tej przeglądarce.

export const NAZWA_CIASTECZKA_REZERWACJI = "kasa_rez";
const WAZNOSC_S = 90 * 24 * 60 * 60;
const WZOR_SEKRETU = /^[A-Za-z0-9_-]{43}$/;

export function ciasteczkoRezerwacji(reservationId: string, sekret: string): string {
  return [
    `${NAZWA_CIASTECZKA_REZERWACJI}=${sekret}`,
    `Path=/api/reservations/${reservationId}`,
    `Max-Age=${WAZNOSC_S}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
  ].join("; ");
}

/** Sekret rezerwacji z nagłówka Cookie albo null (brak albo zły format). */
export function sekretZCiasteczka(zadanie: Request): string | null {
  const naglowek = zadanie.headers.get("cookie");
  if (!naglowek) return null;
  for (const czesc of naglowek.split(";")) {
    const [nazwa, ...reszta] = czesc.trim().split("=");
    if (nazwa !== NAZWA_CIASTECZKA_REZERWACJI) continue;
    const wartosc = reszta.join("=");
    if (WZOR_SEKRETU.test(wartosc)) return wartosc;
  }
  return null;
}
