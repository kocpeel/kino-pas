// Jedyne miejsce, które zna API Voucherify (jak platnosci/stripe.ts dla Stripe'a). Reszta kodu widzi interfejs
// `BramkaPunktow`, więc testy podmieniają go bez sieci.
//
// Voucherify nie ma kluczy idempotencji. Każda zmiana salda niesie więc nasz `source_id` (z ID rezerwacji),
// a zanim powtórzymy operację, której wynik jest niepewny (timeout, 5xx), sprawdzamy historię karty
// (`zmianyWHistorii`). Tak samo jak klucz idempotencji w E07, tylko po naszej stronie.
//
// Sprawdzone na sandboksie (17.11.2026), a niepisane w dokumentacji:
// - odjęcie większe niż saldo NIE jest odmową: Voucherify zdejmuje tyle, ile jest, i mówi to w `points`
//   odpowiedzi (np. −300 przy prośbie o −500); przy saldzie 0 zwraca `points: 0` i nie zapisuje operacji;
// - drugi zapis tego samego klienta do programu zwraca jego istniejącą kartę, a nie błąd;
// - operacja jest w historii karty od razu po odpowiedzi.

import { Wylacznik, WylacznikOtwarty } from "../resilience/wylacznik";

const TIMEOUT_MS = 5000;
const DOMYSLNY_ADRES = "https://api.voucherify.io";
/** Ile ostatnich operacji karty przeglądamy, szukając naszej. Klient ma ich kilka na zakup. */
const OPERACJI_DO_PRZEJRZENIA = 100;

export interface KartaPunktow {
  /** Kod karty lojalnościowej: identyfikator członka programu w API. */
  memberId: string;
  /** `loyalty_card.balance`: punkty do wydania (`points` to suma wszystkich dopisanych w historii karty). */
  saldo: number;
}

/** Wynik zmiany salda: saldo po niej i to, o ile saldo naprawdę się zmieniło (odjęcie bywa obcięte do salda). */
export interface ZmianaSalda {
  saldo: number;
  zmiana: number;
}

export interface OpisOperacji {
  /** Nasz identyfikator operacji, np. `wydanie:<reservationId>`. Po nim rozpoznajemy ją w historii karty. */
  sourceId: string;
  powod: string;
}

/**
 * Odmowa albo awaria programu punktowego.
 * - `trwaly`: Voucherify odmówił (np. zła karta), ponawianie nic nie da.
 * - `przejsciowy`: awaria, limit wywołań albo nasz budżet; można ponowić, najlepiej po `ponowZaS`.
 * `niepewny` znaczy, że operacja mogła się wykonać (odpowiedź nie dotarła), więc przed powtórką trzeba sprawdzić historię.
 */
export class BladPunktow extends Error {
  readonly niepewny: boolean;
  readonly ponowZaS: number | undefined;
  readonly klucz: string | undefined;
  readonly status: number | undefined;

  constructor(
    komunikat: string,
    readonly rodzaj: "trwaly" | "przejsciowy",
    opcje: { niepewny?: boolean; ponowZaS?: number; klucz?: string; status?: number } = {},
  ) {
    super(komunikat);
    this.name = "BladPunktow";
    this.niepewny = opcje.niepewny ?? false;
    this.ponowZaS = opcje.ponowZaS;
    this.klucz = opcje.klucz;
    this.status = opcje.status;
  }
}

export interface BramkaPunktow {
  /** Karta klienta w kampanii lojalnościowej albo null, gdy klient jej jeszcze nie ma. */
  znajdzKarte(email: string): Promise<KartaPunktow | null>;
  /** Zapisuje klienta (identyfikator: e-mail) do programu i zwraca jego nową kartę. */
  zalozKarte(email: string): Promise<KartaPunktow>;
  saldo(memberId: string): Promise<number>;
  /**
   * Dodatnie `punkty` dodają, ujemne odejmują. Odjęcie większe niż saldo zdejmuje tylko to, co jest:
   * `zmiana` mówi, ile naprawdę.
   */
  zmienSaldo(memberId: string, punkty: number, opis: OpisOperacji): Promise<ZmianaSalda>;
  /**
   * Operacje z podanymi `sourceId` wśród ostatnich na karcie: suma zmian salda dla każdego znalezionego
   * (uzgodnienie przed ponowieniem niepewnej operacji). Brak klucza = takiej operacji nie było.
   */
  zmianyWHistorii(memberId: string, sourceIds: readonly string[]): Promise<Map<string, number>>;
}

