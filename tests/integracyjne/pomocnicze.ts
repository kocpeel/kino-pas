// Wspólne narzędzia testów integracyjnych: świeży seed, zależności z zegarem testowym,
// budowanie żądań i „zepsute" bazy do testów odporności.

import { env } from "cloudflare:test";
import Stripe from "stripe";
import { utworzZegarTestowy, type ZegarTestowy } from "../../src/lib/czas";
import { wczytajKonfiguracje } from "../../src/lib/config";
import { nowyCacheOdczytow } from "../../src/lib/db/polaczenie";
import type { UslugaPunktow } from "../../src/lib/domain/konto-punktowe";
import type { BramkaPlatnosci, ParametrySesji, StanSesji, ZdarzeniePlatnosci } from "../../src/lib/domain/platnosc";
import { BladMaila, type BramkaMaili, type Mail } from "../../src/lib/maile/resend";
import type { BudzetWywolan } from "../../src/lib/punkty/budzet";
import { BladPunktow, type BramkaPunktow, type KartaPunktow, type OpisOperacji } from "../../src/lib/punkty/voucherify";
import type { StanRezerwacji } from "../../src/lib/domain/typy";
import type { Limitery } from "../../src/lib/resilience/limit-zapytan";
import { StraznikPrzeciazenia } from "../../src/lib/resilience/przeciazenie";
import {
  obsluzCheckout,
  obsluzOdczytRezerwacji,
  obsluzRezerwacje,
  obsluzSaldo,
  obsluzWebhookStripe,
  obsluzZakup,
} from "../../src/lib/http/trasy";
import type { Zaleznosci } from "../../src/lib/zaleznosci";
import { SEANSE, zbudujSeed } from "../../seed/generuj-seed";

export const SEANS = SEANSE[0]!.id;
export const INNY_SEANS = SEANSE[1]!.id;
export const TTL_MS = 120_000;
export const CENA = 3200;
export const SEKRET_WEBHOOKA = "whsec_test_integracyjny";

/** Każdy test zaczyna od czystych 3 seansów × 80 foteli. */
export async function zasiej(db: D1Database = env.DB): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM seats"),
    db.prepare("DELETE FROM events"),
    db.prepare("DELETE FROM reservations"),
    db.prepare("DELETE FROM inbox"),
    db.prepare("DELETE FROM outbox"),
    db.prepare("DELETE FROM sagas"),
    db.prepare("DELETE FROM loyalty_accounts"),
  ]);
  await db.batch(zbudujSeed().map((sql) => db.prepare(sql)));
}

export interface OpcjeZaleznosci {
  zegar?: ZegarTestowy;
  db?: D1Database | undefined;
  limitery?: Limitery;
  straznik?: StraznikPrzeciazenia;
  zmienne?: Record<string, string>;
  platnosci?: BramkaPlatnosci | undefined;
  sekretWebhooka?: string | undefined;
  punkty?: UslugaPunktow | undefined;
  sekretWebhookaResend?: string | undefined;
}

export function zaleznosci(opcje: OpcjeZaleznosci = {}): Zaleznosci & { zegar: ZegarTestowy } {
  const zegar = opcje.zegar ?? utworzZegarTestowy();
  return {
    db: "db" in opcje ? opcje.db : env.DB,
    konfiguracja: wczytajKonfiguracje({
      RESERVATION_TTL_SECONDS: String(TTL_MS / 1000),
      MAX_ACTIVE_RESERVATIONS_PER_EMAIL: "4",
      ...opcje.zmienne,
    }),
    zegar,
    limitery: opcje.limitery ?? {},
    // Testy współbieżności sprawdzają bazę, nie load shedding: duże pule.
    straznik: opcje.straznik ?? new StraznikPrzeciazenia({ maxOdczytow: 10_000, maxZapisow: 10_000 }),
    cache: nowyCacheOdczytow(),
    platnosci: "platnosci" in opcje ? opcje.platnosci : sztucznaBramka(zegar.teraz),
    sekretWebhooka: "sekretWebhooka" in opcje ? opcje.sekretWebhooka : SEKRET_WEBHOOKA,
    punkty: opcje.punkty,
    sekretWebhookaResend: opcje.sekretWebhookaResend,
  };
}

// ——— Stripe bez sieci ———

