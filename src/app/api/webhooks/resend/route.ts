import { zaleznosciZadania } from "@/lib/db/kontekst";
import { obsluzWebhookResend } from "@/lib/http/trasy";

export const dynamic = "force-dynamic";

export function POST(zadanie: Request): Promise<Response> {
  return obsluzWebhookResend(zadanie, zaleznosciZadania);
}
