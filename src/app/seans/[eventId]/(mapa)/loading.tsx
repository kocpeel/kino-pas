import { Karta } from "@/components/ui/Karta";
import { Szkielet } from "@/components/ui/Szkielet";

// Szkielet o wymiarach docelowej mapy: 8 rzędów × 10 foteli.
export default function LadowanieSali() {
  const rzedy = Array.from({ length: 8 });
  const fotele = Array.from({ length: 10 });
  return (
    <div aria-busy="true">
      <span className="sr-only">Ładowanie mapy sali…</span>
      <Szkielet wysokosc="2.25rem" className="kroki" />
      <Szkielet szerokosc="14rem" wysokosc="2rem" />
      <div style={{ height: "var(--odstep-2)" }} />
      <Szkielet szerokosc="10rem" />
      <div style={{ height: "var(--odstep-5)" }} />
      <Karta className="karta--sala">
        <div className="sala" style={{ ["--kolumny" as string]: 10 }} aria-hidden="true">
          <div className="sala__ekran">Ekran</div>
          <div className="sala__siatka">
            {rzedy.map((_, r) => (
              <div className="sala__wiersz" key={r}>
                <span />
                {fotele.map((__, f) => (
                  <Szkielet key={f} wysokosc="auto" className="fotel" />
                ))}
                <span />
              </div>
            ))}
          </div>
        </div>
      </Karta>
    </div>
  );
}
