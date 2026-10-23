// Minimalny Worker dla testów: te same handlery co route handlery Next.js,
// wywoływane z bindingami z Miniflare. Pozwala testować pełną ścieżkę Request → Response.

import { zaleznosciZBindingow, type Bindingi } from "../../src/lib/db/polaczenie";
import { obsluzListeSeansow, obsluzRezerwacje, obsluzSzczegolySeansu, obsluzZakup } from "../../src/lib/http/trasy";

export default {
  async fetch(zadanie, env, ctx) {
    const dostawca = () => zaleznosciZBindingow(env as unknown as Bindingi, { wTle: (p) => ctx.waitUntil(p) });
    const { pathname } = new URL(zadanie.url);
    const metoda = zadanie.method;
    let m: RegExpMatchArray | null;
    if (metoda === "GET" && pathname === "/api/events") return obsluzListeSeansow(dostawca);
    if (metoda === "GET" && (m = pathname.match(/^\/api\/events\/([^/]+)$/))) {
      return obsluzSzczegolySeansu(dostawca, decodeURIComponent(m[1] as string));
    }
    if (metoda === "POST" && pathname === "/api/reservations") return obsluzRezerwacje(zadanie, dostawca);
    if (metoda === "POST" && (m = pathname.match(/^\/api\/reservations\/([^/]+)\/purchase$/))) {
      return obsluzZakup(dostawca, decodeURIComponent(m[1] as string));
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Cloudflare.Env>;
