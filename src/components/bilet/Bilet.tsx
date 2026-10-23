// Bilet w kształcie biletu: wcięcia i perforacja zrobione w CSS.

import type { ReactNode } from "react";

export interface DaneBiletu {
  movie: string | null;
  hall: string | null;
  termin: string | null;
  rzad: string | null;
  numer: number | null;
}

export function Bilet({ dane, kod }: { dane: DaneBiletu; kod: ReactNode }) {
  return (
    <article className="bilet" aria-label="Bilet">
      <div className="bilet__gora">
        <div className="bilet__marka">
          <span>Kino Pas</span>
          <span>Bilet wstępu</span>
        </div>
        <h1 className="bilet__film">{dane.movie ?? "Seans"}</h1>
        <dl className="bilet__dane">
          {dane.termin ? (
            <div>
              <dt>Termin</dt>
              <dd>{dane.termin}</dd>
            </div>
          ) : null}
          {dane.hall ? (
            <div>
              <dt>Sala</dt>
              <dd>{dane.hall}</dd>
            </div>
          ) : null}
          {dane.rzad ? (
            <div>
              <dt>Rząd</dt>
              <dd>{dane.rzad}</dd>
            </div>
          ) : null}
          {dane.numer !== null ? (
            <div>
              <dt>Miejsce</dt>
              <dd className="cyfry">{dane.numer}</dd>
            </div>
          ) : null}
        </dl>
      </div>
      <div className="bilet__dol">
        <p className="bilet__etykieta-kodu">Kod biletu</p>
        {kod}
      </div>
    </article>
  );
}
