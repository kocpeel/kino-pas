import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BladApi } from "@/lib/klient/api";
import { mockLink, mockNavigation, router } from "./mocki-next";
import { SztucznyWebSocket } from "./sztuczny-websocket";

vi.mock("next/navigation", () => mockNavigation());
vi.mock("next/link", () => mockLink());

const utworzRezerwacje = vi.fn();
vi.mock("@/lib/klient/api", async (oryginal) => ({
  ...(await oryginal<typeof import("@/lib/klient/api")>()),
  utworzRezerwacje: (...argumenty: unknown[]) => utworzRezerwacje(...argumenty),
}));

const { FormularzRezerwacji } = await import("@/components/rezerwacja/FormularzRezerwacji");

const stan = (takenSeats: string[]) => ({
  typ: "stan",
  dane: { event: { id: "metropolis" }, takenSeats },
  etag: `W/"${takenSeats.join("")}"`,
});

const TYTUL = "Ten fotel właśnie zajął ktoś inny";
const przycisk = () => screen.getByRole("button", { name: /Zarezerwuj fotel|Rezerwuję/ });

function renderuj() {
  render(<FormularzRezerwacji eventId="metropolis" seatId="F7" />);
  act(() => SztucznyWebSocket.ostatni().otworz());
}

async function wypelnij() {
  const u = userEvent.setup();
  await u.type(screen.getByLabelText("Imię"), "Jan");
  await u.type(screen.getByLabelText("E-mail"), "jan@example.com");
  return u;
}

beforeEach(() => {
  utworzRezerwacje.mockReset();
  router.push.mockReset();
});

describe("formularz na żywo", () => {
  it("słucha kanału sali tego seansu", () => {
    renderuj();
    expect(new URL(SztucznyWebSocket.ostatni().url).pathname).toBe("/api/events/metropolis/live");
  });

  it("gdy ktoś inny zarezerwuje ten fotel: komunikat, zablokowana wysyłka i powrót do mapy", async () => {
    renderuj();
    act(() => SztucznyWebSocket.ostatni().odbierz(stan(["A1"])));
    expect(screen.queryByText(TYTUL)).not.toBeInTheDocument();

    act(() => SztucznyWebSocket.ostatni().odbierz(stan(["A1", "F7"])));
    expect(screen.getByRole("alert")).toHaveTextContent(TYTUL);
    expect(przycisk()).toBeDisabled();
    expect(screen.getByRole("link", { name: "Wróć do mapy" })).toHaveAttribute("href", "/seans/metropolis?zajete=F7");

    await wypelnij();
    fireEvent.submit(przycisk().closest("form")!);
    expect(utworzRezerwacje).not.toHaveBeenCalled();
  });

  it("gdy tamta rezerwacja wygaśnie, formularz sam się odblokowuje", () => {
    renderuj();
    act(() => SztucznyWebSocket.ostatni().odbierz(stan(["F7"])));
    expect(przycisk()).toBeDisabled();
    act(() => SztucznyWebSocket.ostatni().odbierz(stan([])));
    expect(screen.queryByText(TYTUL)).not.toBeInTheDocument();
    expect(przycisk()).toBeEnabled();
  });

  it("własna rezerwacja nie jest brana za cudzą (zmiana przychodzi przed odpowiedzią)", async () => {
    let rozwiaz!: (v: unknown) => void;
    utworzRezerwacje.mockReturnValue(new Promise((r) => (rozwiaz = r)));
    renderuj();
    const u = await wypelnij();
    await u.click(przycisk());
    act(() => SztucznyWebSocket.ostatni().odbierz(stan(["F7"]))); // rozgłoszenie naszej rezerwacji
    expect(screen.queryByText(TYTUL)).not.toBeInTheDocument();

    await act(async () => rozwiaz({ dane: { reservationId: "r-1", expiresAt: Date.now() + 60_000 }, status: 201, przesuniecieZegara: 0 }));
    expect(router.push).toHaveBeenCalledWith("/rezerwacja/r-1?seans=metropolis&miejsce=F7");
    expect(screen.queryByText(TYTUL)).not.toBeInTheDocument();
  });

  it("po timeoucie (zapis mógł się udać) zajęcie fotela nie jest ogłaszane jako cudze", async () => {
    utworzRezerwacje.mockRejectedValue(new BladApi(0, "timeout", "Serwer nie odpowiedział na czas."));
    renderuj();
    const u = await wypelnij();
    await u.click(przycisk());
    expect(await screen.findByRole("alert")).toHaveTextContent("Serwer nie odpowiedział na czas");
    act(() => SztucznyWebSocket.ostatni().odbierz(stan(["F7"])));
    expect(screen.queryByText(TYTUL)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Spróbuj ponownie" })).toBeEnabled();
  });

  it("po 409 (rozstrzygnięte: to nie my) kolejne zajęcie pokazuje komunikat o cudzej rezerwacji", async () => {
    utworzRezerwacje.mockRejectedValue(new BladApi(409, "seat_taken", "Ten fotel został właśnie zajęty."));
    renderuj();
    const u = await wypelnij();
    await u.click(przycisk());
    act(() => SztucznyWebSocket.ostatni().odbierz(stan(["F7"])));
    expect(screen.getByText(TYTUL)).toBeInTheDocument();
    expect(przycisk()).toBeDisabled();
  });
});
