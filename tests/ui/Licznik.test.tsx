import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatujPozostalo } from "@/hooks/useCountdown";
import { BladApi } from "@/lib/klient/api";
import { zapiszRezerwacje } from "@/lib/klient/sesja";
import { mockLink, mockNavigation, router } from "./mocki-next";
import { ustawWidocznosc } from "./przygotuj";

vi.mock("next/navigation", () => mockNavigation());
vi.mock("next/link", () => mockLink());

const utworzPlatnosc = vi.fn();
const pobierzRezerwacje = vi.fn();
const przejdzDoPlatnosci = vi.fn();
vi.mock("@/lib/klient/api", async (oryginal) => ({
  ...(await oryginal<typeof import("@/lib/klient/api")>()),
  utworzPlatnosc: (...argumenty: unknown[]) => utworzPlatnosc(...argumenty),
  pobierzRezerwacje: (...argumenty: unknown[]) => pobierzRezerwacje(...argumenty),
}));
vi.mock("@/lib/klient/przekierowanie", () => ({
  przejdzDoPlatnosci: (url: string) => przejdzDoPlatnosci(url),
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
    amount: 3200,
    utworzono: START,
    przesuniecieZegara: 0,
    name: "Jan",
    email: "jan@example.com",
  });
}

/** Serwer potwierdza rezerwację z tym samym czasem co sessionStorage. */
function serwerTrzyma(naIleMs: number) {
  pobierzRezerwacje.mockResolvedValue({
    dane: { status: "held", amount: 3200, expiresAt: START + naIleMs },
    status: 200,
    przesuniecieZegara: 0,
    etag: null,
  });
}

function renderuj(przerwano = false) {
  return render(
    <Licznik
      reservationId={ID}
      eventId="metropolis"
      seatId="F7"
      seans={{ movie: "Metropolis", hall: "Sala 1", termin: "pt 6.11 · 19:30" }}
      przerwano={przerwano}
    />,
  );
}

