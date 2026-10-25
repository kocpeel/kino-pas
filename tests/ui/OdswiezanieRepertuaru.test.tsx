import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockNavigation, router } from "./mocki-next";
import { ustawWidocznosc } from "./przygotuj";

vi.mock("next/navigation", () => mockNavigation());

const { OdswiezanieRepertuaru, ODSWIEZANIE_W_TLE_MS, MIN_ODSTEP_MS } = await import(
  "@/components/repertuar/OdswiezanieRepertuaru"
);

beforeEach(() => {
  router.refresh.mockReset();
  vi.useFakeTimers();
});

describe("OdswiezanieRepertuaru", () => {
  it("świeży render z serwera: bez odświeżania; ten sam render ponownie (Wstecz): odświeża od razu", () => {
    const pierwszy = render(<OdswiezanieRepertuaru wyrenderowano={1000} />);
    expect(router.refresh).not.toHaveBeenCalled();
    pierwszy.unmount();
    act(() => vi.advanceTimersByTime(800)); // użytkownik był na innej stronie
    render(<OdswiezanieRepertuaru wyrenderowano={1000} />);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("natychmiastowy ponowny montaż (StrictMode w dev) nie jest powrotem", () => {
    const pierwszy = render(<OdswiezanieRepertuaru wyrenderowano={1500} />);
    pierwszy.unmount();
    render(<OdswiezanieRepertuaru wyrenderowano={1500} />);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("nowy render po odświeżeniu nie wywołuje kolejnego (brak pętli)", () => {
    const widok = render(<OdswiezanieRepertuaru wyrenderowano={2000} />);
    widok.rerender(<OdswiezanieRepertuaru wyrenderowano={2001} />);
    widok.rerender(<OdswiezanieRepertuaru wyrenderowano={2002} />);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("odświeża po powrocie na kartę, ale nie częściej niż co kilka sekund", () => {
    render(<OdswiezanieRepertuaru wyrenderowano={3000} />);
    act(() => vi.advanceTimersByTime(MIN_ODSTEP_MS));
    act(() => ustawWidocznosc("hidden"));
    act(() => ustawWidocznosc("visible"));
    act(() => ustawWidocznosc("hidden"));
    act(() => ustawWidocznosc("visible"));
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("w tle odświeża rzadko i tylko przy widocznej karcie; sprząta timer", () => {
    const { unmount } = render(<OdswiezanieRepertuaru wyrenderowano={4000} />);
    act(() => vi.advanceTimersByTime(ODSWIEZANIE_W_TLE_MS));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    act(() => ustawWidocznosc("hidden"));
    act(() => vi.advanceTimersByTime(3 * ODSWIEZANIE_W_TLE_MS));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
