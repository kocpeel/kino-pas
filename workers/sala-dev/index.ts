// Worker sali TYLKO dla `npm run dev` (nigdy nie wdrażany). `next dev` nie uruchamia worker.ts,
// więc Durable Object sali i kanał WebSocket działają w dev w tym osobnym procesie workerd,
// na tej samej lokalnej bazie D1 (.wrangler/state) co Next.js:
// - GET  /api/events/:id/live   WebSocket z przeglądarki (strona na innym porcie: DOZWOLONE_ZRODLA),
// - POST /__dev/zmiana/:id       powiadomienie z API Next.js po rezerwacji (w produkcji robi to RPC).
// Kod sali (src/lib/push) jest ten sam co w produkcji.

import { czyPoprawneIdSeansu } from "../../src/lib/domain/dane-klienta";
import { polaczZSala } from "../../src/lib/push/polaczenie-na-zywo";
import { WZOR_SCIEZKI_NA_ZYWO } from "../../src/lib/push/protokol";
import type { SalaSeansu } from "../../src/lib/push/sala-seansu";
import type { Limiter } from "../../src/lib/resilience/limit-zapytan";

export { SalaSeansu } from "../../src/lib/push/sala-seansu";

interface SrodowiskoSaliDev {
  DB: D1Database;
  SALE: DurableObjectNamespace<SalaSeansu>;
  RL_KANAL_IP?: Limiter;
  DOZWOLONE_ZRODLA?: string;
}

const WZOR_ZMIANY = /^\/__dev\/zmiana\/([^/]+)$/;

export default {
  async fetch(zadanie, env) {
    const { pathname } = new URL(zadanie.url);

    const naZywo = WZOR_SCIEZKI_NA_ZYWO.exec(pathname);
    if (naZywo) {
      const dozwoloneZrodla = (env.DOZWOLONE_ZRODLA ?? "").split(",").map((z) => z.trim()).filter(Boolean);
      return polaczZSala(zadanie, env.SALE, decodeURIComponent(naZywo[1] as string), {
        dozwoloneZrodla,
        limiter: env.RL_KANAL_IP,
        okresLimituS: 60,
      });
    }

    const zmiana = WZOR_ZMIANY.exec(pathname);
    if (zmiana && zadanie.method === "POST") {
      const eventId = decodeURIComponent(zmiana[1] as string);
      if (!czyPoprawneIdSeansu(eventId)) return new Response("Nie ma takiego seansu.", { status: 404 });
      await env.SALE.get(env.SALE.idFromName(eventId)).zmiana(eventId);
      return new Response(null, { status: 204 });
    }

    return new Response("Nie znaleziono.", { status: 404 });
  },
} satisfies ExportedHandler<SrodowiskoSaliDev>;
