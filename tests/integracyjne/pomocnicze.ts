// Wspólne narzędzia testów integracyjnych: świeży seed, zależności z zegarem testowym,
// budowanie żądań i „zepsute" bazy do testów odporności.

import { env } from "cloudflare:test";
import Stripe from "stripe";
import { utworzZegarTestowy, type ZegarTestowy } from "../../src/lib/czas";
import { wczytajKonfiguracje } from "../../src/lib/config";
import { nowyCacheOdczytow } from "../../src/lib/db/polaczenie";
import type { BramkaPlatnosci, ParametrySesji, StanSesji, ZdarzeniePlatnosci } from "../../src/lib/domain/platnosc";
import type { StanRezerwacji } from "../../src/lib/domain/typy";
import type { Limitery } from "../../src/lib/resilience/limit-zapytan";
import { StraznikPrzeciazenia } from "../../src/lib/resilience/przeciazenie";
import {
  obsluzCheckout,
  obsluzOdczytRezerwacji,
  obsluzRezerwacje,
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
}

export function zaleznosci(opcje: OpcjeZaleznosci = {}): Zaleznosci & { zegar: ZegarTestowy } {
  return {
    db: "db" in opcje ? opcje.db : env.DB,
    konfiguracja: wczytajKonfiguracje({
      RESERVATION_TTL_SECONDS: String(TTL_MS / 1000),
      MAX_ACTIVE_RESERVATIONS_PER_EMAIL: "4",
      ...opcje.zmienne,
    }),
    zegar: opcje.zegar ?? utworzZegarTestowy(),
    limitery: opcje.limitery ?? {},
    // Testy współbieżności sprawdzają bazę, nie load shedding: duże pule.
    straznik: opcje.straznik ?? new StraznikPrzeciazenia({ maxOdczytow: 10_000, maxZapisow: 10_000 }),
    cache: nowyCacheOdczytow(),
    platnosci: "platnosci" in opcje ? opcje.platnosci : sztucznaBramka(),
    sekretWebhooka: "sekretWebhooka" in opcje ? opcje.sekretWebhooka : SEKRET_WEBHOOKA,
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

export async function checkout(z: Zaleznosci, reservationId: string): Promise<Wynik<{ url: string; error?: string }>> {
  const zadanie = new Request(`https://kasa.test/api/reservations/${reservationId}/checkout`, { method: "POST" });
  return odczytaj(await obsluzCheckout(zadanie, () => z, reservationId));
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
