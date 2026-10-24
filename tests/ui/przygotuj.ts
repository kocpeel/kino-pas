import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { SztucznyWebSocket } from "./sztuczny-websocket";

// Zamiast prawdziwego WebSocketu z jsdom (który łączyłby się z siecią) atrapa sterowana z testu.
// Domyślnie nigdy się nie otwiera, więc komponenty zachowują się jak bez kanału na żywo.
beforeEach(() => {
  SztucznyWebSocket.instancje = [];
  vi.stubGlobal("WebSocket", SztucznyWebSocket);
});

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
