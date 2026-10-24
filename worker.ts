// Główny Worker aplikacji: opakowuje Workera wygenerowanego przez OpenNext.
// - /api/events/:id/live (WebSocket) idzie prosto do Durable Objectu sali, bo Next.js
//   nie potrafi zwrócić odpowiedzi 101 z WebSocketem,
// - wszystko inne obsługuje Next.js,
// - eksportuje klasę Durable Objectu `SalaSeansu` (binding SALE w wrangler.jsonc).
// Wzorzec „custom worker" z dokumentacji OpenNext dla Cloudflare.

// @ts-ignore `.open-next/worker.js` powstaje dopiero przy `opennextjs-cloudflare build`
import { default as nextjs } from "./.open-next/worker.js";
import { polaczZSala } from "./src/lib/push/polaczenie-na-zywo";
import { WZOR_SCIEZKI_NA_ZYWO } from "./src/lib/push/protokol";

export { SalaSeansu } from "./src/lib/push/sala-seansu";

export default {
  async fetch(zadanie, env, ctx) {
    const naZywo = WZOR_SCIEZKI_NA_ZYWO.exec(new URL(zadanie.url).pathname);
    if (naZywo) return polaczZSala(zadanie, env.SALE, decodeURIComponent(naZywo[1] as string));
    return nextjs.fetch(zadanie, env, ctx);
  },
} satisfies ExportedHandler<CloudflareEnv>;
