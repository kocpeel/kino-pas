"use client";

// Jeden fotel. Zapamiętany (memo): dostaje tylko proste propsy i stabilne callbacki,
// więc odświeżenie mapy przerysowuje wyłącznie fotele, których stan się zmienił.

import { memo, useCallback } from "react";

export interface PropsFotela {
  seatId: string;
  rzad: string;
  numer: number;
  zajety: boolean;
  wybrany: boolean;
  swiezoZajety: boolean;
  /** Roving tabindex: tylko jeden fotel w kolejności Tab. */
  wKolejnosciTab: boolean;
  onWybierz: (seatId: string) => void;
  onFokus: (seatId: string) => void;
  zarejestruj: (seatId: string, element: HTMLButtonElement | null) => void;
}

function FotelBazowy({
  seatId,
  rzad,
  numer,
  zajety,
  wybrany,
  swiezoZajety,
  wKolejnosciTab,
  onWybierz,
  onFokus,
  zarejestruj,
}: PropsFotela) {
  const stan = zajety ? "zajęte" : wybrany ? "wybrane" : "wolne";
  const klasy = [
    "fotel",
    zajety ? "fotel--zajety" : "",
    wybrany && !zajety ? "fotel--wybrany" : "",
    swiezoZajety ? "fotel--swiezo-zajety" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const ref = useCallback((el: HTMLButtonElement | null) => zarejestruj(seatId, el), [seatId, zarejestruj]);

  return (
    <button
      ref={ref}
      type="button"
      className={klasy}
      // aria-disabled zamiast disabled: zajęty fotel zostaje osiągalny strzałkami i ogłaszany jako zajęty.
      aria-disabled={zajety || undefined}
      aria-pressed={wybrany && !zajety ? true : undefined}
      aria-label={`Rząd ${rzad}, miejsce ${numer}, ${stan}`}
      tabIndex={wKolejnosciTab ? 0 : -1}
      data-seat={seatId}
      onClick={() => {
        if (!zajety) onWybierz(seatId);
      }}
      onFocus={() => onFokus(seatId)}
    >
      <span className="fotel__numer" aria-hidden="true">
        {numer}
      </span>
    </button>
  );
}

export const Fotel = memo(FotelBazowy);
