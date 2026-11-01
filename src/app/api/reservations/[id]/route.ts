import { zaleznosciZadania } from "@/lib/db/kontekst";
import { obsluzOdczytRezerwacji } from "@/lib/http/trasy";

export const dynamic = "force-dynamic";

export async function GET(zadanie: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return obsluzOdczytRezerwacji(zadanie, zaleznosciZadania, id);
}
