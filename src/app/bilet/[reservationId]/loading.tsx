import { Szkielet } from "@/components/ui/Szkielet";

export default function LadowanieBiletu() {
  return (
    <div aria-busy="true">
      <span className="sr-only">Ładowanie biletu…</span>
      <Szkielet wysokosc="2.25rem" className="kroki" />
      <div className="bilet" aria-hidden="true">
        <Szkielet wysokosc="320px" />
      </div>
    </div>
  );
}
