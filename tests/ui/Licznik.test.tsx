import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatujPozostalo } from "@/hooks/useCountdown";
import { BladApi } from "@/lib/klient/api";
import { zapiszRezerwacje } from "@/lib/klient/sesja";
import { mockLink, mockNavigation, router } from "./mocki-next";
import { ustawWidocznosc } from "./przygotuj";

vi.mock("next/navigation", () => mockNavigation());
vi.mock("next/link", () => mockLink());

const kupBilet = vi.fn();
vi.mock("@/lib/klient/api", async (oryginal) => ({
  ...(await oryginal<typeof import("@/lib/klient/api")>()),
  kupBilet: (...argumenty: unknown[]) => kupBilet(...argumenty),
}));

const { Licznik } = await import("@/components/rezerwacja/Licznik");

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const START = Date.UTC(2026, 10, 6, 12, 0, 0);

function zarezerwowano(naIleMs: number) {
  zapiszRezerwacje({
    reservationId: ID,
    eventId: "metropolis",
    seatId: "F7",
    expiresAt: START + naIleMs,
    utworzono: START,
    przesuniecieZegara: 0,
    name: "Jan",
    email: "jan@example.com",
  });
}

function renderuj() {
  return render(
    <Licznik
      reservationId={ID}
      eventId="metropolis"
      seatId="F7"
      seans={{ movie: "Metropolis", hall: "Sala 1", termin: "pt 6.11 · 19:30" }}
    />,
  );
}

beforeEach(() => {
  kupBilet.mockReset();
  router.push.mockReset();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(START);
});

describe("formatowanie licznika", () => {
  it.each([
    [872_000, "14:32"],
    [60_000, "01:00"],
    [59_001, "01:00"],
    [59_000, "00:59"],
    [1, "00:01"],
    [0, "00:00"],
  ])("%i ms → %s", (ms, tekst) => {
    expect(formatujPozostalo(ms)).toBe(tekst);
  });
});

describe("Licznik", () => {
  it("pokazuje mm:ss liczone z expiresAt, z podsumowaniem", async () => {
    zarezerwowano(125_000);
    renderuj();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("timer")).toHaveTextContent("02:05");
    expect(screen.getByText("Rząd F, miejsce 7")).toBeInTheDocument();
    expect(screen.getByText("jan@example.com")).toBeInTheDocument();
    // Tik wypada tuż po zmianie wyświetlanej sekundy (+5 ms zapasu na niedokładność timerów).
    await act(() => vi.advanceTimersByTimeAsync(5_010));
    expect(screen.getByRole("timer")).toHaveTextContent("02:00");
  });

  it("poniżej minuty zmienia styl na ostrzegawczy i ogłasza próg", async () => {
    zarezerwowano(61_000);
    renderuj();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("heading", { level: 1 })).not.toHaveClass("licznik--ostrzezenie");
    await act(() => vi.advanceTimersByTimeAsync(1_010));
    expect(screen.getByRole("heading", { level: 1 })).toHaveClass("licznik--ostrzezenie");
    expect(screen.getByText("Została mniej niż minuta na zakup biletu.")).toBeInTheDocument();
  });

  it("po zerze przełącza się na stan wygasła z przyciskiem wyboru innego fotela", async () => {
    zarezerwowano(3_000);
    renderuj();
    await act(() => vi.advanceTimersByTimeAsync(3_100));
    expect(screen.getByRole("heading", { name: "Rezerwacja wygasła, fotel wrócił do puli" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Wybierz inny fotel" })).toHaveAttribute("href", "/seans/metropolis");
    expect(screen.queryByRole("button", { name: /Kupuję bilet/ })).not.toBeInTheDocument();
  });

  it("po powrocie na kartę od razu pokazuje poprawny czas (przeskok zegara)", async () => {
    zarezerwowano(10 * 60_000);
    renderuj();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("timer")).toHaveTextContent("10:00");
    act(() => ustawWidocznosc("hidden"));
    // Przeglądarka dławi timery w ukrytej karcie: zegar idzie, timery nie.
    vi.setSystemTime(START + 7 * 60_000);
    act(() => ustawWidocznosc("visible"));
    expect(screen.getByRole("timer")).toHaveTextContent("03:00");
  });

  it("410 z serwera przy zakupie: stan wygasła, bo decyduje serwer", async () => {
    zarezerwowano(120_000);
    kupBilet.mockRejectedValue(new BladApi(410, "reservation_expired", "Rezerwacja wygasła, fotel wrócił do puli."));
    renderuj();
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: "Kupuję bilet" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("heading", { name: "Rezerwacja wygasła, fotel wrócił do puli" })).toBeInTheDocument();
  });

  it("udany zakup zapisuje kod i przechodzi do biletu", async () => {
    zarezerwowano(120_000);
    kupBilet.mockResolvedValue({ code: "ABCD-1234" });
    renderuj();
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: "Kupuję bilet" }));
    fireEvent.click(screen.getByRole("button", { name: /Kupuję/ }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(kupBilet).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(`/bilet/${ID}?seans=metropolis&miejsce=F7`);
    expect(sessionStorage.getItem(`kasa-kino:bilet:${ID}`)).toContain("ABCD-1234");
  });

  it("bez danych w sessionStorage nie wybucha i pozwala spróbować kupić", async () => {
    renderuj();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText("Nie widzimy czasu ważności tej rezerwacji")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Kupuję bilet" })).toBeEnabled();
  });

  it("po odmontowaniu nie zostaje żaden timer", async () => {
    zarezerwowano(120_000);
    const { unmount } = renderuj();
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