export interface SztucznaBramka extends BramkaPlatnosci {
  wywolaniaUtworz: number;
  /** Sesje po kluczu idempotencji. */
  sesje: Map<string, { id: string; url: string; parametry: ParametrySesji }>;
  zwroty: { paymentIntentId: string; klucz: string; reservationId: string }[];
  wygaszone: string[];
  /** Ustawione = każde wywołanie kończy się tym błędem (Stripe nie odpowiada). */
  awaria: Error | null;
  /** Stan zwracany przez pobierzSesje, domyślnie otwarta i nieopłacona. */
  stanSesji: Partial<StanSesji>;
}

/**
 * Trzyma te same reguły co prawdziwy Stripe, zmierzone na sandboksie: klucz idempotencji daje tę samą sesję,
 * ten sam klucz z innymi parametrami to błąd, a sesja nie może wygasać wcześniej niż za 30 minut.
 */
export function sztucznaBramka(teraz: () => number = Date.now): SztucznaBramka {
  const bramka: SztucznaBramka = {
    wywolaniaUtworz: 0,
    sesje: new Map(),
    zwroty: [],
    wygaszone: [],
    awaria: null,
    stanSesji: {},
    async utworzSesje(parametry, klucz) {
      bramka.wywolaniaUtworz++;
      if (bramka.awaria) throw bramka.awaria;
      const istniejaca = bramka.sesje.get(klucz);
      if (istniejaca) {
        if (JSON.stringify(istniejaca.parametry) !== JSON.stringify(parametry)) {
          throw new Error("Keys for idempotent requests can only be used with the same parameters");
        }
        return { id: istniejaca.id, url: istniejaca.url };
      }
      if (parametry.wygasaO * 1000 < teraz() + 30 * 60_000) {
        throw new Error("The `expires_at` timestamp must be at least 30 minutes from Checkout Session creation.");
      }
      const id = `cs_test_${crypto.randomUUID()}`;
      const sesja = { id, url: `https://checkout.stripe.test/c/pay/${id}`, parametry };
      bramka.sesje.set(klucz, sesja);
      return { id: sesja.id, url: sesja.url };
    },
    async pobierzSesje() {
      if (bramka.awaria) throw bramka.awaria;
      return { status: "open", oplacona: false, paymentIntentId: null, kwota: null, waluta: null, oplaconoO: null, ...bramka.stanSesji };
    },
    async wygasSesje(id) {
      if (bramka.awaria) throw bramka.awaria;
      bramka.wygaszone.push(id);
    },
    async zwrocPlatnosc(paymentIntentId, klucz, reservationId) {
      if (bramka.awaria) throw bramka.awaria;
      bramka.zwroty.push({ paymentIntentId, klucz, reservationId });
    },
  };
  return bramka;
}

export interface OpcjeZdarzenia {
  id?: string;
  type?: string;
  /** Epoch ms przyjęcia płatności. Domyślnie „teraz” zegara z zależności. */
  paidAt?: number;
  amount?: number;
  currency?: string;
  paymentIntent?: string;
  paymentStatus?: string;
}

export function zdarzenieOplacenia(reservationId: string | null, o: OpcjeZdarzenia = {}): ZdarzeniePlatnosci {
  return {
    id: o.id ?? `evt_${crypto.randomUUID()}`,
    type: o.type ?? "checkout.session.completed",
    created: Math.floor((o.paidAt ?? Date.now()) / 1000),
    data: {
      object: {
        client_reference_id: reservationId,
        payment_status: o.paymentStatus ?? "paid",
        payment_intent: o.paymentIntent ?? `pi_${reservationId}`,
        amount_total: o.amount ?? CENA,
        currency: o.currency ?? "pln",
      },
    },
  };
}

/** Prawdziwa funkcja podpisu z SDK, sprawdzana przez prawdziwą weryfikację w handlerze. */
export async function zadanieWebhooka(
  zdarzenie: unknown,
  o: { sekret?: string; timestamp?: number; podpis?: string | null } = {},
): Promise<Request> {
  const payload = JSON.stringify(zdarzenie);
  const podpis =
    o.podpis !== undefined
      ? o.podpis
      : await Stripe.webhooks.generateTestHeaderStringAsync({
          payload,
          secret: o.sekret ?? SEKRET_WEBHOOKA,
          ...(o.timestamp !== undefined ? { timestamp: o.timestamp } : {}),
          cryptoProvider: Stripe.createSubtleCryptoProvider(),
        });
  return new Request("https://kasa.test/api/webhooks/stripe", {
    method: "POST",
    headers: { "content-type": "application/json", ...(podpis ? { "stripe-signature": podpis } : {}) },
    body: payload,
  });
}

