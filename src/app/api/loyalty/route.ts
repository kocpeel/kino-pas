import { zaleznosciZadania } from "@/lib/db/kontekst";
import { obsluzSaldo } from "@/lib/http/trasy";

export const dynamic = "force-dynamic";

export function GET(zadanie: Request): Promise<Response> {
  return obsluzSaldo(zadanie, zaleznosciZadania);
}