beforeEach(() => {
  utworzPlatnosc.mockReset();
  pobierzRezerwacje.mockReset();
  pobierzRezerwacje.mockRejectedValue(new BladApi(0, "network", "Brak połączenia"));
  przejdzDoPlatnosci.mockReset();
  router.push.mockReset();
  router.replace.mockReset();
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
    expect(screen.getByText("Została mniej niż minuta na płatność.")).toBeInTheDocument();
  });

  it("po zerze przełącza się na stan wygasła z przyciskiem wyboru innego fotela", async () => {
    zarezerwowano(3_000);
    renderuj();
    await act(() => vi.advanceTimersByTimeAsync(3_100));
    expect(screen.getByRole("heading", { name: "Rezerwacja wygasła, fotel wrócił do puli" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Wybierz inny fotel" })).toHaveAttribute("href", "/seans/metropolis");
    expect(screen.queryByRole("button", { name: /Zapłać/ })).not.toBeInTheDocument();
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

  it("przycisk pokazuje cenę, a kliknięcie prowadzi na stronę płatności; podwójne = jedna sesja", async () => {
    zarezerwowano(120_000);
    serwerTrzyma(120_000);
    utworzPlatnosc.mockResolvedValue({ url: "https://checkout.stripe.test/c/pay/cs_1" });
    renderuj();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText("32 zł")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Zapłać 32 zł" }));
    fireEvent.click(screen.getByRole("button", { name: /Przechodzę do płatności/ }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(utworzPlatnosc).toHaveBeenCalledTimes(1);
    expect(przejdzDoPlatnosci).toHaveBeenCalledWith("https://checkout.stripe.test/c/pay/cs_1");
    // Przycisk zostaje zablokowany do końca nawigacji.
    expect(screen.getByRole("button", { name: /Przechodzę do płatności/ })).toBeDisabled();
  });

  it("powrót z przerwanej płatności: komunikat i można zapłacić jeszcze raz", async () => {
    zarezerwowano(120_000);
    serwerTrzyma(120_000);
    renderuj(true);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText("Płatność przerwana")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zapłać 32 zł" })).toBeEnabled();
  });

  it("Wstecz ze strony Stripe'a (strona z pamięci przeglądarki): przycisk znów działa", async () => {
    zarezerwowano(120_000);
    serwerTrzyma(120_000);
    utworzPlatnosc.mockResolvedValue({ url: "https://checkout.stripe.test/c/pay/cs_1" });
    renderuj();
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: "Zapłać 32 zł" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("button", { name: /Przechodzę do płatności/ })).toBeDisabled();

    await act(async () => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("button", { name: "Zapłać 32 zł" })).toBeEnabled();
    expect(pobierzRezerwacje).toHaveBeenCalledTimes(2);
  });

  it("410 z serwera przy płatności: stan wygasła, bo decyduje serwer", async () => {
    zarezerwowano(120_000);
    serwerTrzyma(120_000);
    utworzPlatnosc.mockRejectedValue(new BladApi(410, "reservation_expired", "Rezerwacja wygasła, fotel wrócił do puli."));
    renderuj();
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: "Zapłać 32 zł" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("heading", { name: "Rezerwacja wygasła, fotel wrócił do puli" })).toBeInTheDocument();
  });

  it("już opłacona: od razu do biletu", async () => {
    zarezerwowano(120_000);
    serwerTrzyma(120_000);
    utworzPlatnosc.mockRejectedValue(new BladApi(409, "reservation_already_paid", "Ta rezerwacja jest już opłacona."));
    renderuj();
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: "Zapłać 32 zł" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(router.replace).toHaveBeenCalledWith(`/bilet/${ID}?seans=metropolis&miejsce=F7`);
  });

  it("Stripe niedostępny: komunikat, rezerwacja bezpieczna, a przycisk ponawia", async () => {
    zarezerwowano(120_000);
    serwerTrzyma(120_000);
    utworzPlatnosc.mockRejectedValue(new BladApi(503, "payments_unavailable", "Płatności są chwilowo niedostępne."));
    renderuj();
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: "Zapłać 32 zł" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("alert")).toHaveTextContent("Płatności są chwilowo niedostępne");
    expect(screen.getByRole("button", { name: "Spróbuj ponownie: Zapłać 32 zł" })).toBeEnabled();
    expect(screen.getByRole("timer")).toBeInTheDocument();
  });

  it("serwer mówi, że opłacona: strona sama przechodzi do biletu", async () => {
    pobierzRezerwacje.mockResolvedValue({
      dane: { status: "paid", amount: 3200, expiresAt: START + 120_000, code: "ABCD-1234" },
      status: 200,
      przesuniecieZegara: 0,
      etag: null,
    });
    renderuj();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(router.replace).toHaveBeenCalledWith(`/bilet/${ID}?seans=metropolis&miejsce=F7`);
  });

  it("serwer mówi, że wygasła po zapłacie po czasie: stan wygasła z informacją o zwrocie", async () => {
    pobierzRezerwacje.mockResolvedValue({
      dane: { status: "expired", amount: 3200, expiresAt: START - 1000, refund: "pending" },
      status: 200,
      przesuniecieZegara: 0,
      etag: null,
    });
    renderuj();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("heading", { name: "Rezerwacja wygasła, fotel wrócił do puli" })).toBeInTheDocument();
    expect(screen.getByText(/Pieniądze wracają na Twoją kartę/)).toBeInTheDocument();
  });

  it("nowa karta bez sessionStorage: licznik i cena z serwera", async () => {
    serwerTrzyma(90_000);
    renderuj();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("timer")).toHaveTextContent("01:30");
    expect(screen.getByRole("button", { name: "Zapłać 32 zł" })).toBeEnabled();
  });

  it("nieznana rezerwacja (404): komunikat zamiast licznika", async () => {
    pobierzRezerwacje.mockRejectedValue(new BladApi(404, "not_found", "Nie ma takiej rezerwacji."));
    renderuj();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("heading", { name: "Nie znaleźliśmy tej rezerwacji" })).toBeInTheDocument();
  });

  it("serwer nieosiągalny i brak sessionStorage: nie wybucha i pozwala spróbować zapłacić", async () => {
    renderuj();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText("Nie widzimy czasu ważności tej rezerwacji")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zapłać" })).toBeEnabled();
  });

  it("po odmontowaniu nie zostaje żaden timer", async () => {
    zarezerwowano(120_000);
    const { unmount } = renderuj();
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("po odmontowaniu nie słucha już zdarzenia pageshow", async () => {
    zarezerwowano(120_000);
    serwerTrzyma(120_000);
    const { unmount } = renderuj();
    await act(() => vi.advanceTimersByTimeAsync(0));
    unmount();
    pobierzRezerwacje.mockClear();
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    expect(pobierzRezerwacje).not.toHaveBeenCalled();
  });
});
