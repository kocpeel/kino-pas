// Cron Triggery Workera sprzątającego. SQL jest w aplikacji (src/lib/db), tu tylko wywołania.
// - co minutę: wygasłe rezerwacje wracają do puli, a imię, e-mail i klucz idempotencji są czyszczone.
//   Spóźniony albo pominięty przebieg niczego nie psuje: aplikacja sama traktuje rezerwacje
//   po `expiresAt` jako wygasłe. Do tego kontrola zdrowia aplikacji i alerty (zdrowie.ts);
// - raz na dobę: retencja danych osobowych. Kupione bilety tracą imię i e-mail DATA_RETENTION_DAYS dni
//   po seansie (domyślnie 30: zapas na reklamacje i zwroty).

import { zegarSystemowy } from "../../../src/lib/czas";
import { anonimizujPoSeansach, zwolnijWygasleRezerwacje } from "../../../src/lib/db/zapytania-miejsca";
import { kontrolaZdrowia, type SrodowiskoZdrowia } from "./zdrowie";

export const CRON_RETENCJI = "17 3 * * *";
const DOMYSLNA_RETENCJA_DNI = 30;
const DOBA_MS = 24 * 60 * 60 * 1000;

export interface SrodowiskoSprzatania extends SrodowiskoZdrowia {
  DB: D1Database;
  DATA_RETENTION_DAYS?: string;
}

export async function sprzataj(env: SrodowiskoSprzatania, teraz = zegarSystemowy.teraz()): Promise<number> {
  const zwolnione = await zwolnijWygasleRezerwacje(env.DB, teraz);
  if (zwolnione > 0) console.log(`Sprzątanie: zwolniono ${zwolnione} wygasłych rezerwacji.`);
  return zwolnione;
}

function dniRetencji(env: SrodowiskoSprzatania): number {
  const dni = Number(env.DATA_RETENTION_DAYS ?? DOMYSLNA_RETENCJA_DNI);
  // Zła wartość nie może wyłączyć retencji ani skasować danych za wcześnie: wracamy do domyślnej.
  if (!Number.isInteger(dni) || dni < 1 || dni > 3650) {
    console.error(`DATA_RETENTION_DAYS="${env.DATA_RETENTION_DAYS}" poza zakresem 1–3650, używam ${DOMYSLNA_RETENCJA_DNI}.`);
    return DOMYSLNA_RETENCJA_DNI;
  }
  return dni;
}

export async function retencja(env: SrodowiskoSprzatania, teraz = zegarSystemowy.teraz()): Promise<number> {
  const dni = dniRetencji(env);
  const zanonimizowane = await anonimizujPoSeansach(env.DB, teraz - dni * DOBA_MS);
  console.log(`Retencja: zanonimizowano ${zanonimizowane} biletów z seansów sprzed ponad ${dni} dni.`);
  return zanonimizowane;
}

export default {
  async scheduled(kontroler, env, ctx) {
    if (kontroler.cron === CRON_RETENCJI) {
      ctx.waitUntil(retencja(env));
      return;
    }
    ctx.waitUntil(sprzataj(env));
    ctx.waitUntil(kontrolaZdrowia(env));
  },
} satisfies ExportedHandler<SrodowiskoSprzatania>;
