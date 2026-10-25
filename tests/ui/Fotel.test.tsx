import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Fotel, type PropsFotela } from "@/components/sala/Fotel";

function renderuj(propsy: Partial<PropsFotela> = {}) {
  const onWybierz = vi.fn();
  render(
    <Fotel
      seatId="F7"
      rzad="F"
      numer={7}
      zajety={false}
      wybrany={false}
      swiezoZajety={false}
      wKolejnosciTab
      onWybierz={onWybierz}
      onFokus={() => {}}
      zarejestruj={() => {}}
      {...propsy}
    />,
  );
  return { onWybierz, przycisk: screen.getByRole("button") };
}

describe("Fotel", () => {
  it("wolny: kliknięcie wybiera fotel", () => {
    const { onWybierz, przycisk } = renderuj();
    fireEvent.click(przycisk);
    expect(onWybierz).toHaveBeenCalledWith("F7");
  });

  it("zajęty: nieklikalny, ale osiągalny i ogłaszany jako zajęty", () => {
    const { onWybierz, przycisk } = renderuj({ zajety: true });
    fireEvent.click(przycisk);
    expect(onWybierz).not.toHaveBeenCalled();
    expect(przycisk).toHaveAttribute("aria-disabled", "true");
    expect(przycisk).not.toBeDisabled();
    expect(przycisk).toHaveClass("fotel--zajety");
  });

  it.each([
    [{}, "Rząd F, miejsce 7, wolne"],
    [{ zajety: true }, "Rząd F, miejsce 7, zajęte"],
    [{ wybrany: true }, "Rząd F, miejsce 7, wybrane"],
  ])("etykieta dostępności zawiera rząd, numer i stan (%j)", (propsy, etykieta) => {
    const { przycisk } = renderuj(propsy);
    expect(przycisk).toHaveAccessibleName(etykieta);
  });

  it("roving tabindex: tylko aktywny fotel jest w kolejności Tab", () => {
    const { przycisk } = renderuj({ wKolejnosciTab: false });
    expect(przycisk).toHaveAttribute("tabindex", "-1");
  });
});