export async function wyslijZdarzenie(z: Zaleznosci, zdarzenie: unknown): Promise<Wynik<{ received?: boolean; error?: string }>> {
  return odczytaj(await obsluzWebhookStripe(await zadanieWebhooka(zdarzenie), () => z));
}

/** Płatność, która właśnie przeszła u Stripe'a: webhook z chwilą płatności według zegara zależności. */
export async function zaplac(
  z: Zaleznosci,
  reservationId: string,
  o: OpcjeZdarzenia = {},
): Promise<Wynik<{ received?: boolean; error?: string }>> {
  return wyslijZdarzenie(z, zdarzenieOplacenia(reservationId, { paidAt: z.zegar.teraz(), ...o }));
}

export async function stanRezerwacji(z: Zaleznosci, reservationId: string): Promise<Wynik<StanRezerwacji & { error?: string }>> {
  const zadanie = new Request(`https://kasa.test/api/reservations/${reservationId}`);
  return odczytaj(await obsluzOdczytRezerwacji(zadanie, () => z, reservationId));
}

export async function checkout(
  z: Zaleznosci,
  reservationId: string,
  cialo?: Record<string, unknown>,
): Promise<Wynik<{ url: string; error?: string; message?: string }>> {
  const zadanie = new Request(`https://kasa.test/api/reservations/${reservationId}/checkout`, {
    method: "POST",
    ...(cialo ? { headers: { "content-type": "application/json" }, body: JSON.stringify(cialo) } : {}),
  });
  return odczytaj(await obsluzCheckout(zadanie, () => z, reservationId));
}

export async function saldo(z: Zaleznosci, email: string): Promise<Wynik<{ email: string; points: number; error?: string }>> {
  return odczytaj(await obsluzSaldo(new Request(`https://kasa.test/api/loyalty?email=${encodeURIComponent(email)}`), () => z));
}

// ——— Voucherify bez sieci ———

export interface SztuczneKonto extends BramkaPunktow {
  karty: Map<string, { memberId: string; saldo: number; operacje: { sourceId: string; punkty: number }[] }>;
  /** Wywołania API (do sprawdzania budżetu). */
  wywolania: string[];
  /** Ustawione = każde wywołanie kończy się tym błędem (np. awaria albo limit). */
  awaria: BladPunktow | null;
  /** Następna zmiana salda wykona się, ale odpowiedź „zaginie” (timeout po stronie klienta). */
  zgubOdpowiedz: boolean;
  /** Ustawione = dodanie punktów (np. korekta) kończy się tym błędem i nic nie zmienia. */
  odmowaDodania: BladPunktow | null;
}

/**
 * Trzyma reguły Voucherify z dokumentacji i z sandboksa: karta na klienta (drugi zapis zwraca tę samą), saldo,
 * historia z naszym source_id; odjęcie większe niż saldo jest obcinane do salda, a zmiana o 0 nie trafia do historii.
 */
