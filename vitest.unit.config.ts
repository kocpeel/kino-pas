import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Testy jednostkowe domeny i czystych modułów: zwykły Node, bez Workerów i bez bazy.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["tests/jednostkowe/**/*.test.ts"],
    environment: "node",
  },
});
