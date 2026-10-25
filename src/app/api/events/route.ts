import { zaleznosciZadania } from "@/lib/db/kontekst";
import { obsluzListeSeansow } from "@/lib/http/trasy";

export const dynamic = "force-dynamic";

export function GET(zadanie: Request): Promise<Response> {
  return obsluzListeSeansow(zadanie, zaleznosciZadania);
}
