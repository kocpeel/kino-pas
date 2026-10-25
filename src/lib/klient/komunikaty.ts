// Jedno miejsce z tłumaczeniem błędów API na komunikaty i akcje w UI.

import { BladApi } from "./api";

export type AkcjaBledu = "mapa" | "ponow" | null;

export interface OpisBleduUi {
  tytul: string;
  tresc: string;
  akcja: AkcjaBledu;
}

function sekundy(s: number | undefined): string {
  if (!s) return "chwilę";
  if (s < 90) return `${s} s`;
  return `ok. ${Math.ceil(s / 60)} min`;
}

export function opiszBlad(blad: unknown): OpisBleduUi {
  if (!(blad instanceof BladApi)) {
    return { tytul: "Coś poszło nie tak", tresc: "Spróbuj ponownie za chwilę.", akcja: "ponow" };
  }
  switch (blad.status) {
    case 0:
      return {
        tytul: blad.kod === "timeout" ? "Serwer nie odpowiedział na czas" : "Brak połączenia z serwerem",
        tresc: "Sprawdź połączenie i spróbuj ponownie. Ponowienie nie utworzy drugiej rezerwacji.",
        akcja: "ponow",
      };
    case 400:
      return { tytul: "Sprawdź dane", tresc: blad.message, akcja: null };
    case 403:
      return { tytul: "Ta rezerwacja należy do innej przeglądarki", tresc: blad.message, akcja: null };
    case 404:
      return { tytul: "Nie znaleziono", tresc: blad.message, akcja: "mapa" };
    case 409:
      return { tytul: "Ten fotel został właśnie zajęty", tresc: "Wróć do mapy i wybierz inne miejsce.", akcja: "mapa" };
    case 410:
      return { tytul: "Rezerwacja wygasła, fotel wrócił do puli", tresc: blad.message, akcja: "mapa" };
    case 422:
      return { tytul: "Nie udało się powtórzyć żądania", tresc: "Spróbuj jeszcze raz.", akcja: "ponow" };
    case 429:
      return blad.kod === "too_many_active_reservations"
        ? {
            tytul: "Osiągnięto limit aktywnych rezerwacji",
            tresc: `${blad.message} Najbliższa rezerwacja wygaśnie za ${sekundy(blad.ponowZaS)}.`,
            akcja: null,
          }
        : {
            tytul: "Za dużo prób w krótkim czasie",
            tresc: `Odczekaj ${sekundy(blad.ponowZaS)} i spróbuj ponownie.`,
            akcja: "ponow",
          };
    case 503:
      return { tytul: "System jest przeciążony, spróbuj za chwilę", tresc: blad.message, akcja: "ponow" };
    default:
      return { tytul: "Coś poszło nie tak", tresc: blad.message, akcja: "ponow" };
  }
}
