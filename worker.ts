// Główny Worker aplikacji: opakowuje Workera wygenerowanego przez OpenNext.
// - /api/events/:id/live (WebSocket) idzie prosto do Durable Objectu sali, bo Next.js
//   nie potrafi zwrócić odpowiedzi 101 z WebSocketem (z limitem połączeń na IP i load sheddingiem),
// - wszystko inne obsługuje Next.js; żądania stron dostają nonce i Content-Security-Policy (src/lib/http/csp.ts),
// - eksportuje klasy Durable Objectów `SalaSeansu` (binding SALE) i `LimiterZadan` (binding LIMITER).
// Wzorzec „custom worker" z dokumentacji OpenNext dla Cloudflare.

// @ts-ignore `.open-next/worker.js` powstaje dopiero przy `opennextjs-cloudflare build`
import { default as nextjs } from "./.open-next/worker.js";
import { wczytajKonfiguracje } from "./src/lib/config";
import { czyZadanieStrony, zadanieZCsp, zCspNaOdpowiedzi } from "./src/lib/http/csp";
import { polaczZSala } from "./src/lib/push/polaczenie-na-zywo";
import { WZOR_SCIEZKI_NA_ZYWO } from "./src/lib/push/protokol";
import { straznikDlaIzolatu } from "./src/lib/resilience/przeciazenie";

export { SalaSeansu } from "./src/lib/push/sala-seansu";
export { LimiterZadan } from "./src/lib/resilience/limiter-zadan";

function straznik(env: CloudflareEnv) {
  try {
    const { maxOdczytow, maxZapisow, celOpoznieniaBazyMs } = wczytajKonfiguracje(env as unknown as Record<string, unknown>);
    // Ten sam strażnik (globalThis) co w Next.js: połączenia kanału liczą się do wspólnego obciążenia.
    return straznikDlaIzolatu({ maxOdczytow, maxZapisow, celOpoznieniaMs: celOpoznieniaBazyMs });
  } catch {
    return undefined;
  }
}

export default {
  async fetch(zadanie, env, ctx) {
    const naZywo = WZOR_SCIEZKI_NA_ZYWO.exec(new URL(zadanie.url).pathname);
    if (naZywo) {
      return polaczZSala(zadanie, env.SALE, decodeURIComponent(naZywo[1] as string), {
        limiter: env.RL_KANAL_IP,
        okresLimituS: 60,
        straznik: straznik(env),
      });
    }
    if (!czyZadanieStrony(zadanie)) return nextjs.fetch(zadanie, env, ctx);
    const { zadanie: zNonce, polityka } = zadanieZCsp(zadanie);
    return zCspNaOdpowiedzi(await nextjs.fetch(zNonce, env, ctx), polityka);
  },
} satisfies ExportedHandler<CloudflareEnv>;
