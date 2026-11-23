// Karta A etapu IV w przeglądarce: „Powiadom mnie”, miejsce w kolejce, „Wypisz mnie”, a przy ofercie link do zapłaty.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BladApi } from "@/lib/klient/api";
import { odczytajRezerwacje } from "@/lib/klient/sesja";
import { mockLink, mockNavigation } from "./mocki-next";

vi.mock("next/navigation", () => mockNavigation());
vi.mock("next/link", () => mockLink());

const zapiszNaListe = vi.fn();
const pobierzZapisNaListe = vi.fn();
const wypiszZListy = vi.fn();
const pobierzRezerwacje = vi.fn();
vi.mock("@/lib/klient/api", async (oryginal) => ({
  ...(await oryginal<typeof import("@/lib/klient/api")>()),
  pobierzRezerwacje: (...a: unknown[]) => pobierzRezerwacje(...a),
  zapiszNaListe: (...a: unknown[]) => zapiszNaListe(...a),
  pobierzZapisNaListe: (...a: unknown[]) => pobierzZapisNaListe(...a),
  wypiszZListy: (...a: unknown[]) => wypiszZListy(...a),
}));

const { ListaOczekujacych } = await import("@/components/sala/ListaOczekujacych");

const ID = "11111111-2222-4333-8444-555555555555";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  pobierzRezerwacje.mockReset();
  zapiszNaListe.mockReset();
  pobierzZapisNaListe.mockReset();
  wypiszZListy.mockReset();
});

describe("lista oczekujących", () => {
  it("niewyprzedane wydarzenie: nic nie pokazuje", () => {
    const { container } = render(<ListaOczekujacych eventId="waitlist-test" wyprzedane={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("wyprzedane: „Powiadom mnie” zapisuje (customerName, email), pokazuje miejsce w kolejce i „Wypisz mnie”", async () => {
    zapiszNaListe.mockResolvedValue({ waitlistId: ID, position: 2 });
    pobierzZapisNaListe.mockResolvedValue({ status: "waiting", position: 2 });
    wypiszZListy.mockResolvedValue({ status: "left", position: 0 });
    const u = userEvent.setup();
    render(<ListaOczekujacych eventId="waitlist-test" wyprzedane />);

    await u.type(screen.getByLabelText("Imię"), " Ola ");
    await u.type(screen.getByLabelText("E-mail"), "Ola@Example.com");
    await u.click(screen.getByRole("button", { name: "Powiadom mnie" }));

    expect(zapiszNaListe).toHaveBeenCalledWith("waitlist-test", { email: "ola@example.com", customerName: "Ola" });
    expect(await screen.findByText("Jesteś na liście oczekujących")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(localStorage.getItem("lista:waitlist-test")).toBe(ID);
    expect(JSON.parse(localStorage.getItem(`lista-dane:${ID}`) ?? "null")).toEqual({ email: "ola@example.com", customerName: "Ola" });

    await u.click(screen.getByRole("button", { name: "Wypisz mnie" }));
    expect(wypiszZListy).toHaveBeenCalledWith(ID);
    expect(await screen.findByText("Wypisałeś się z listy oczekujących")).toBeInTheDocument();

    // „Zapisz się ponownie”: panel wraca do formularza, a e-mail i imię starego zapisu znikają z tej przeglądarki.
    await u.click(screen.getByRole("button", { name: "Zapisz się ponownie" }));
    expect(screen.getByRole("button", { name: "Powiadom mnie" })).toBeInTheDocument();
    expect(localStorage.getItem("lista:waitlist-test")).toBeNull();
    expect(localStorage.getItem(`lista-dane:${ID}`)).toBeNull();
  });

  it("zapisany wcześniej w tej przeglądarce: oferta z linkiem do zapłaty i godziną", async () => {
    localStorage.setItem("lista:waitlist-test", ID);
    const reservationId = "99999999-8888-4777-8666-555555555555";
    pobierzZapisNaListe.mockResolvedValue({
      status: "offered",
      position: 0,
      reservationId,
      offerExpiresAt: Date.UTC(2026, 11, 31, 17, 2, 3),
      seatId: "A2",
    });
    render(<ListaOczekujacych eventId="waitlist-test" wyprzedane />);
    expect(await screen.findByText("Zwolniło się miejsce dla Ciebie")).toBeInTheDocument();
    expect(screen.getByText(/Rząd A, miejsce 2 czeka/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Zapłać za miejsce" })).toHaveAttribute(
      "href",
      `/rezerwacja/${reservationId}?seans=waitlist-test&miejsce=A2`,
    );
  });

  it("oferta: rezerwacja z e-mailem z „Powiadom mnie” trafia do pamięci sesji, więc strona płatności zna konto punktów", async () => {
    localStorage.setItem("lista:waitlist-test", ID);
    localStorage.setItem(`lista-dane:${ID}`, JSON.stringify({ email: "ola@example.com", customerName: "Ola" }));
    const reservationId = "99999999-8888-4777-8666-555555555555";
    const expiresAt = Date.UTC(2026, 11, 31, 17, 2, 3);
    pobierzZapisNaListe.mockResolvedValue({ status: "offered", position: 0, reservationId, offerExpiresAt: expiresAt, seatId: "A2" });
    pobierzRezerwacje.mockResolvedValue({ dane: { status: "held", amount: 3200, expiresAt }, status: 200, przesuniecieZegara: 0, etag: null });
    render(<ListaOczekujacych eventId="waitlist-test" wyprzedane />);
    await waitFor(() =>
      expect(odczytajRezerwacje(reservationId)).toMatchObject({
        reservationId,
        eventId: "waitlist-test",
        seatId: "A2",
        amount: 3200,
        expiresAt,
        name: "Ola",
        email: "ola@example.com",
      }),
    );
    expect(pobierzRezerwacje).toHaveBeenCalledTimes(1);
  });

  it("błąd 409 not_sold_out: komunikat, że miejsce właśnie się zwolniło", async () => {
    zapiszNaListe.mockRejectedValue(new BladApi(409, "not_sold_out", "To wydarzenie nie jest wyprzedane."));
    const u = userEvent.setup();
    render(<ListaOczekujacych eventId="waitlist-test" wyprzedane />);
    await u.type(screen.getByLabelText("Imię"), "Ola");
    await u.type(screen.getByLabelText("E-mail"), "ola@example.com");
    await u.click(screen.getByRole("button", { name: "Powiadom mnie" }));
    expect(await screen.findByText(/Właśnie zwolniło się miejsce/)).toBeInTheDocument();
  });

  it("złe pola: komunikaty przy polach, bez wywołania serwera", async () => {
    const u = userEvent.setup();
    render(<ListaOczekujacych eventId="waitlist-test" wyprzedane />);
    await u.click(screen.getByRole("button", { name: "Powiadom mnie" }));
    await waitFor(() => expect(screen.getAllByText(/Podaj/).length).toBeGreaterThanOrEqual(2));
    expect(zapiszNaListe).not.toHaveBeenCalled();
  });
});
