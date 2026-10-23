import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  sessionStorage.clear();
  ustawWidocznosc("visible");
});

let widocznosc: DocumentVisibilityState = "visible";
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => widocznosc });
Object.defineProperty(document, "hidden", { configurable: true, get: () => widocznosc === "hidden" });

/** Symuluje przełączenie karty przeglądarki. */
export function ustawWidocznosc(stan: DocumentVisibilityState): void {
  widocznosc = stan;
  document.dispatchEvent(new Event("visibilitychange"));
}
