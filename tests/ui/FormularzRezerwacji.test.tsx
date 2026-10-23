import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BladApi } from "@/lib/klient/api";
import { mockLink, mockNavigation, router } from "./mocki-next";

vi.mock("next/navigation", () => mockNavigation());
vi.mock("next/link", () => mockLink());

const utworzRezerwacje = vi.fn();
vi.mock("@/lib/klient/api", async (oryginal) => ({
  ...(await oryginal<typeof import("@/lib/klient/api")>()),
  utworzRezerwacje: (...argumenty: unknown[]) => utworzRezerwacje(...argumenty),
}));

const { FormularzRezerwacji } = await import("@/components/rezerwacja/FormularzRezerwacji");

beforeEach(() => {
  utworzRezerwacje.mockReset();
  router.push.mockReset();
});

async function wypelnij(imie = "Jan", email = "jan@example.com") {
  const uzytkownik = userEvent.setup();
  const widok = render(<FormularzRezerwacji eventId="metropolis" seatId="F7" />);
  await uzytkownik.type(screen.getByLabelText("Imię"), imie);
  await uzytkownik.type(screen.getByLabelText("E-mail"), email);
  return Object.assign(uzytkownik, { unmount: widok.unmount });
}

describe("FormularzRezerwacji: walidacja inline", () => {
  it("pokazuje błąd po opuszczeniu pola i wiąże go z polem", async () => {
    const uzytkownik = userEvent.setup();
    render(<FormularzRezerwacji eventId="metropolis" seatId="F7" />);
    const email = screen.getByLabelText("E-mail");
    await uzytkownik.type(email, "to-nie-email");
    expect(screen.queryByText(/Podaj poprawny adres e-mail/)).not.toBeInTheDocument();
    await uzytkownik.tab();
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(email).toHaveAccessibleDescription(expect.stringContaining("Podaj poprawny adres e-mail"));
    await uzytkownik.clear(email);
    await uzytkownik.type(email, "jan@example.com");
    expect(email).not.toHaveAttribute("aria-invalid");
  });

  it("przy wysłaniu z błędami nie wysyła żądania i ustawia fokus na pierwszym złym polu", async () => {
    const uzytkownik = userEvent.setup();
    render(<FormularzRezerwacji eventId="metropolis" seatId="F7" />);
    await uzytkownik.click(screen.getByRole("button", { name: "Zarezerwuj fotel" }));
    expect(utworzRezerwacje).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Imię")).toHaveFocus();
    expect(screen.getByLabelText("Imię")).toHaveAttribute("aria-invalid", "true");
  });
});

describe("FormularzRezerwacji: wysyłanie", () => {
  it("podwójne kliknięcie = jedno żądanie; przycisk zablokowany ze spinnerem", async () => {
    let rozwiaz!: (v: unknown) => void;
    utworzRezerwacje.mockReturnValue(new Promise((r) => (rozwiaz = r)));
    await wypelnij();
    const przycisk = screen.getByRole("button", { name: /Zarezerwuj fotel/ });
    fireEvent.click(przycisk);
    fireEvent.click(przycisk);
    fireEvent.submit(przycisk.closest("form")!);
    expect(utworzRezerwacje).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /Rezerwuję/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Rezerwuję/ })).toHaveAttribute("aria-busy", "true");

    rozwiaz({ dane: { reservationId: "r-1", expiresAt: Date.now() + 120_000 }, status: 201, przesuniecieZegara: 0 });
    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith("/rezerwacja/r-1?seans=metropolis&miejsce=F7"),
    );
  });

  it("wysyła znormalizowane dane i klucz idempotencji", async () => {
    utworzRezerwacje.mockResolvedValue({ dane: { reservationId: "r", expiresAt: 1 }, status: 201, przesuniecieZegara: 0 });
    const u = await wypelnij("  Jan  ", " JAN@Example.com ");
    await u.click(screen.getByRole("button", { name: "Zarezerwuj fotel" }));
    expect(utworzRezerwacje).toHaveBeenCalledWith(
      { eventId: "metropolis", seatId: "F7", name: "Jan", email: "jan@example.com" },
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      expect.anything(),
    );
  });

  it("409: komunikat i przycisk powrotu do mapy", async () => {
    utworzRezerwacje.mockRejectedValue(new BladApi(409, "seat_taken", "Ten fotel został właśnie zajęty."));
    const u = await wypelnij();
    await u.click(screen.getByRole("button", { name: "Zarezerwuj fotel" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Ten fotel został właśnie zajęty");
    expect(screen.getByRole("link", { name: "Wróć do mapy" })).toHaveAttribute("href", "/seans/metropolis?zajete=F7");
  });

  it("429: informacja o limicie i czasie odczekania", async () => {
    utworzRezerwacje.mockRejectedValue(new BladApi(429, "rate_limited", "Za dużo prób", 60));
    const u = await wypelnij();
    await u.click(screen.getByRole("button", { name: "Zarezerwuj fotel" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Odczekaj 60 s");
  });

  it("503: komunikat o przeciążeniu i ponowienie z tym samym kluczem idempotencji", async () => {
    utworzRezerwacje.mockRejectedValueOnce(new BladApi(503, "overloaded", "System jest przeciążony, spróbuj za chwilę."));
    utworzRezerwacje.mockResolvedValueOnce({ dane: { reservationId: "r-2", expiresAt: 1 }, status: 201, przesuniecieZegara: 0 });
    const u = await wypelnij();
    await u.click(screen.getByRole("button", { name: "Zarezerwuj fotel" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("System jest przeciążony, spróbuj za chwilę");
    await u.click(screen.getByRole("button", { name: "Spróbuj ponownie" }));
    await waitFor(() => expect(utworzRezerwacje).toHaveBeenCalledTimes(2));
    expect(utworzRezerwacje.mock.calls[1]![1]).toBe(utworzRezerwacje.mock.calls[0]![1]);
  });

  it("timeout/sieć: ponowienie po odświeżeniu strony używa tego samego klucza", async () => {
    utworzRezerwacje.mockRejectedValue(new BladApi(0, "timeout", "Serwer nie odpowiedział na czas."));
    const u = await wypelnij();
    await u.click(screen.getByRole("button", { name: "Zarezerwuj fotel" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Serwer nie odpowiedział na czas");
    const pierwszyKlucz = utworzRezerwacje.mock.calls[0]![1];

    // Nowy montaż (jak po odświeżeniu strony) z tym samym sessionStorage.
    u.unmount();
    const u2 = await wypelnij();
    await u2.click(screen.getByRole("button", { name: "Zarezerwuj fotel" }));
    await waitFor(() => expect(utworzRezerwacje).toHaveBeenCalledTimes(2));
    expect(utworzRezerwacje.mock.calls[1]![1]).toBe(pierwszyKlucz);
  });

  it("400 z serwera: błędy pól pokazane przy polach", async () => {
    utworzRezerwacje.mockRejectedValue(
      new BladApi(400, "invalid_input", "Niepoprawne dane żądania.", undefined, { email: "Adres odrzucony przez serwer." }),
    );
    const u = await wypelnij();
    await u.click(screen.getByRole("button", { name: "Zarezerwuj fotel" }));
    expect(await screen.findByText("Adres odrzucony przez serwer.")).toBeInTheDocument();
    expect(screen.getByLabelText("E-mail")).toHaveAttribute("aria-invalid", "true");
  });
});
