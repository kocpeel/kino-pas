import { zaleznosciZadania } from "@/lib/db/kontekst";
import { obsluzWebhookStripe } from "@/lib/http/trasy";

export const dynamic = "force-dynamic";

export function POST(zadanie: Request): Promise<Response> {
  return obsluzWebhookStripe(zadanie, zaleznosciZadania);
}
