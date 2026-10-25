// Karta seansu (komponent serwerowy, zero JS). Cała karta jest klikalna dzięki linkowi
// rozciągniętemu na kartę, a przycisk to tylko jego wizualna część.

import Link from "next/link";
import type { SeansNaLiscie } from "@/lib/domain/typy";
import { formatujDzien, formatujGodzine } from "@/lib/format";

function odcienZId(id: string): number {
  let h = 0;
  for (const znak of id) h = (h * 31 + znak.charCodeAt(0)) % 360;
  return h;
}

interface Props {
  seans: SeansNaLiscie;
  /** Tryb awaryjny: pokazujemy dane, ale nie prowadzimy do rezerwacji. */
  rezerwacjeWylaczone?: boolean;
}

export function KartaSeansu({ seans, rezerwacjeWylaczone }: Props) {
  const odcien = odcienZId(seans.id);
  const ulamek = seans.totalSeats > 0 ? seans.freeSeats / seans.totalSeats : 0;
  const wypelnienie =
    ulamek === 0 ? "pasek__wypelnienie--blad" : ulamek < 0.2 ? "pasek__wypelnienie--ostrzezenie" : "";
  const wyprzedane = seans.freeSeats === 0;

  return (
    <article className="seans">
      <div
        className="seans__plakat"
        aria-hidden="true"
        style={{
          background: `linear-gradient(135deg, hsl(${odcien} 45% 34%), hsl(${(odcien + 50) % 360} 50% 16%))`,
        }}
      >
        {seans.movie.charAt(0)}
      </div>
      <div className="seans__wnetrze">
        <h2 className="seans__tytul">
          {rezerwacjeWylaczone ? (
            seans.movie
          ) : (
            <Link className="seans__link" href={`/seans/${seans.id}`}>
              {seans.movie}
              <span className="sr-only">: wybierz miejsce</span>
            </Link>
          )}
        </h2>
        <p className="seans__meta">
          <time dateTime={seans.startsAt}>
            {formatujDzien(seans.startsAt)} · {formatujGodzine(seans.startsAt)}
          </time>
          <span>{seans.hall}</span>
        </p>
        <div className="seans__wolne">
          <span className="cyfry">
            {wyprzedane ? "Brak wolnych miejsc" : `wolne ${seans.freeSeats} z ${seans.totalSeats}`}
          </span>
          <div className="pasek" aria-hidden="true">
            <div className={`pasek__wypelnienie ${wypelnienie}`} style={{ width: `${Math.round(ulamek * 100)}%` }} />
          </div>
        </div>
        <span
          className="przycisk przycisk--glowny przycisk--szeroki seans__akcja"
          aria-hidden="true"
          {...(rezerwacjeWylaczone ? { "aria-disabled": "true" } : {})}
        >
          {rezerwacjeWylaczone ? "Rezerwacje wstrzymane" : "Wybierz miejsce"}
        </span>
      </div>
    </article>
  );
}
