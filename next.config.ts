import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {
  // Osobny katalog dla serwera e2e, żeby mógł działać obok zwykłego `next dev`.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default async function konfiguracja(faza: string): Promise<NextConfig> {
  if (faza === PHASE_DEVELOPMENT_SERVER) {
    // Podłącza bindingi z wrangler.jsonc (D1, rate limit, vars) do `next dev`. Czekamy na start,
    // żeby pierwsze żądanie nie trafiło przed gotowe bindingi.
    // CLOUDFLARE_ENV=e2e wybiera środowisko testów e2e (osobna baza, TTL 5 s).
    await initOpenNextCloudflareForDev({ environment: process.env.CLOUDFLARE_ENV || undefined });
  }
  return nextConfig;
}