export function sztuczneKonto(): SztuczneKonto {
  let numer = 0;
  const konto: SztuczneKonto = {
    karty: new Map(),
    wywolania: [],
    awaria: null,
    zgubOdpowiedz: false,
    odmowaDodania: null,
    async znajdzKarte(email) {
      konto.wywolania.push(`znajdz:${email}`);
      if (konto.awaria) throw konto.awaria;
      const k = konto.karty.get(email);
      return k ? { memberId: k.memberId, saldo: k.saldo } : null;
    },
    async zalozKarte(email): Promise<KartaPunktow> {
      konto.wywolania.push(`zaloz:${email}`);
      if (konto.awaria) throw konto.awaria;
      const istniejaca = konto.karty.get(email);
      if (istniejaca) return { memberId: istniejaca.memberId, saldo: istniejaca.saldo };
      const k = { memberId: `KARTA-${++numer}`, saldo: 0, operacje: [] };
      konto.karty.set(email, k);
      return { memberId: k.memberId, saldo: 0 };
    },
    async saldo(memberId) {
      konto.wywolania.push(`saldo:${memberId}`);
      if (konto.awaria) throw konto.awaria;
      return kartaPoId(memberId).saldo;
    },
    async zmienSaldo(memberId, punkty, opis: OpisOperacji) {
      konto.wywolania.push(`zmiana:${memberId}:${punkty}:${opis.sourceId}`);
      if (konto.awaria) throw konto.awaria;
      const k = kartaPoId(memberId);
      if (punkty > 0 && konto.odmowaDodania) throw konto.odmowaDodania;
      // Jak sandbox: odjęcie większe niż saldo zdejmuje tylko to, co jest.
      const zmiana = punkty < 0 ? -Math.min(k.saldo, -punkty) : punkty;
      k.saldo += zmiana;
      if (zmiana !== 0) k.operacje.push({ sourceId: opis.sourceId, punkty: zmiana });
      if (konto.zgubOdpowiedz) {
        konto.zgubOdpowiedz = false;
        throw new BladPunktow("Voucherify nie odpowiada: timeout", "przejsciowy", { niepewny: true });
      }
      return { saldo: k.saldo, zmiana };
    },
    async zmianyWHistorii(memberId, sourceIds) {
      konto.wywolania.push(`historia:${memberId}`);
      if (konto.awaria) throw konto.awaria;
      const zmiany = new Map<string, number>();
      for (const o of kartaPoId(memberId).operacje) {
        if (sourceIds.includes(o.sourceId)) zmiany.set(o.sourceId, (zmiany.get(o.sourceId) ?? 0) + o.punkty);
      }
      return zmiany;
    },
  };
  function kartaPoId(memberId: string) {
    for (const k of konto.karty.values()) if (k.memberId === memberId) return k;
    throw new BladPunktow(`Voucherify 404 not_found: ${memberId}`, "trwaly", { status: 404 });
  }
  return konto;
}

export function uslugaPunktow(bramka: BramkaPunktow, opcje: { budzet?: BudzetWywolan; swiezoscSaldaMs?: number } = {}): UslugaPunktow {
  return { bramka, budzet: opcje.budzet, swiezoscSaldaMs: opcje.swiezoscSaldaMs ?? 30_000 };
}

// ——— Resend bez sieci ———

export interface SztucznyMailer extends BramkaMaili {
  wyslane: { mail: Mail; klucz: string; id: string }[];
  /** Ustawione = każda wysyłka kończy się tym błędem. */
  awaria: BladMaila | null;
}

/** Klucz idempotencji jak w Resend: ta sama wysyłka drugi raz oddaje tę samą odpowiedź, bez drugiego maila. */
export function sztucznyMailer(): SztucznyMailer {
  const mailer: SztucznyMailer = {
    wyslane: [],
    awaria: null,
    async wyslij(mail, klucz) {
      if (mailer.awaria) throw mailer.awaria;
      const byl = mailer.wyslane.find((w) => w.klucz === klucz);
      if (byl) return { id: byl.id };
      const id = `mail_${mailer.wyslane.length + 1}`;
      mailer.wyslane.push({ mail, klucz, id });
      return { id };
    },
  };
  return mailer;
}

/** Żądanie GET (odczyty), opcjonalnie z nagłówkami, np. If-None-Match. */
export function zadanieGet(sciezka = "/api/events", naglowki: Record<string, string> = {}): Request {
  return new Request(`https://kasa.test${sciezka}`, { headers: naglowki });
}

export interface DaneTestowe {
  eventId?: string;
  seatId: string;
  name?: string;
  email?: string;
}

export function zadanieRezerwacji(dane: DaneTestowe, opcje: { klucz?: string; ip?: string } = {}): Request {
  const naglowki: Record<string, string> = { "content-type": "application/json" };
  if (opcje.klucz) naglowki["idempotency-key"] = opcje.klucz;
  if (opcje.ip) naglowki["cf-connecting-ip"] = opcje.ip;
  return new Request("https://kasa.test/api/reservations", {
    method: "POST",
    headers: naglowki,
    body: JSON.stringify({
      eventId: dane.eventId ?? SEANS,
      seatId: dane.seatId,
      name: dane.name ?? "Jan Testowy",
      email: dane.email ?? "jan@example.com",
    }),
  });
}

export interface Wynik<T = Record<string, unknown>> {
  status: number;
  cialo: T;
  naglowki: Headers;
}

