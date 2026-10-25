import { zaleznosciZadania } from "@/lib/db/kontekst";
import { obsluzZdrowie } from "@/lib/http/trasy";

export const dynamic = "force-dynamic";

export function GET(): Promise<Response> {
  return obsluzZdrowie(zaleznosciZadania);
}
