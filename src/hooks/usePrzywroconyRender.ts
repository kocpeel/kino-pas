"use client";

// Next.js przy „Wstecz" pokazuje stronę z pamięci routera, czyli stary render serwera.
// Strona dostaje od serwera znacznik renderu; jeśli komponent montuje się drugi raz z TYM SAMYM
// znacznikiem, to znaczy, że oglądamy dane z pamięci i trzeba je od razu odświeżyć.
// Porównanie znaczników (zamiast wieku liczonego zegarem przeglądarki) nie zależy od rozjazdu zegarów.

// Jeden znacznik na stronę (klucz), więc rozmiar ogranicza liczba różnych stron w karcie.
const widziane = new Map<string, number>();

/** Wołać w useEffect. Zwraca true, gdy ten render serwera był już wcześniej pokazany. */
export function czyPrzywroconyRender(klucz: string, znacznikRenderu: number): boolean {
  const poprzedni = widziane.get(klucz);
  widziane.set(klucz, znacznikRenderu);
  return poprzedni === znacznikRenderu;
}
