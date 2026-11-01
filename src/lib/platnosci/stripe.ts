// Jedyne miejsce, które zna Stripe'a (jak `db/polaczenie.ts` dla D1). Reszta kodu widzi interfejs
// `BramkaPlatnosci`, więc testy podmieniają go bez sieci.
// Tylko klucze testowe: etap II nie pobiera prawdziwych pieniędzy, a klucz `sk_live_` wyłącza płatności.

import Stripe from "stripe";
import { BladBramki, type BramkaPlatnosci, type ParametrySesji, type StanSesji, type ZdarzeniePlatnosci } from "../domain/platnosc";
import { BladDomenowy } from "../domain/bledy";
import { Wylacznik, WylacznikOtwarty } from "../resilience/wylacznik";

const TIMEOUT_MS = 6000;
const PROBY_SIECIOWE = 2;
/** Dwa równoległe żądania z tym samym kluczem: drugie dostaje 409, dopóki pierwsze trwa. */
const PROBY_PRZY_KLUCZU_W_UZYCIU = 5;
const CZEKANIE_NA_KLUCZ_MS = 400;

/** Metody z panelu Stripe, które nie są kartą. API nie pozwala już podać listy dozwolonych, tylko wykluczone. */
const WYKLUCZONE_METODY: Stripe.Checkout.SessionCreateParams.ExcludedPaymentMethodType[] = ["blik", "klarna", "p24"];

export function czyKluczTestowy(klucz: string): boolean {
  return klucz.startsWith("sk_test_") || klucz.startsWith("rk_test_");
}

function czyBladStripe(blad: unknown): blad is Stripe.errors.StripeError {
  return blad instanceof Stripe.errors.StripeError;
}

/** Awaria po stronie Stripe'a albo sieci. Błąd w naszych parametrach bezpiecznika nie otwiera. */
function czyAwaria(blad: unknown): boolean {
  if (!czyBladStripe(blad)) return true;
  return (
    blad instanceof Stripe.errors.StripeConnectionError ||
    blad instanceof Stripe.errors.StripeRateLimitError ||
    (blad.statusCode ?? 500) >= 500
  );
}

/** Do logów idzie tylko typ, kod i komunikat Stripe'a: bez danych żądania i bez klucza. */
function opisBledu(blad: unknown): string {
  if (czyBladStripe(blad)) return `${blad.type}${blad.code ? ` (${blad.code})` : ""}: ${blad.message}`;
  return blad instanceof Error ? `${blad.name}: ${blad.message}` : String(blad);
}

function czyKluczWUzyciu(blad: unknown): boolean {
  return czyBladStripe(blad) && (blad.code === "idempotency_key_in_use" || blad.statusCode === 409);
}

class BramkaStripe implements BramkaPlatnosci {
  private readonly wylacznik = new Wylacznik();

  constructor(private readonly stripe: Stripe) {}

  private async wywolaj<T>(praca: () => Promise<T>): Promise<T> {
    try {
      return await this.wylacznik.wykonaj(praca, czyAwaria);
    } catch (blad) {
      if (blad instanceof BladBramki) throw blad;
      if (blad instanceof WylacznikOtwarty) throw new BladBramki(blad.message, blad.ponowZaS);
      throw new BladBramki(opisBledu(blad));
    }
  }

  utworzSesje(p: ParametrySesji, kluczIdempotencji: string) {
    return this.wywolaj(async () => {
      for (let proba = 1; ; proba++) {
        try {
          const sesja = await this.stripe.checkout.sessions.create(
            {
              mode: "payment",
              client_reference_id: p.reservationId,
              excluded_payment_method_types: WYKLUCZONE_METODY,
              locale: "pl",
              submit_type: "pay",
              custom_text: { submit: { message: p.uwaga } },
              expires_at: p.wygasaO,
              success_url: p.adresSukcesu,
              cancel_url: p.adresPrzerwania,
              line_items: [
                {
                  quantity: 1,
                  price_data: {
                    currency: "pln",
                    unit_amount: p.amount,
                    product_data: { name: p.nazwa, description: p.opis },
                  },
                },
              ],
              metadata: { reservationId: p.reservationId },
              payment_intent_data: { metadata: { reservationId: p.reservationId } },
            },
            { idempotencyKey: kluczIdempotencji },
          );
          if (!sesja.url) throw new BladBramki("Stripe nie zwrócił adresu sesji.");
          return { id: sesja.id, url: sesja.url };
        } catch (blad) {
          if (!czyKluczWUzyciu(blad) || proba >= PROBY_PRZY_KLUCZU_W_UZYCIU) throw blad;
          await new Promise((r) => setTimeout(r, CZEKANIE_NA_KLUCZ_MS));
        }
      }
    });
  }

