// `next dev` kompiluje trasy przy pierwszym wejściu. Przy TTL 5 s kompilacja strony licznika
// mogłaby zjeść cały czas rezerwacji, więc przed testami odwiedzamy każdą trasę raz.

const PORT = process.env.E2E_PORT || "3100";
const BAZA = `http://localhost:${PORT}`;
const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";

export default async function rozgrzewka(): Promise<void> {
  const seanse = (await (await fetch(`${BAZA}/api/events`)).json()) as { id: string }[];
  const seans = seanse[0]!.id;
  const adresy = [
    "/",
    `/seans/${seans}`,
    `/seans/${seans}/miejsce/A1`,
    `/rezerwacja/${UUID}?seans=${seans}&miejsce=A1`,
    `/bilet/${UUID}?seans=${seans}&miejsce=A1`,
    `/api/events/${seans}`,
  ];
  for (const adres of adresy) await fetch(`${BAZA}${adres}`);
}
