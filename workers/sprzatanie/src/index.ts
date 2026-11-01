// Plik wejściowy Workera sprzątającego: tylko handler Cronów. Każdy nazwany eksport tego pliku runtime
// potraktowałby jak punkt wejścia (a stałej odmówiłby startu), więc logika jest w zadania.ts.

import { CRON_RETENCJI, retencja, sprzataj, sprzatnijHistorie, wyslijOutbox, type SrodowiskoSprzatania } from "./zadania";
import { kontrolaZdrowia } from "./zdrowie";

export default {
  async scheduled(kontroler, env, ctx) {
    if (kontroler.cron === CRON_RETENCJI) {
      ctx.waitUntil(retencja(env));
      ctx.waitUntil(sprzatnijHistorie(env));
      return;
    }
    ctx.waitUntil(sprzataj(env));
    ctx.waitUntil(wyslijOutbox(env));
    ctx.waitUntil(kontrolaZdrowia(env));
  },
} satisfies ExportedHandler<SrodowiskoSprzatania>;