interface KonfiguracjaVoucherify {
  appId: string;
  sekret: string;
  adres: string;
  kampania: string;
}

/** Za ile sekund wolno znów pytać po 429: z `Retry-After` albo `X-Rate-Limit-Retry` (epoch s). */
function ponowZaPoLimicie(odp: Response): number {
  const retryAfter = Number(odp.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.ceil(retryAfter);
  const doKiedy = Number(odp.headers.get("x-rate-limit-retry"));
  if (Number.isFinite(doKiedy) && doKiedy > 0) return Math.max(1, Math.ceil(doKiedy - Date.now() / 1000));
  return 60;
}

function opis(blad: unknown): string {
  return blad instanceof Error ? `${blad.name}: ${blad.message}` : String(blad);
}

interface KartaZApi {
  code?: string;
  loyalty_card?: { balance?: number; points?: number };
}

function kartaZOdpowiedzi(dane: KartaZApi): KartaPunktow {
  if (!dane.code) throw new BladPunktow("Voucherify nie zwrócił kodu karty.", "trwaly");
  return { memberId: dane.code, saldo: dane.loyalty_card?.balance ?? 0 };
}

class BramkaVoucherify implements BramkaPunktow {
  private readonly wylacznik = new Wylacznik();

  constructor(private readonly k: KonfiguracjaVoucherify) {}

  private async zadanie<T>(metoda: "GET" | "POST", sciezka: string, cialo?: unknown): Promise<T> {
    try {
      return await this.wylacznik.wykonaj(
        () => this.wyslij<T>(metoda, sciezka, cialo),
        (blad) => blad instanceof BladPunktow && blad.rodzaj === "przejsciowy",
      );
    } catch (blad) {
      if (blad instanceof WylacznikOtwarty) {
        throw new BladPunktow(`Voucherify: ${blad.message}`, "przejsciowy", { ponowZaS: blad.ponowZaS });
      }
      throw blad;
    }
  }

  private async wyslij<T>(metoda: "GET" | "POST", sciezka: string, cialo?: unknown): Promise<T> {
    // Zapis, który nie dostał odpowiedzi, mógł się wykonać. Odczyt nic nie zmienia.
    const niepewny = metoda === "POST";
    let odp: Response;
    try {
      odp = await fetch(`${this.k.adres}${sciezka}`, {
        method: metoda,
        headers: {
          "X-App-Id": this.k.appId,
          "X-App-Token": this.k.sekret,
          "Content-Type": "application/json",
          "User-Agent": "kasa-kino",
        },
        ...(cialo !== undefined ? { body: JSON.stringify(cialo) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (blad) {
      throw new BladPunktow(`Voucherify nie odpowiada: ${opis(blad)}`, "przejsciowy", { niepewny });
    }
    if (odp.ok) return (await odp.json()) as T;

    const tresc = (await odp.json().catch(() => ({}))) as { key?: string; message?: string; details?: string };
    const szczegoly = `${odp.status} ${tresc.key ?? ""}: ${tresc.message ?? ""}${tresc.details ? ` (${tresc.details})` : ""}`;
    if (odp.status === 429) {
      throw new BladPunktow(`Voucherify: limit wywołań ${szczegoly}`, "przejsciowy", { ponowZaS: ponowZaPoLimicie(odp), status: 429 });
    }
    if (odp.status >= 500) throw new BladPunktow(`Voucherify ${szczegoly}`, "przejsciowy", { niepewny, status: odp.status });
    throw new BladPunktow(`Voucherify ${szczegoly}`, "trwaly", { status: odp.status, ...(tresc.key ? { klucz: tresc.key } : {}) });
  }

  async znajdzKarte(email: string): Promise<KartaPunktow | null> {
    const lista = await this.zadanie<{ vouchers?: KartaZApi[]; data?: KartaZApi[] }>(
      "GET",
      `/v1/loyalties/${encodeURIComponent(this.k.kampania)}/members?customer=${encodeURIComponent(email)}&limit=1`,
    );
    const karta = (lista.vouchers ?? lista.data ?? [])[0];
    return karta ? kartaZOdpowiedzi(karta) : null;
  }

  async zalozKarte(email: string): Promise<KartaPunktow> {
    // Metadane trafiają do publikacji karty (widać je w panelu: skąd klient dołączył), a nie na kartę, więc
    // pochodzenie karty pamiętamy u siebie (`cardRequestedAt`).
    const karta = await this.zadanie<KartaZApi>("POST", `/v1/loyalties/${encodeURIComponent(this.k.kampania)}/members`, {
      customer: { source_id: email, email },
      metadata: { zrodlo: "kasa-kino" },
    });
    return kartaZOdpowiedzi(karta);
  }

  async saldo(memberId: string): Promise<number> {
    const karta = await this.zadanie<KartaZApi>(
      "GET",
      `/v1/loyalties/${encodeURIComponent(this.k.kampania)}/members/${encodeURIComponent(memberId)}`,
    );
    return kartaZOdpowiedzi(karta).saldo;
  }

  async zmienSaldo(memberId: string, punkty: number, o: OpisOperacji): Promise<ZmianaSalda> {
    const wynik = await this.zadanie<{ balance?: number; points?: number }>(
      "POST",
      `/v1/loyalties/members/${encodeURIComponent(memberId)}/balance`,
      { points: punkty, reason: o.powod, source_id: o.sourceId },
    );
    if (typeof wynik.balance !== "number" || typeof wynik.points !== "number") {
      // Operacja się wykonała, ale nie wiemy, o ile: tak jak przy zgubionej odpowiedzi rozstrzygnie historia karty.
      throw new BladPunktow("Voucherify nie zwrócił zmiany salda.", "przejsciowy", { niepewny: true });
    }
    return { saldo: wynik.balance, zmiana: wynik.points };
  }

  async zmianyWHistorii(memberId: string, sourceIds: readonly string[]): Promise<Map<string, number>> {
    // Od najnowszej (`order=-id`): szukane operacje są świeże, a domyślna kolejność nie jest opisana.
    const lista = await this.zadanie<{ data?: { source_id?: string | null; details?: { balance?: { points?: number } } }[] }>(
      "GET",
      `/v1/loyalties/members/${encodeURIComponent(memberId)}/transactions?limit=${OPERACJI_DO_PRZEJRZENIA}&order=-id`,
    );
    const zmiany = new Map<string, number>();
    for (const t of lista.data ?? []) {
      if (!t.source_id || !sourceIds.includes(t.source_id)) continue;
      zmiany.set(t.source_id, (zmiany.get(t.source_id) ?? 0) + (t.details?.balance?.points ?? 0));
    }
    return zmiany;
  }
}

// Bramka i stan jej bezpiecznika są wspólne dla izolatu (globalThis, jak w platnosci/stripe.ts).
const KLUCZ_BRAMKI = Symbol.for("kasa-kino.bramka-voucherify");

export interface SrodowiskoVoucherify {
  VOUCHERIFY_APP_ID?: string | undefined;
  VOUCHERIFY_SECRET_KEY?: string | undefined;
  /** Adres klastra, np. https://api.voucherify.io (domyślny) albo https://us1.api.voucherify.io. */
  VOUCHERIFY_API_URL?: string | undefined;
  VOUCHERIFY_CAMPAIGN_ID?: string | undefined;
}

/** Bramka z bindingów. Brak któregoś klucza = program punktowy wyłączony (czytelny 503, nie 500). */
export function bramkaVoucherifyZeSrodowiska(env: SrodowiskoVoucherify): BramkaPunktow | undefined {
  const { VOUCHERIFY_APP_ID: appId, VOUCHERIFY_SECRET_KEY: sekret, VOUCHERIFY_CAMPAIGN_ID: kampania } = env;
  if (!appId || !sekret || !kampania) return undefined;
  const adres = (env.VOUCHERIFY_API_URL || DOMYSLNY_ADRES).replace(/\/$/, "");
  const globalny = globalThis as { [KLUCZ_BRAMKI]?: { odcisk: string; bramka: BramkaPunktow } };
  const odcisk = `${appId}|${sekret}|${adres}|${kampania}`;
  const wpis = globalny[KLUCZ_BRAMKI];
  if (wpis?.odcisk === odcisk) return wpis.bramka;
  const bramka = new BramkaVoucherify({ appId, sekret, adres, kampania });
  globalny[KLUCZ_BRAMKI] = { odcisk, bramka };
  return bramka;
}
