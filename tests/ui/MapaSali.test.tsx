import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockLink, mockNavigation, router } from "./mocki-next";
import { ustawWidocznosc } from "./przygotuj";

vi.mock("next/navigation", () => mockNavigation());
vi.mock("next/link", () => mockLink());

const pobierzSzczegolySeansu = vi.fn();
vi.mock("@/lib/klient/api", async (oryginal) => ({
  ...(await oryginal<typeof import("@/lib/klient/api")>()),
  pobierzSzczegolySeansu: (...argumenty: unknown[]) => pobierzSzczegolySeansu(...argumenty),
}));

const { MapaSali, INTERWAL_ODSWIEZANIA_MS } = await import("@/components/sala/MapaSali");

function renderuj(zajete: string[] = ["A1"]) {
  return render(<MapaSali eventId="metropolis" rzedy={8} miejscaWRzedzie={10} poczatkoweZajete={zajete} />);
}

const fotel = (seatId: string) => document.querySelector<HTMLButtonElement>(`[data-seat="${seatId}"]`)!;

beforeEach(() => {
  pobierzSzczegolySeansu.mockReset();
  router.push.mockReset();
});

describe("MapaSali: klawiatura", () => {
  it("ma jeden fotel w kolejności Tab (pierwszy wolny)", () => {
    renderuj(["A1"]);
    const wTab = screen.getAllByRole("button").filter((b) => b.tabIndex === 0);
    expect(wTab).toHaveLength(1);
    expect(wTab[0]).toBe(fotel("A2"));
  });

  it("strzałki, Home i End przenoszą fokus po siatce", () => {
    renderuj([]);
    const siatka = screen.getByRole("grid");
    fotel("A1").focus();
    fireEvent.keyDown(siatka, { key: "ArrowRight" });
    expect(fotel("A2")).toHaveFocus();
    fireEvent.keyDown(siatka, { key: "ArrowDown" });
    expect(fotel("B2")).toHaveFocus();
    fireEvent.keyDown(siatka, { key: "End" });
    expect(fotel("B10")).toHaveFocus();
    fireEvent.keyDown(siatka, { key: "ArrowRight" });
    expect(fotel("B10")).toHaveFocus();
    fireEvent.keyDown(siatka, { key: "Home" });
    expect(fotel("B1")).toHaveFocus();
    fireEvent.keyDown(siatka, { key: "ArrowUp" });
    fireEvent.keyDown(siatka, { key: "ArrowUp" });
    expect(fotel("A1")).toHaveFocus();
    fireEvent.keyDown(siatka, { key: "End", ctrlKey: true });
    expect(fotel("H10")).toHaveFocus();
    expect(screen.getAllByRole("button").filter((b) => b.tabIndex === 0)).toEqual([fotel("H10")]);
  });

  it("zajęty fotel jest osiągalny strzałkami, ale nie przenosi do formularza", () => {
    renderuj(["A2"]);
    fotel("A1").focus();
    fireEvent.keyDown(screen.getByRole("grid"), { key: "ArrowRight" });
    expect(fotel("A2")).toHaveFocus();
    fireEvent.click(fotel("A2"));
    expect(router.push).not.toHaveBeenCalled();
  });

  it("wybór wolnego fotela przenosi do formularza (nic nie rezerwuje)", () => {
    renderuj();
    fireEvent.click(fotel("F7"));
    expect(router.push).toHaveBeenCalledWith("/seans/metropolis/miejsce/F7");
    expect(pobierzSzczegolySeansu).not.toHaveBeenCalled();
  });
});

