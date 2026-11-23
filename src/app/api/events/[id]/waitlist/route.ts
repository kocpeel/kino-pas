import { zaleznosciZadania } from "@/lib/db/kontekst";
import { obsluzZapisNaListe } from "@/lib/http/trasy";

export const dynamic = "force-dynamic";

/** Etap IV: zapis na listę oczekujących wyprzedanego wydarzenia. */
export async function POST(zadanie: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return obsluzZapisNaListe(zadanie, zaleznosciZadania, id);
}
