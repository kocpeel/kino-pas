// Cron Trigger (co minutę): wygasłe rezerwacje wracają do puli, a imię, e-mail
// i klucz idempotencji są czyszczone. SQL jest w aplikacji (src/lib/db), tu tylko wywołanie.
// Spóźniony albo pominięty przebieg niczego nie psuje: aplikacja sama traktuje
// rezerwacje po `expiresAt` jako wygasłe.

import { zegarSystemowy } from "../../../src/lib/czas";
import { zwolnijWygasleRezerwacje } from "../../../src/lib/db/zapytania-miejsca";

export interface SrodowiskoSprzatania {
  DB: D1Database;
}

export async function sprzataj(env: SrodowiskoSprzatania, teraz = zegarSystemowy.teraz()): Promise<number> {
  const zwolnione = await zwolnijWygasleRezerwacje(env.DB, teraz);
  if (zwolnione > 0) console.log(`Sprzątanie: zwolniono ${zwolnione} wygasłych rezerwacji.`);
  return zwolnione;
}

export default {
  async scheduled(_kontroler, env, ctx) {
    ctx.waitUntil(sprzataj(env));
  },
} satisfies ExportedHandler<SrodowiskoSprzatania>;
