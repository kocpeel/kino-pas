import { act, render, renderHook, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CO_ILE_PING_MS, useNaZywo } from "@/hooks/useNaZywo";
import { mockLink, mockNavigation } from "./mocki-next";
import { ustawWidocznosc } from "./przygotuj";
import { SztucznyWebSocket } from "./sztuczny-websocket";

vi.mock("next/navigation", () => mockNavigation());
vi.mock("next/link", () => mockLink());

const pobierzSzczegolySeansu = vi.fn();
vi.mock("@/lib/klient/api", async (oryginal) => ({
  ...(await oryginal<typeof import("@/lib/klient/api")>()),
  pobierzSzczegolySeansu: (...argumenty: unknown[]) => pobierzSzczegolySeansu(...argumenty),
}));

const { MapaSali, INTERWAL_ODSWIEZANIA_MS } = await import("@/components/sala/MapaSali");

const stan = (takenSeats: string[]) => ({
  typ: "stan",
  dane: { event: { id: "metropolis" }, takenSeats },
  etag: `W/"${takenSeats.join("")}"`,
});

const fotel = (seatId: string) => document.querySelector<HTMLButtonElement>(`[data-seat="${seatId}"]`)!;

function renderujMape() {
  return render(<MapaSali eventId="metropolis" rzedy={8} miejscaWRzedzie={10} poczatkoweZajete={[]} />);
}

beforeEach(() => {
  pobierzSzczegolySeansu.mockReset();
  pobierzSzczegolySeansu.mockResolvedValue({ dane: { event: {}, takenSeats: [] }, etag: 'W/"0"' });
});

describe("mapa na żywo (WebSocket)", () => {
  it("łączy się z kanałem sali przez ws:// na tym samym hoście", () => {
    renderujMape();
    const url = new URL(SztucznyWebSocket.ostatni().url);
    expect(url.protocol).toBe("ws:");
    expect(url.host).toBe(window.location.host);
    expect(url.pathname).toBe("/api/events/metropolis/live");
  });

  it("gdy kanał działa: pokazuje „Na żywo”, nie odpytuje serwera i od razu nanosi zmiany", async () => {
    vi.useFakeTimers();
    renderujMape();
    act(() => SztucznyWebSocket.ostatni().otworz());
    expect(screen.getByText("Na żywo")).toBeInTheDocument();

    act(() => SztucznyWebSocket.ostatni().odbierz(stan(["D4"])));
    expect(fotel("D4")).toHaveClass("fotel--zajety");

    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(pobierzSzczegolySeansu).not.toHaveBeenCalled();
  });

  it("po zerwaniu kanału od razu odpytuje serwer i próbuje połączyć się ponownie", async () => {
    vi.useFakeTimers();
    renderujMape();
    act(() => SztucznyWebSocket.ostatni().otworz());
    act(() => SztucznyWebSocket.ostatni().zerwij());
    expect(screen.queryByText("Na żywo")).not.toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(pobierzSzczegolySeansu).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(SztucznyWebSocket.instancje).toHaveLength(2);
    act(() => SztucznyWebSocket.ostatni().otworz());
    expect(screen.getByText("Na żywo")).toBeInTheDocument();
  });

  it("bez kanału (np. zablokowany w sieci) mapa działa na zwykłym odpytywaniu", async () => {
    vi.useFakeTimers();
    renderujMape();
    await act(() => vi.advanceTimersByTimeAsync(INTERWAL_ODSWIEZANIA_MS));
    expect(pobierzSzczegolySeansu).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Na żywo")).not.toBeInTheDocument();
  });

  it("ignoruje wiadomości w złym formacie", () => {
    renderujMape();
    act(() => SztucznyWebSocket.ostatni().otworz());
    act(() => SztucznyWebSocket.ostatni().odbierz("to nie JSON"));
    act(() => SztucznyWebSocket.ostatni().odbierz({ typ: "stan", dane: { takenSeats: "A1" } }));
    expect(fotel("A1")).not.toHaveClass("fotel--zajety");
  });
});

describe("useNaZywo", () => {
  it("podtrzymuje połączenie pingiem i pomija odpowiedzi pong", async () => {
    vi.useFakeTimers();
    const naWiadomosc = vi.fn();
    renderHook(() => useNaZywo("/kanal", naWiadomosc));
    act(() => SztucznyWebSocket.ostatni().otworz());
    await act(() => vi.advanceTimersByTimeAsync(2 * CO_ILE_PING_MS));
    expect(SztucznyWebSocket.ostatni().wyslane).toEqual(["ping", "ping"]);
    act(() => SztucznyWebSocket.ostatni().odbierz("pong"));
    expect(naWiadomosc).not.toHaveBeenCalled();
  });

  it("ponawia z rosnącym opóźnieniem, odpuszcza po limicie prób i wraca po powrocie na kartę", async () => {
    vi.useFakeTimers();
    renderHook(() => useNaZywo("/kanal", () => {}, { maxProb: 3 }));
    for (let i = 0; i < 4; i++) {
      act(() => SztucznyWebSocket.ostatni().zerwij());
      await act(() => vi.advanceTimersByTimeAsync(60_000));
    }
    expect(SztucznyWebSocket.instancje).toHaveLength(4); // pierwsza próba + 3 ponowienia
    expect(vi.getTimerCount()).toBe(0);

    act(() => ustawWidocznosc("hidden"));
    act(() => ustawWidocznosc("visible"));
    expect(SztucznyWebSocket.instancje).toHaveLength(5);
  });

  it("odmontowanie zamyka połączenie i nie zostawia timerów", async () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useNaZywo("/kanal", () => {}));
    act(() => SztucznyWebSocket.ostatni().otworz());
    unmount();
    expect(SztucznyWebSocket.ostatni().zamknietoKodem).toBe(1000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
