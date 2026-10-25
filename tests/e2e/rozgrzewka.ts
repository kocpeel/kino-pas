// `next dev` kompiluje trasy przy pierwszym wejściu. Przy TTL 5 s kompilacja strony licznika
// mogłaby zjeść cały czas rezerwacji, więc przed testami odwiedzamy każdą trasę raz.

const PORT = process.env.E2E_PORT || "3100";
const BAZA = `http://localhost:${PORT}`;
const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";

/** Pierwsza kompilacja trasy w CI trwa kilkanaście sekund; zawieszona trasa ma przerwać przebieg z nazwą adresu. */
const LIMIT_TRASY_MS = 90_000;

async function wejdz(adres: string): Promise<Response> {
  const start = Date.now();
  try {
    const odp = await fetch(`${BAZA}${adres}`, { signal: AbortSignal.timeout(LIMIT_TRASY_MS) });
    await odp.arrayBuffer();
    console.log(`[rozgrzewka] ${odp.status} ${adres} (${Date.now() - start} ms)`);
    return odp;
  } catch (blad) {
    throw new Error(`Rozgrzewka: ${adres} nie odpowiedział w ${LIMIT_TRASY_MS / 1000} s (${String(blad)})`);
  }
}

export default async function rozgrzewka(): Promise<void> {
  const lista = await fetch(`${BAZA}/api/events`, { signal: AbortSignal.timeout(LIMIT_TRASY_MS) });
  const seanse = (await lista.json()) as { id: string }[];
  if (!lista.ok || !Array.isArray(seanse) || seanse.length === 0) {
    throw new Error(`Rozgrzewka: /api/events → ${lista.status} ${JSON.stringify(seanse).slice(0, 200)}`);
  }
  const seans = seanse[0]!.id;
  const adresy = [
    "/",
    `/seans/${seans}`,
    `/seans/${seans}/miejsce/A1`,
    `/rezerwacja/${UUID}?seans=${seans}&miejsce=A1`,
    `/bilet/${UUID}?seans=${seans}&miejsce=A1`,
    `/api/events/${seans}`,
  ];
  for (const adres of adresy) await wejdz(adres);
}
