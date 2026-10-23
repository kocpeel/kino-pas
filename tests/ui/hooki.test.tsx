// Wycieki po stronie klienta: po odmontowaniu nie zostaje żaden timer ani niedokończony fetch.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useCountdown } from "@/hooks/useCountdown";
import { usePolling } from "@/hooks/usePolling";
import { ustawWidocznosc } from "./przygotuj";

describe("usePolling", () => {
  it("odmontowanie przerywa trwające żądanie (AbortController) i czyści timery", async () => {
    vi.useFakeTimers();
    let sygnal: AbortSignal | undefined;
    const pobierz = vi.fn((s: AbortSignal) => {
      sygnal = s;
      return new Promise<never>(() => {});
    });
    const { unmount } = renderHook(() => usePolling(pobierz, { interwalMs: 1000 }));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(pobierz).toHaveBeenCalledTimes(1);
    unmount();
    expect(sygnal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("backoff przy błędach i zatrzymanie po limicie porażek", async () => {
    vi.useFakeTimers();
    const pobierz = vi.fn().mockRejectedValue(new Error("x"));
    const { result } = renderHook(() => usePolling(pobierz, { interwalMs: 1000, maxPorazek: 3 }));
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(pobierz).toHaveBeenCalledTimes(3);
    expect(result.current.zatrzymany).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ukrycie karty przerywa żądanie i nie planuje kolejnych", async () => {
    vi.useFakeTimers();
    let sygnal: AbortSignal | undefined;
    const pobierz = vi.fn((s: AbortSignal) => ((sygnal = s), new Promise<never>(() => {})));
    renderHook(() => usePolling(pobierz, { interwalMs: 1000 }));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    act(() => ustawWidocznosc("hidden"));
    expect(sygnal?.aborted).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(pobierz).toHaveBeenCalledTimes(1);
  });
});

describe("useCountdown", () => {
  it("jeden timer w trakcie, zero po odmontowaniu", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { result, unmount } = renderHook(() => useCountdown(10_000));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.pozostaloMs).toBe(10_000);
    expect(vi.getTimerCount()).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uwzględnia przesunięcie zegara serwera", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    // Zegar serwera jest 4 s przed przeglądarką.
    const { result } = renderHook(() => useCountdown(10_000, 4_000));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.pozostaloMs).toBe(6_000);
  });

  it("po wygaśnięciu nie zostawia timera", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { result } = renderHook(() => useCountdown(1_500));
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(result.current.wygasla).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
