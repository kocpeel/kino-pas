// Strona powrotu po płatności: „płatność w toku…”, która sama zamienia się w bilet z kodem.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BladApi } from "@/lib/klient/api";
import { odczytajKodBiletu, zapiszKodBiletu } from "@/lib/klient/sesja";
import { mockLink, mockNavigation } from "./mocki-next";

vi.mock("next/navigation", () => mockNavigation());
vi.mock("next/link", () => mockLink());

const pobierzRezerwacje = vi.fn();
vi.mock("@/lib/klient/api", async (oryginal) => ({
  ...(await oryginal<typeof import("@/lib/klient/api")>()),
  pobierzRezerwacje: (...argumenty: unknown[]) => pobierzRezerwacje(...argumenty),
}));

const { AkcjeBiletu } = await import("@/components/bilet/AkcjeBiletu");

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const KOD = "ABCD-1234";
const DANE = { movie: "Metropolis", hall: "Sala 1", termin: "pt 6.11 · 19:30", rzad: "F", numer: 7 };

function odpowiedz(stan: Record<string, unknown>) {
  return { dane: { amount: 3200, expiresAt: 1, ...stan }, status: 200, przesuniecieZegara: 0, etag: null };
}

function renderuj(sesjaStripe: string | null = "cs_test_1") {
  return render(<AkcjeBiletu reservationId={ID} dane={DANE} sesjaStripe={sesjaStripe} adresRezerwacji={`/rezerwacja/${ID}`} />);
}

beforeEach(() => {
  pobierzRezerwacje.mockReset();
  sessionStorage.clear();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});

describe("AkcjeBiletu", () => {
  it("„płatność w toku…” sama zamienia się w bilet, gdy serwer dostanie webhook", async () => {
    pobierzRezerwacje.mockResolvedValue(odpowiedz({ status: "held" }));
    renderuj();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText("Płatność w toku…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Kopiuj kod" })).toBeDisabled();

    pobierzRezerwacje.mockResolvedValue(odpowiedz({ status: "paid", code: KOD }));
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(screen.queryByText("Płatność w toku…")).not.toBeInTheDocument();
    expect(screen.getByText(KOD)).toBeInTheDocument();
    expect(screen.getByText(/Zapłacono 32 zł/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Kopiuj kod" })).toBeEnabled();
    expect(odczytajKodBiletu(ID)).toBe(KOD);

    // Po bilecie koniec odpytywania.
    const liczba = pobierzRezerwacje.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(pobierzRezerwacje).toHaveBeenCalledTimes(liczba);
  });

  it("webhook się spóźnia: mówi, co się dzieje, i daje drogę z powrotem", async () => {
    pobierzRezerwacje.mockResolvedValue(odpowiedz({ status: "held" }));
    renderuj();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.queryByRole("link", { name: "Wróć do rezerwacji" })).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(21_000));
    expect(screen.getByText("Płatność w toku…")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Wróć do rezerwacji" })).toHaveAttribute("href", `/rezerwacja/${ID}`);
  });

  it("wejście bez powrotu ze Stripe'a: od razu droga do rezerwacji", async () => {
    pobierzRezerwacje.mockResolvedValue(odpowiedz({ status: "held" }));
    renderuj(null);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("link", { name: "Wróć do rezerwacji" })).toBeInTheDocument();
  });

  it("kod z tej karty widać od razu, także gdy serwer nie odpowiada", async () => {
    zapiszKodBiletu(ID, KOD);
    pobierzRezerwacje.mockRejectedValue(new BladApi(503, "unavailable", "Niedostępne"));
    renderuj();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText(KOD)).toBeInTheDocument();
    expect(screen.queryByText("Płatność w toku…")).not.toBeInTheDocument();
  });

  it("płatność po czasie: bez biletu, z informacją o zwrocie", async () => {
    pobierzRezerwacje.mockResolvedValue(odpowiedz({ status: "expired", refund: "pending" }));
    renderuj();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("heading", { name: "Ta rezerwacja wygasła" })).toBeInTheDocument();
    expect(screen.getByText(/Pieniądze wracają na Twoją kartę/)).toBeInTheDocument();
  });

  it("nieudany zwrot: mówi wprost, że zajmie się tym obsługa", async () => {
    pobierzRezerwacje.mockResolvedValue(odpowiedz({ status: "expired", refund: "failed" }));
    renderuj();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText(/Obsługa zwróci pieniądze ręcznie/)).toBeInTheDocument();
  });

  it("wygasła bez płatności", async () => {
    pobierzRezerwacje.mockResolvedValue(odpowiedz({ status: "expired" }));
    renderuj(null);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText(/zanim dotarła płatność/)).toBeInTheDocument();
  });

  it("nieznana rezerwacja", async () => {
    pobierzRezerwacje.mockRejectedValue(new BladApi(404, "not_found", "Nie ma takiej rezerwacji."));
    renderuj();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("heading", { name: "Nie znaleźliśmy tego biletu" })).toBeInTheDocument();
    const liczba = pobierzRezerwacje.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(pobierzRezerwacje).toHaveBeenCalledTimes(liczba);
  });

  it("seria awarii: zatrzymuje się z przyciskiem, a ten wznawia sprawdzanie", async () => {
    pobierzRezerwacje.mockRejectedValue(new BladApi(503, "unavailable", "Niedostępne"));
    renderuj();
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(screen.getByRole("alert")).toBeInTheDocument();

    pobierzRezerwacje.mockResolvedValue(odpowiedz({ status: "paid", code: KOD }));
    fireEvent.click(screen.getByRole("button", { name: "Spróbuj ponownie" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText(KOD)).toBeInTheDocument();
  });

  it("po odmontowaniu nie zostaje żaden timer", async () => {
    pobierzRezerwacje.mockResolvedValue(odpowiedz({ status: "held" }));
    const { unmount } = renderuj();
    await act(() => vi.advanceTimersByTimeAsync(0));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
