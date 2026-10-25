import { Karta } from "@/components/ui/Karta";
import { Szkielet } from "@/components/ui/Szkielet";

export default function LadowanieRezerwacji() {
  return (
    <div aria-busy="true">
      <span className="sr-only">Ładowanie rezerwacji…</span>
      <Szkielet wysokosc="2.25rem" className="kroki" />
      <Karta waska>
        <Szkielet szerokosc="75%" wysokosc="2.75rem" />
        <Szkielet wysokosc="6px" className="licznik__pasek" />
        <div style={{ height: "var(--odstep-5)" }} />
        <Szkielet szerokosc="60%" />
        <div style={{ height: "var(--odstep-2)" }} />
        <Szkielet szerokosc="50%" />
        <div style={{ height: "var(--odstep-2)" }} />
        <Szkielet szerokosc="55%" />
        <div style={{ height: "var(--odstep-5)" }} />
        <Szkielet wysokosc="44px" />
      </Karta>
    </div>
  );
}