async function odczytaj<T>(odpowiedz: Response): Promise<Wynik<T>> {
  return { status: odpowiedz.status, cialo: (await odpowiedz.json()) as T, naglowki: odpowiedz.headers };
}

export async function zarezerwuj(
  z: Zaleznosci,
  dane: DaneTestowe,
  opcje: { klucz?: string; ip?: string } = {},
): Promise<Wynik<{ reservationId: string; expiresAt: number; amount: number; error?: string }>> {
  return odczytaj(await obsluzRezerwacje(zadanieRezerwacji(dane, opcje), () => z));
}

/** Jak w kontrakcie: sam identyfikator rezerwacji, bez ciasteczek ani ciała. */
export function zadanieZakupu(reservationId: string): Request {
  return new Request(`https://kasa.test/api/reservations/${reservationId}/purchase`, { method: "POST" });
}

/** POST /purchase: oddaje kod opłaconej rezerwacji. */
export async function odbierzKod(z: Zaleznosci, reservationId: string): Promise<Wynik<{ code: string; error?: string }>> {
  return odczytaj(await obsluzZakup(zadanieZakupu(reservationId), () => z, reservationId));
}

/** Zakup po nowemu: płatność przez webhook i odczyt kodu. Status to odpowiedź webhooka. */
export async function kup(
  z: Zaleznosci,
  reservationId: string,
  opcje: OpcjeZdarzenia = {},
): Promise<Wynik<{ code: string; error?: string }>> {
  const webhook = await zaplac(z, reservationId, opcje);
  if (webhook.status !== 200) return webhook as Wynik<{ code: string; error?: string }>;
  const stan = await stanRezerwacji(z, reservationId);
  return { status: webhook.status, naglowki: webhook.naglowki, cialo: { code: stan.cialo.code as string } };
}

export async function wierszMiejsca(seatId: string, eventId = SEANS) {
  return env.DB.prepare("SELECT * FROM seats WHERE eventId = ?1 AND seatId = ?2")
    .bind(eventId, seatId)
    .first<Record<string, unknown>>();
}

export function liczStatusy(statusy: number[]): Record<number, number> {
  return statusy.reduce<Record<number, number>>((acc, s) => ((acc[s] = (acc[s] ?? 0) + 1), acc), {});
}

// ——— bazy do testów awarii ———

/** Baza, której każde zapytanie kończy się błędem (np. zerwane połączenie z D1). */
export function zepsutaBaza(komunikat = "D1_ERROR: Network connection lost."): D1Database {
  const rzuc = () => Promise.reject(new Error(komunikat));
  const zdanie = { bind: () => zdanie, run: rzuc, first: rzuc, all: rzuc, raw: rzuc };
  return { prepare: () => zdanie, batch: rzuc, exec: rzuc } as unknown as D1Database;
}

/** Baza, która nigdy nie odpowiada. */
export function zawieszonaBaza(): D1Database {
  const nigdy = () => new Promise<never>(() => {});
  const zdanie = { bind: () => zdanie, run: nigdy, first: nigdy, all: nigdy, raw: nigdy };
  return { prepare: () => zdanie, batch: nigdy, exec: nigdy } as unknown as D1Database;
}

/**
 * Prawdziwa baza, której zapisy (run) WYKONUJĄ się, ale odpowiedź przychodzi z opóźnieniem.
 * Symuluje timeout po stronie serwera/klienta, gdy zapis już się udał.
 */
export function wolneZapisy(db: D1Database, opoznienieMs: number): D1Database {
  return {
    prepare(sql: string) {
      const prawdziwe = db.prepare(sql);
      return {
        bind(...wartosci: unknown[]) {
          const zwiazane = prawdziwe.bind(...wartosci);
          return {
            prawdziwe: zwiazane,
            run: async () => {
              const wynik = await zwiazane.run();
              await new Promise((r) => setTimeout(r, opoznienieMs));
              return wynik;
            },
            first: (kol?: string) => (kol ? zwiazane.first(kol) : zwiazane.first()),
            all: () => zwiazane.all(),
            raw: () => zwiazane.raw(),
          };
        },
      };
    },
    batch: async (zdania: { prawdziwe: D1PreparedStatement }[]) => {
      const wynik = await db.batch(zdania.map((zdanie) => zdanie.prawdziwe));
      await new Promise((r) => setTimeout(r, opoznienieMs));
      return wynik;
    },
  } as unknown as D1Database;
}
