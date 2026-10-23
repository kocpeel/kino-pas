import { zaleznosciZadania } from "@/lib/db/kontekst";
import { obsluzSzczegolySeansu } from "@/lib/http/trasy";

export const dynamic = "force-dynamic";

export async function GET(_zadanie: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return obsluzSzczegolySeansu(zaleznosciZadania, id);
}
