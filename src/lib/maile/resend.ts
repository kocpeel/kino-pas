// Jedyne miejsce, które zna API Resend. Reszta kodu widzi interfejs `BramkaMaili`.
//
// - Idempotency-Key (Resend pamięta go 24 h): ponowienie joba nie wyśle drugiego maila.
// - Bez własnej domeny Resend wysyła z onboarding@resend.dev tylko do właściciela konta i na adresy testowe
//   (delivered@resend.dev, bounced@resend.dev, z etykietą po „+”). Inny adres to trwała odmowa 403.
// - Resend odrzuca żądania bez nagłówka User-Agent, a fetch w Workerze go nie dodaje.

import { Wylacznik, WylacznikOtwarty } from "../resilience/wylacznik";

const TIMEOUT_MS = 6000;
const DOMYSLNY_ADRES = "https://api.resend.com";
const DOMYSLNY_NADAWCA = "Kino Pas <onboarding@resend.dev>";

export interface Mail {
  do: string;
  temat: string;
  html: string;
  tekst: string;
  /** Tagi Resend (litery, cyfry, _ i -), np. do znalezienia maila w panelu. */
  tagi?: { name: string; value: string }[];
}

/**
 * - `trwaly`: Resend odmówił (np. adres spoza dozwolonych bez własnej domeny), ponawianie nic nie da.
 * - `przejsciowy`: limit, awaria albo trwające żądanie z tym samym kluczem; ponowić po `ponowZaS`.
 */
export class BladMaila extends Error {
  constructor(
    komunikat: string,
    readonly rodzaj: "trwaly" | "przejsciowy",
    readonly ponowZaS?: number,
    readonly nazwa?: string,
  ) {
    super(komunikat);
    this.name = "BladMaila";
  }
}

export interface BramkaMaili {
  wyslij(mail: Mail, kluczIdempotencji: string): Promise<{ id: string }>;
}

/** Do północy UTC: wtedy Resend odnawia dzienny limit darmowego planu. */
function doPolnocyUtcS(teraz = Date.now()): number {
  const polnoc = new Date(teraz);
  polnoc.setUTCHours(24, 0, 0, 0);
  return Math.max(60, Math.ceil((polnoc.getTime() - teraz) / 1000));
}

/** Klasyfikacja odpowiedzi błędu Resend (nazwy z dokumentacji API). */
export function bladZOdpowiedzi(status: number, nazwa: string | undefined, komunikat: string, retryAfter: string | null): BladMaila {
  const opis = `Resend ${status} ${nazwa ?? ""}: ${komunikat}`;
  if (status === 429) {
    if (nazwa === "daily_quota_exceeded") return new BladMaila(opis, "przejsciowy", doPolnocyUtcS(), nazwa);
    if (nazwa === "monthly_quota_exceeded") return new BladMaila(opis, "przejsciowy", 3600, nazwa);
    const s = Number(retryAfter);
    return new BladMaila(opis, "przejsciowy", Number.isFinite(s) && s > 0 ? Math.ceil(s) : 2, nazwa);
  }
  if (status === 409 && (nazwa === "concurrent_idempotent_requests" || nazwa === "resource_locked")) {
    return new BladMaila(opis, "przejsciowy", 2, nazwa);
  }
  if (status >= 500) return new BladMaila(opis, "przejsciowy", undefined, nazwa);
  return new BladMaila(opis, "trwaly", undefined, nazwa);
}

class BramkaResend implements BramkaMaili {
  private readonly wylacznik = new Wylacznik();

  constructor(private readonly k: { klucz: string; nadawca: string; adres: string }) {}

  async wyslij(mail: Mail, kluczIdempotencji: string): Promise<{ id: string }> {
    try {
      return await this.wylacznik.wykonaj(
        () => this.wyslijRaz(mail, kluczIdempotencji),
        (blad) => blad instanceof BladMaila && blad.rodzaj === "przejsciowy" && blad.nazwa !== "daily_quota_exceeded",
      );
    } catch (blad) {
      if (blad instanceof WylacznikOtwarty) throw new BladMaila(`Resend: ${blad.message}`, "przejsciowy", blad.ponowZaS);
      throw blad;
    }
  }