  pobierzSesje(id: string): Promise<StanSesji> {
    return this.wywolaj(async () => {
      const sesja = await this.stripe.checkout.sessions.retrieve(id, { expand: ["payment_intent.latest_charge"] });
      const platnosc = sesja.payment_intent;
      const obciazenie = platnosc && typeof platnosc === "object" ? platnosc.latest_charge : null;
      const status: StanSesji["status"] =
        sesja.status === "complete" ? "complete" : sesja.status === "expired" ? "expired" : "open";
      return {
        status,
        oplacona: sesja.payment_status === "paid",
        paymentIntentId: typeof platnosc === "string" ? platnosc : (platnosc?.id ?? null),
        kwota: sesja.amount_total,
        waluta: sesja.currency,
        oplaconoO: obciazenie && typeof obciazenie === "object" ? obciazenie.created * 1000 : null,
      };
    });
  }

  wygasSesje(id: string): Promise<void> {
    return this.wywolaj(async () => {
      await this.stripe.checkout.sessions.expire(id);
    });
  }

  zwrocPlatnosc(paymentIntentId: string, kluczIdempotencji: string, reservationId: string): Promise<void> {
    return this.wywolaj(async () => {
      try {
        await this.stripe.refunds.create(
          { payment_intent: paymentIntentId, reason: "requested_by_customer", metadata: { reservationId } },
          { idempotencyKey: kluczIdempotencji },
        );
      } catch (blad) {
        // Ktoś już zwrócił (np. ręcznie w panelu): skutek jest taki, jak chcieliśmy.
        if (czyBladStripe(blad) && blad.code === "charge_already_refunded") return;
        throw blad;
      }
    });
  }
}

// Klient i stan bezpiecznika są wspólne dla izolatu. Next.js pakuje trasy osobno, więc trzymamy je
// na globalThis, a nie w zmiennej modułu. Jeden wpis, wymieniany przy zmianie klucza.
const KLUCZ_BRAMKI = Symbol.for("kasa-kino.bramka-stripe");

interface WpisBramki {
  odcisk: string;
  bramka: BramkaPlatnosci;
}

export function bramkaStripe(klucz: string, adresApi?: string): BramkaPlatnosci {
  const globalny = globalThis as { [KLUCZ_BRAMKI]?: WpisBramki };
  const odcisk = `${klucz}|${adresApi ?? ""}`;
  const wpis = globalny[KLUCZ_BRAMKI];
  if (wpis?.odcisk === odcisk) return wpis.bramka;

  const opcje: Stripe.StripeConfig = {
    // Fetch działa i w Workerze, i w `next dev`.
    httpClient: Stripe.createFetchHttpClient(),
    timeout: TIMEOUT_MS,
    maxNetworkRetries: PROBY_SIECIOWE,
  };
  if (adresApi) {
    // Sztuczny Stripe w testach e2e.
    const adres = new URL(adresApi);
    opcje.host = adres.hostname;
    opcje.port = adres.port;
    opcje.protocol = adres.protocol === "http:" ? "http" : "https";
  }
  const bramka = new BramkaStripe(new Stripe(klucz, opcje));
  globalny[KLUCZ_BRAMKI] = { odcisk, bramka };
  return bramka;
}

export interface SrodowiskoStripe {
  STRIPE_SECRET_KEY?: string | undefined;
  STRIPE_API_BASE?: string | undefined;
}

/** Bramka z bindingów. Brak klucza albo klucz produkcyjny = płatności wyłączone (czytelny 503, nie 500). */
export function bramkaZeSrodowiska(env: SrodowiskoStripe): BramkaPlatnosci | undefined {
  const klucz = env.STRIPE_SECRET_KEY;
  if (!klucz) return undefined;
  if (!czyKluczTestowy(klucz)) {
    console.error("STRIPE_SECRET_KEY nie jest kluczem testowym: płatności wyłączone.");
    return undefined;
  }
  return bramkaStripe(klucz, env.STRIPE_API_BASE);
}

/** Sprawdza podpis webhooka na SUROWYM ciele żądania. Zły podpis albo za stary znacznik czasu → 400. */
export async function zweryfikujZdarzenie(cialo: string, podpis: string, sekret: string): Promise<ZdarzeniePlatnosci> {
  try {
    const zdarzenie = await Stripe.webhooks.constructEventAsync(
      cialo,
      podpis,
      sekret,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
    return zdarzenie as unknown as ZdarzeniePlatnosci;
  } catch (blad) {
    throw new BladDomenowy("ZLY_PODPIS", { przyczyna: blad });
  }
}
