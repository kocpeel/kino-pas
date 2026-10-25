import { zaleznosciZadania } from "@/lib/db/kontekst";
import { obsluzZakup } from "@/lib/http/trasy";

export const dynamic = "force-dynamic";

export async function POST(zadanie: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return obsluzZakup(zadanie, zaleznosciZadania, id);
}
