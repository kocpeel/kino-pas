import { zaleznosciZadania } from "@/lib/db/kontekst";
import { obsluzRezerwacje } from "@/lib/http/trasy";

export const dynamic = "force-dynamic";

export function POST(zadanie: Request): Promise<Response> {
  return obsluzRezerwacje(zadanie, zaleznosciZadania);
}