  private async wyslijRaz(mail: Mail, kluczIdempotencji: string): Promise<{ id: string }> {
    let odp: Response;
    try {
      odp = await fetch(`${this.k.adres}/emails`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.k.klucz}`,
          "Content-Type": "application/json",
          "Idempotency-Key": kluczIdempotencji,
          "User-Agent": "kasa-kino",
        },
        body: JSON.stringify({
          from: this.k.nadawca,
          to: [mail.do],
          subject: mail.temat,
          html: mail.html,
          text: mail.tekst,
          ...(mail.tagi ? { tags: mail.tagi } : {}),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (blad) {
      throw new BladMaila(`Resend nie odpowiada: ${blad instanceof Error ? blad.message : String(blad)}`, "przejsciowy");
    }
    const tresc = (await odp.json().catch(() => ({}))) as { id?: string; name?: string; message?: string };
    if (odp.ok && tresc.id) return { id: tresc.id };
    if (odp.ok) throw new BladMaila("Resend nie zwrócił identyfikatora maila.", "przejsciowy");
    throw bladZOdpowiedzi(odp.status, tresc.name, tresc.message ?? "", odp.headers.get("retry-after"));
  }
}

const KLUCZ_BRAMKI = Symbol.for("kasa-kino.bramka-resend");

export interface SrodowiskoResend {
  RESEND_API_KEY?: string | undefined;
  /** Nadawca; bez własnej domeny tylko onboarding@resend.dev. */
  RESEND_FROM?: string | undefined;
  /** Tylko testy e2e: adres sztucznego Resend. */
  RESEND_API_BASE?: string | undefined;
}

/** Bramka z bindingów. Brak klucza = maile wyłączone: bilet i tak jest na stronie, job poczeka. */
export function bramkaResendZeSrodowiska(env: SrodowiskoResend): BramkaMaili | undefined {
  const klucz = env.RESEND_API_KEY;
  if (!klucz) return undefined;
  const nadawca = env.RESEND_FROM || DOMYSLNY_NADAWCA;
  const adres = (env.RESEND_API_BASE || DOMYSLNY_ADRES).replace(/\/$/, "");
  const globalny = globalThis as { [KLUCZ_BRAMKI]?: { odcisk: string; bramka: BramkaMaili } };
  const odcisk = `${klucz}|${nadawca}|${adres}`;
  const wpis = globalny[KLUCZ_BRAMKI];
  if (wpis?.odcisk === odcisk) return wpis.bramka;
  const bramka = new BramkaResend({ klucz, nadawca, adres });
  globalny[KLUCZ_BRAMKI] = { odcisk, bramka };
  return bramka;
}

// ——— Webhook Resend (Svix): podpis ———

/** Zdarzenie o losie maila. Używamy tylko typu i identyfikatora maila. */
export interface ZdarzenieMaila {
  type: string;
  created_at?: string;
  data: { email_id?: string };
}

function base64NaBajty(tekst: string): Uint8Array<ArrayBuffer> {
  const surowe = atob(tekst);
  const bajty = new Uint8Array(surowe.length);
  for (let i = 0; i < surowe.length; i++) bajty[i] = surowe.charCodeAt(i);
  return bajty;
}

function bajtyNaBase64(bajty: ArrayBuffer): string {
  let tekst = "";
  for (const b of new Uint8Array(bajty)) tekst += String.fromCharCode(b);
  return btoa(tekst);
}

function rowneStalyCzas(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let roznica = 0;
  for (let i = 0; i < a.length; i++) roznica |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return roznica === 0;
}

export const TOLERANCJA_PODPISU_S = 5 * 60;

/**
 * Podpis Svix (używa go Resend): HMAC-SHA256 z `${svix-id}.${svix-timestamp}.${surowe ciało}`, kluczem jest
 * sekret bez prefiksu `whsec_`, zdekodowany z base64. Nagłówek może mieć kilka podpisów „v1,…” po spacji.
 * Zwraca false przy złym podpisie albo za starym znaczniku czasu (powtórka nagranego żądania).
 */
export async function czyPodpisResendPoprawny(
  cialo: string,
  naglowki: { id: string | null; timestamp: string | null; podpis: string | null },
  sekret: string,
  terazMs: number,
): Promise<boolean> {
  const { id, timestamp, podpis } = naglowki;
  if (!id || !timestamp || !podpis) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(terazMs / 1000 - ts) > TOLERANCJA_PODPISU_S) return false;
  let klucz: CryptoKey;
  try {
    klucz = await crypto.subtle.importKey(
      "raw",
      base64NaBajty(sekret.replace(/^whsec_/, "")),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    return false;
  }
  const oczekiwany = bajtyNaBase64(await crypto.subtle.sign("HMAC", klucz, new TextEncoder().encode(`${id}.${timestamp}.${cialo}`)));
  return podpis
    .split(" ")
    .map((czesc) => czesc.split(","))
    .some(([wersja, wartosc]) => wersja === "v1" && wartosc !== undefined && rowneStalyCzas(wartosc, oczekiwany));
}
