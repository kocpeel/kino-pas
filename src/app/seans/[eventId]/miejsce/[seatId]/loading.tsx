import { Karta } from "@/components/ui/Karta";
import { Szkielet } from "@/components/ui/Szkielet";

export default function LadowanieFormularza() {
  return (
    <div aria-busy="true">
      <span className="sr-only">Ładowanie formularza…</span>
      <Szkielet wysokosc="2.25rem" className="kroki" />
      <Karta waska>
        <Szkielet szerokosc="60%" wysokosc="1.75rem" />
        <div style={{ height: "var(--odstep-2)" }} />
        <Szkielet szerokosc="85%" />
        <div style={{ height: "var(--odstep-5)" }} />
        <Szkielet szerokosc="4rem" />
        <div style={{ height: "var(--odstep-1)" }} />
        <Szkielet wysokosc="46px" />
        <div style={{ height: "var(--odstep-4)" }} />
        <Szkielet szerokosc="4rem" />
        <div style={{ height: "var(--odstep-1)" }} />
        <Szkielet wysokosc="46px" />
        <div style={{ height: "var(--odstep-5)" }} />
        <Szkielet wysokosc="44px" />
      </Karta>
    </div>
  );
}
