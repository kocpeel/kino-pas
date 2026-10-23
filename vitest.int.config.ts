import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Testy integracyjne w środowisku Workerów (workerd + Miniflare) na prawdziwym D1
// z tymi samymi migracjami co produkcja. Każdy plik testów ma osobną bazę.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./tests/integracyjne/wrangler.test.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(fileURLToPath(new URL("./migrations", import.meta.url))),
        },
      },
    })),
  ],
  test: {
    include: ["tests/integracyjne/**/*.test.ts"],
    setupFiles: ["./tests/integracyjne/przygotuj.ts"],
    testTimeout: 20_000,
  },
});
