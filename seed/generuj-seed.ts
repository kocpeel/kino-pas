// Generuje seed: 3 seanse w 2 salach, każdy z kompletem 8 × 10 foteli.
// Użycie: `npm run seed:generuj` (zapisuje seed/seed.sql). Testy integracyjne
// importują `zbudujSeed()` bezpośrednio, więc obie drogi dają te same dane.

import { DOMYSLNY_UKLAD, wszystkieMiejsca } from "../src/lib/domain/uklad-sali.ts";

export interface SeansSeedu {
  id: string;
  movie: string;
  startsAt: string;
  hall: string;
}

export const SEANSE: readonly SeansSeedu[] = [
  { id: "metropolis-2026-11-06", movie: "Metropolis", startsAt: "2026-11-06T18:30:00.000Z", hall: "Sala 1" },
  { id: "nosferatu-2026-11-07", movie: "Nosferatu", startsAt: "2026-11-07T19:00:00.000Z", hall: "Sala 2" },
  {
    id: "caligari-2026-11-08",
    movie: "Gabinet doktora Caligari",
    startsAt: "2026-11-08T17:15:00.000Z",
    hall: "Sala 1",
  },
];

function tekstSql(wartosc: string): string {
  return `'${wartosc.replaceAll("'", "''")}'`;
}

/** Lista instrukcji SQL (bez średników), w kolejności wykonania. */
export function zbudujSeed(): string[] {
  const instrukcje: string[] = [];
  const { rzedy, miejscaWRzedzie } = DOMYSLNY_UKLAD;
  for (const seans of SEANSE) {
    instrukcje.push(
      `INSERT INTO events (id, movie, startsAt, hall, rowsCount, seatsPerRow) VALUES (` +
        `${tekstSql(seans.id)}, ${tekstSql(seans.movie)}, ${tekstSql(seans.startsAt)}, ${tekstSql(seans.hall)}, ` +
        `${rzedy}, ${miejscaWRzedzie})`,
    );
    const wiersze = wszystkieMiejsca(DOMYSLNY_UKLAD).map((seatId) => `(${tekstSql(seans.id)}, ${tekstSql(seatId)})`);
    instrukcje.push(`INSERT INTO seats (eventId, seatId) VALUES ${wiersze.join(", ")}`);
  }
  return instrukcje;
}

export function zbudujSeedSql(): string {
  return ["-- Wygenerowane przez seed/generuj-seed.ts. Nie edytuj ręcznie.", ...zbudujSeed().map((s) => `${s};`)].join(
    "\n",
  );
}

const uruchomionyBezposrednio =
  typeof process !== "undefined" && typeof process.argv?.[1] === "string" && /generuj-seed\.ts$/.test(process.argv[1]);

if (uruchomionyBezposrednio) {
  process.stdout.write(zbudujSeedSql() + "\n");
}