describe("MapaSali: odświeżanie", () => {
  it("podmienia zajęte fotele po odpowiedzi serwera", async () => {
    vi.useFakeTimers();
    pobierzSzczegolySeansu.mockResolvedValue({ dane: { event: {}, takenSeats: ["C3"] }, etag: "W/\"1\"" });
    renderuj(["A1"]);
    expect(fotel("A1")).toHaveClass("fotel--zajety");
    await act(() => vi.advanceTimersByTimeAsync(INTERWAL_ODSWIEZANIA_MS));
    expect(pobierzSzczegolySeansu).toHaveBeenCalledTimes(1);
    expect(fotel("A1")).not.toHaveClass("fotel--zajety");
    expect(fotel("C3")).toHaveClass("fotel--zajety");
  });

  it("pauzuje na ukrytej karcie i wznawia po powrocie", async () => {
    vi.useFakeTimers();
    pobierzSzczegolySeansu.mockResolvedValue({ dane: { event: {}, takenSeats: [] }, etag: "W/\"0\"" });
    renderuj();
    act(() => ustawWidocznosc("hidden"));
    await act(() => vi.advanceTimersByTimeAsync(5 * INTERWAL_ODSWIEZANIA_MS));
    expect(pobierzSzczegolySeansu).not.toHaveBeenCalled();
    act(() => ustawWidocznosc("visible"));
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(pobierzSzczegolySeansu).toHaveBeenCalledTimes(1);
  });

  it("po kilku porażkach zatrzymuje się i pokazuje przycisk Odśwież", async () => {
    vi.useFakeTimers();
    pobierzSzczegolySeansu.mockRejectedValue(new Error("sieć"));
    renderuj();
    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));
    expect(pobierzSzczegolySeansu).toHaveBeenCalledTimes(4);
    const baner = screen.getByText("Nie udało się odświeżyć mapy").closest(".baner") as HTMLElement;
    pobierzSzczegolySeansu.mockResolvedValue({ dane: { event: {}, takenSeats: [] }, etag: "W/\"0\"" });
    fireEvent.click(within(baner).getByRole("button", { name: "Odśwież" }));
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(pobierzSzczegolySeansu).toHaveBeenCalledTimes(5);
  });

  it("po odmontowaniu nie zostaje żaden timer", async () => {
    vi.useFakeTimers();
    pobierzSzczegolySeansu.mockResolvedValue({ dane: { event: {}, takenSeats: [] }, etag: "W/\"0\"" });
    const { unmount } = renderuj();
    await act(() => vi.advanceTimersByTimeAsync(INTERWAL_ODSWIEZANIA_MS));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("komunikat po powrocie z 409", () => {
    render(<MapaSali eventId="m" rzedy={8} miejscaWRzedzie={10} poczatkoweZajete={[]} swiezoZajety="F7" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Ten fotel został właśnie zajęty");
    expect(fotel("F7")).toHaveClass("fotel--zajety");
  });
});

describe("MapaSali: koszt odświeżania", () => {
  // Serwer odpowiada 304: klient dostaje z powrotem TEN SAM obiekt co poprzednio.
  function bezZmianPoPierwszym() {
    const wersja = { dane: { event: {}, takenSeats: [] }, etag: 'W/"0"' };
    pobierzSzczegolySeansu.mockImplementation(async (_id: string, opcje: { poprzednia?: unknown }) =>
      opcje.poprzednia ?? wersja,
    );
  }

  it("gdy nic się nie zmienia, odpytuje coraz rzadziej (do 30 s), a nie co 5 s", async () => {
    vi.useFakeTimers();
    bezZmianPoPierwszym();
    renderuj();
    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
    const wywolania = pobierzSzczegolySeansu.mock.calls.length;
    // Stały interwał 5 s dałby 60 zapytań w 5 minut.
    expect(wywolania).toBeLessThan(20);
    expect(wywolania).toBeGreaterThanOrEqual(10);
    // Każde kolejne zapytanie niesie ETag poprzedniej wersji (If-None-Match).
    expect(pobierzSzczegolySeansu.mock.calls.at(-1)![1]).toMatchObject({ poprzednia: { etag: 'W/"0"' } });
  });

  it("interakcja z mapą wraca do odświeżania co 5 s", async () => {
    vi.useFakeTimers();
    bezZmianPoPierwszym();
    renderuj();
    await act(() => vi.advanceTimersByTimeAsync(3 * 60_000)); // interwał urósł do 30 s
    const przed = pobierzSzczegolySeansu.mock.calls.length;
    fireEvent.pointerEnter(document.querySelector(".sala")!);
    await act(() => vi.advanceTimersByTimeAsync(INTERWAL_ODSWIEZANIA_MS));
    expect(pobierzSzczegolySeansu.mock.calls.length).toBe(przed + 1);
  });

  it("po powrocie przyciskiem Wstecz (ten sam render serwera) odświeża od razu", async () => {
    vi.useFakeTimers();
    bezZmianPoPierwszym();
    const mapa = () => (
      <MapaSali eventId="wstecz" rzedy={8} miejscaWRzedzie={10} poczatkoweZajete={[]} wyrenderowano={123} />
    );
    const pierwszy = render(mapa());
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(pobierzSzczegolySeansu).not.toHaveBeenCalled(); // świeże dane z serwera: bez zapytania
    pierwszy.unmount();
    render(mapa()); // ten sam znacznik = dane z pamięci routera
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(pobierzSzczegolySeansu).toHaveBeenCalledTimes(1);
  });
});
