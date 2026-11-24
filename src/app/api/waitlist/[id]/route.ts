import { zaleznosciZadania } from "@/lib/db/kontekst";
import { obsluzStanZapisu, obsluzWypisanie } from "@/lib/http/trasy";

export const dynamic = "force-dynamic";

/** Etap IV: stan zapisu na liście oczekujących i miejsce w kolejce. */
export async function GET(zadanie: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return obsluzStanZapisu(zadanie, zaleznosciZadania, id);
}

/** Etap IV: wypisanie z listy oczekujących. */
export async function DELETE(zadanie: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return obsluzWypisanie(zadanie, zaleznosciZadania, id);
}
