import { act, render, renderHook, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CO_ILE_PING_MS, TIMEOUT_OTWARCIA_MS, USPIENIE_W_TLE_MS, useNaZywo } from "@/hooks/useNaZywo";
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

  it("gdy kanał działa: pokazuje „Na żywo”, od razu nanosi zmiany i tylko co minutę sprawdza ETagiem", async () => {
    vi.useFakeTimers();
    // Serwer: „bez zmian" (304) = funkcja oddaje tę samą wersję, którą dostała.
    pobierzSzczegolySeansu.mockImplementation(async (_id: string, opcje: { poprzednia?: unknown }) => opcje.poprzednia);
    renderujMape();
    act(() => SztucznyWebSocket.ostatni().otworz());
    expect(screen.getByText("Na żywo")).toBeInTheDocument();

    act(() => SztucznyWebSocket.ostatni().odbierz(stan(["D4"])));
    expect(fotel("D4")).toHaveClass("fotel--zajety");

    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
    // Zamiast 60 zapytań w 5 minut (odpytywanie co 5 s): jedno kontrolne na minutę,
    // z ETagiem stanu z kanału, więc serwer odpowiada 304 bez treści.
    expect(pobierzSzczegolySeansu).toHaveBeenCalledTimes(5);
    expect(pobierzSzczegolySeansu.mock.calls.at(-1)![1]).toMatchObject({ poprzednia: { etag: 'W/"D4"' } });
    expect(fotel("D4")).toHaveClass("fotel--zajety");
  });

  it("kontrola co minutę wyłapuje zmianę, o której kanał nie dał znać", async () => {
    vi.useFakeTimers();
    pobierzSzczegolySeansu.mockResolvedValue({ dane: { event: {}, takenSeats: ["B2"] }, etag: 'W/"B2"' });
    renderujMape();
    act(() => SztucznyWebSocket.ostatni().otworz());
    act(() => SztucznyWebSocket.ostatni().odbierz(stan([])));
    expect(fotel("B2")).not.toHaveClass("fotel--zajety");
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(fotel("B2")).toHaveClass("fotel--zajety");
  });

  it("odpowiedź na sprawdzenie wysłane przed nowszą wiadomością z kanału jej nie nadpisuje", async () => {
    vi.useFakeTimers();
    let odpowiedz!: (v: unknown) => void;
    pobierzSzczegolySeansu.mockImplementation(() => new Promise((r) => (odpowiedz = r)));
    renderujMape();
    act(() => SztucznyWebSocket.ostatni().otworz());
    act(() => SztucznyWebSocket.ostatni().odbierz(stan([])));
    await act(() => vi.advanceTimersByTimeAsync(60_000)); // kontrola wysłana, czeka na odpowiedź
    act(() => SztucznyWebSocket.ostatni().odbierz(stan(["C3"]))); // nowszy stan z kanału
    await act(async () => odpowiedz({ dane: { event: {}, takenSeats: [] }, etag: 'W/"stary"' }));
    expect(fotel("C3")).toHaveClass("fotel--zajety");
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

  it("połączenie, które wisi (np. zablokowane w sieci), po 10 s przechodzi na zwykłe odpytywanie", async () => {
    vi.useFakeTimers();
    renderujMape(); // atrapa nigdy się nie otwiera
    await act(() => vi.advanceTimersByTimeAsync(TIMEOUT_OTWARCIA_MS - 1));
    expect(pobierzSzczegolySeansu).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1)); // timeout otwarcia: tryb zapasowy
    await act(() => vi.advanceTimersByTimeAsync(INTERWAL_ODSWIEZANIA_MS));
    expect(pobierzSzczegolySeansu).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Na żywo")).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(INTERWAL_ODSWIEZANIA_MS));
    expect(pobierzSzczegolySeansu).toHaveBeenCalledTimes(2);
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

  it("wiszące próby kończą się po 10 s; ponawia z rosnącym opóźnieniem, odpuszcza po limicie i wraca po powrocie na kartę", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useNaZywo("/kanal", () => {}, { maxProb: 3 }));
    expect(result.current.trybZapasowy).toBe(false); // pierwsze łączenie to jeszcze nie awaria
    await act(() => vi.advanceTimersByTimeAsync(TIMEOUT_OTWARCIA_MS));
    expect(SztucznyWebSocket.instancje[0]!.zamknietoKodem).not.toBeNull();
    expect(result.current.trybZapasowy).toBe(true);

    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));
    expect(SztucznyWebSocket.instancje).toHaveLength(4); // pierwsza próba + 3 ponowienia
    expect(vi.getTimerCount()).toBe(0);

    act(() => ustawWidocznosc("hidden"));
    act(() => ustawWidocznosc("visible"));
    expect(SztucznyWebSocket.instancje).toHaveLength(5);
  });

  it("po minucie na ukrytej karcie usypia kanał, a po powrocie łączy się od nowa", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useNaZywo("/kanal", () => {}));
    act(() => SztucznyWebSocket.ostatni().otworz());
    act(() => ustawWidocznosc("hidden"));
    await act(() => vi.advanceTimersByTimeAsync(USPIENIE_W_TLE_MS - 1));
    expect(SztucznyWebSocket.ostatni().zamknietoKodem).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(SztucznyWebSocket.ostatni().zamknietoKodem).toBe(1000);
    expect(result.current.stan).toBe("uspiony");
    expect(result.current.trybZapasowy).toBe(false); // uśpienie to nie awaria: bez odpytywania w tle
    expect(vi.getTimerCount()).toBe(0); // ani pingów, ani ponowień

    act(() => ustawWidocznosc("visible"));
    expect(SztucznyWebSocket.instancje).toHaveLength(2);
    act(() => SztucznyWebSocket.ostatni().otworz());
    expect(result.current.stan).toBe("na-zywo");
  });

  it("krótkie przełączenie karty niczego nie zrywa", async () => {
    vi.useFakeTimers();
    renderHook(() => useNaZywo("/kanal", () => {}));
    act(() => SztucznyWebSocket.ostatni().otworz());
    act(() => ustawWidocznosc("hidden"));
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    act(() => ustawWidocznosc("visible"));
    await act(() => vi.advanceTimersByTimeAsync(2 * USPIENIE_W_TLE_MS));
    expect(SztucznyWebSocket.instancje).toHaveLength(1);
    expect(SztucznyWebSocket.ostatni().zamknietoKodem).toBeNull();
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
