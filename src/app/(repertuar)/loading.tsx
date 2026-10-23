import { Szkielet } from "@/components/ui/Szkielet";

export default function LadowanieRepertuaru() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Ładowanie…</span>
      <Szkielet wysokosc="2.25rem" className="kroki" />
      <Szkielet szerokosc="12rem" wysokosc="2rem" />
      <div style={{ height: "var(--odstep-6)" }} />
      <ul className="repertuar" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <li key={i}>
            <div className="seans">
              <Szkielet wysokosc="auto" className="seans__plakat" />
              <div className="seans__wnetrze">
                <Szkielet szerokosc="60%" wysokosc="1.5rem" />
                <Szkielet szerokosc="80%" />
                <Szkielet wysokosc="6px" />
                <Szkielet wysokosc="44px" />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
