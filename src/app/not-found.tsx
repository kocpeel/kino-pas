import { connection } from "next/server";
import { LinkPrzycisk } from "@/components/ui/Przycisk";

export default async function NieZnaleziono() {
  // Renderowana na żądanie, nie przy buildzie: tylko wtedy jej skrypty dostają nonce z CSP (worker.ts).
  await connection();
  return (
    <div className="komunikat-strony">
      <h1 className="tytul-strony">Nie znaleziono</h1>
      <p className="podtytul">Nie ma takiego seansu albo fotela. Sprawdź adres albo wybierz seans z repertuaru.</p>
      <LinkPrzycisk href="/">Wróć do repertuaru</LinkPrzycisk>
    </div>
  );
}
