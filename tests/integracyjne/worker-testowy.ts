// Minimalny Worker dla testów: te same handlery co route handlery Next.js i ta sama trasa
// WebSocket co worker.ts, wywoływane z bindingami z Miniflare (D1, rate limit, Durable Objecty sali i limitera).
// Pozwala testować pełną ścieżkę Request → Response.

import { zaleznosciZBindingow, type Bindingi } from "../../src/lib/db/polaczenie";
import {
  obsluzListeSeansow,
  obsluzRezerwacje,
  obsluzSzczegolySeansu,
  obsluzZakup,
  obsluzZdrowie,
} from "../../src/lib/http/trasy";
import { polaczZSala } from "../../src/lib/push/polaczenie-na-zywo";
import { WZOR_SCIEZKI_NA_ZYWO } from "../../src/lib/push/protokol";

export { SalaSeansu } from "../../src/lib/push/sala-seansu";
export { LimiterZadan } from "../../src/lib/resilience/limiter-zadan";

export default {
  async fetch(zadanie, env, ctx) {
    const dostawca = () => zaleznosciZBindingow(env as unknown as Bindingi, { wTle: (p) => ctx.waitUntil(p) });
    const { pathname } = new URL(zadanie.url);
    const metoda = zadanie.method;
    let m: RegExpMatchArray | null;
    if ((m = WZOR_SCIEZKI_NA_ZYWO.exec(pathname))) {
      return polaczZSala(zadanie, env.SALE, decodeURIComponent(m[1] as string), { limiter: env.RL_KANAL_IP, okresLimituS: 60 });
    }
    if (metoda === "GET" && pathname === "/api/events") return obsluzListeSeansow(zadanie, dostawca);
    if (metoda === "GET" && pathname === "/api/zdrowie") return obsluzZdrowie(dostawca);
    if (metoda === "GET" && (m = pathname.match(/^\/api\/events\/([^/]+)$/))) {
      return obsluzSzczegolySeansu(zadanie, dostawca, decodeURIComponent(m[1] as string));
    }
    if (metoda === "POST" && pathname === "/api/reservations") return obsluzRezerwacje(zadanie, dostawca);
    if (metoda === "POST" && (m = pathname.match(/^\/api\/reservations\/([^/]+)\/purchase$/))) {
      return obsluzZakup(zadanie, dostawca, decodeURIComponent(m[1] as string));
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Cloudflare.Env>;
