import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Testy komponentów (Testing Library) w jsdom.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    include: ["tests/ui/**/*.test.tsx"],
    environment: "jsdom",
    setupFiles: ["./tests/ui/przygotuj.ts"],
  },
});
