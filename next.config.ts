import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import { politykaCsp } from "./src/lib/http/csp";

const NAGLOWKI_BEZPIECZENSTWA = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  // Przeglądarka ignoruje HSTS po HTTP, więc lokalnie nic nie zmienia. Bez `preload`: workers.dev to cudza domena.
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), usb=()" },
];

function nextConfig(dev: boolean): NextConfig {
  // CSP z nonce'em na produkcji ustawia worker.ts; w `next dev` łagodniejsza polityka (src/lib/http/csp.ts).
  const naglowki = dev
    ? [
        ...NAGLOWKI_BEZPIECZENSTWA,
        {
          key: "Content-Security-Policy",
          value: politykaCsp({ https: false, dodatkowePolaczenia: ["ws://localhost:*", "ws://127.0.0.1:*"] }),
        },
      ]
    : NAGLOWKI_BEZPIECZENSTWA;
  return {
    // Osobny katalog dla serwera e2e, żeby mógł działać obok zwykłego `next dev`.
    distDir: process.env.NEXT_DIST_DIR || ".next",
    poweredByHeader: false,
    async headers() {
      return [{ source: "/:path*", headers: naglowki }];
    },
  };
}

export default async function konfiguracja(faza: string): Promise<NextConfig> {
  const dev = faza === PHASE_DEVELOPMENT_SERVER;
  if (dev) {
    // Podłącza bindingi z wrangler.jsonc (D1, rate limit, vars) do `next dev`. Czekamy na start,
    // żeby pierwsze żądanie nie trafiło przed gotowe bindingi.
    // CLOUDFLARE_ENV=e2e wybiera środowisko testów e2e (osobna baza, TTL 5 s).
    await initOpenNextCloudflareForDev({ environment: process.env.CLOUDFLARE_ENV || undefined });
  }
  return nextConfig(dev);
}
