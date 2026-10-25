// Content-Security-Policy. Na produkcji (worker.ts) każde żądanie strony dostaje świeży nonce: Next.js
// odczytuje go z nagłówka Content-Security-Policy żądania i dokleja do swoich skryptów, a przeglądarka
// wykona tylko skrypty z tym nonce'em ('strict-dynamic' przepuszcza to, co one doładują).
// W `next dev` worker.ts nie działa, więc next.config.ts ustawia łagodniejszą politykę bez nonce'a
// (React w trybie dev potrzebuje eval, a style są wstrzykiwane inline).

export function nowyNonce(): string {
  const bajty = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bajty));
}

export interface OpcjeCsp {
  /** Brak = tryb dev (bez nonce'a, z 'unsafe-inline' i 'unsafe-eval'). */
  nonce?: string;
  /** Strona po HTTPS: kanał na żywo przez wss:, a zasoby http podnoszone do https. */
  https: boolean;
  /** Host strony, np. kasa-kino.jajcokgt.workers.dev (jawne wss: dla przeglądarek bez CSP3 'self' dla ws). */
  host?: string;
  /** Dodatkowe źródła połączeń, np. Worker sali w `npm run dev` (ws://localhost:*). */
  dodatkowePolaczenia?: string[];
}

export function politykaCsp(o: OpcjeCsp): string {
  const dev = o.nonce === undefined;
  const polaczenia = ["'self'"];
  if (o.host) polaczenia.push(`${o.https ? "wss" : "ws"}://${o.host}`);
  polaczenia.push(...(o.dodatkowePolaczenia ?? []));
  const dyrektywy = [
    "default-src 'self'",
    dev ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : `script-src 'self' 'nonce-${o.nonce}' 'strict-dynamic'`,
    dev ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${o.nonce}'`,
    // Atrybuty style="" z renderu serwera (np. szerokość paska licznika). Nonce ich nie obejmuje.
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${polaczenia.join(" ")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "manifest-src 'self'",
    "worker-src 'self'",
  ];
  if (o.https) dyrektywy.push("upgrade-insecure-requests");
  return dyrektywy.join("; ");
}

/** Czy żądanie może zwrócić stronę HTML (dostaje nonce). API, pliki statyczne i WebSocket nie. */
export function czyZadanieStrony(zadanie: Request): boolean {
  if (zadanie.method !== "GET" && zadanie.method !== "HEAD") return false;
  const { pathname } = new URL(zadanie.url);
  return !pathname.startsWith("/api/") && !pathname.startsWith("/_next/static/") && !/\.[a-z0-9]+$/i.test(pathname);
}

/** Żądanie z nagłówkiem CSP (dla Next.js) i polityka do ustawienia na odpowiedzi HTML. */
export function zadanieZCsp(zadanie: Request): { zadanie: Request; polityka: string } {
  const url = new URL(zadanie.url);
  const polityka = politykaCsp({ nonce: nowyNonce(), https: url.protocol === "https:", host: url.host });
  const naglowki = new Headers(zadanie.headers);
  naglowki.set("content-security-policy", polityka);
  return { zadanie: new Request(zadanie, { headers: naglowki }), polityka };
}

/** Odpowiedź z CSP, jeśli to HTML (inne typy zostawiamy bez zmian). */
export function zCspNaOdpowiedzi(odpowiedz: Response, polityka: string): Response {
  if (!(odpowiedz.headers.get("content-type") ?? "").includes("text/html")) return odpowiedz;
  const nowa = new Response(odpowiedz.body, odpowiedz);
  nowa.headers.set("Content-Security-Policy", polityka);
  return nowa;
}
