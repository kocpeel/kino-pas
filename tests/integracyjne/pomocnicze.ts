// Wspólne narzędzia testów integracyjnych: świeży seed, zależności z zegarem testowym,
// budowanie żądań i „zepsute" bazy do testów odporności.

import { env } from "cloudflare:test";
import { utworzZegarTestowy, type ZegarTestowy } from "../../src/lib/czas";
import { wczytajKonfiguracje } from "../../src/lib/config";
import { nowyCacheOdczytow } from "../../src/lib/db/polaczenie";
import type { Limitery } from "../../src/lib/resilience/limit-zapytan";
import { StraznikPrzeciazenia } from "../../src/lib/resilience/przeciazenie";
import { obsluzRezerwacje, obsluzZakup } from "../../src/lib/http/trasy";
import type { Zaleznosci } from "../../src/lib/zaleznosci";
import { SEANSE, zbudujSeed } from "../../seed/generuj-seed";

export const SEANS = SEANSE[0]!.id;
export const INNY_SEANS = SEANSE[1]!.id;
export const TTL_MS = 120_000;

/** Każdy test zaczyna od czystych 3 seansów × 80 foteli. */
export async function zasiej(db: D1Database = env.DB): Promise<void> {
  await db.batch([db.prepare("DELETE FROM seats"), db.prepare("DELETE FROM events")]);
  await db.batch(zbudujSeed().map((sql) => db.prepare(sql)));
}

export interface OpcjeZaleznosci {
  zegar?: ZegarTestowy;
  db?: D1Database | undefined;
  limitery?: Limitery;
  straznik?: StraznikPrzeciazenia;
  zmienne?: Record<string, string>;
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
  };
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

/** Ciasteczko „przeglądarki" z sekretem rezerwacji (jak w prawdziwym kliencie). */
export function ciasteczkoZOdpowiedzi(naglowki: Headers): string | null {
  return naglowki.get("set-cookie")?.split(";")[0] ?? null;
}

// Pamięć „przeglądarki" testów: reservationId → ciasteczko z odpowiedzi rezerwacji.
const ciasteczka = new Map<string, string>();

export async function zarezerwuj(
  z: Zaleznosci,
  dane: DaneTestowe,
  opcje: { klucz?: string; ip?: string } = {},
): Promise<Wynik<{ reservationId: string; expiresAt: number; error?: string }>> {
  const wynik = await odczytaj<{ reservationId: string; expiresAt: number; error?: string }>(
    await obsluzRezerwacje(zadanieRezerwacji(dane, opcje), () => z),
  );
  const ciasteczko = ciasteczkoZOdpowiedzi(wynik.naglowki);
  if (wynik.status === 201 && ciasteczko) ciasteczka.set(wynik.cialo.reservationId, ciasteczko);
  return wynik;
}

export function zadanieZakupu(reservationId: string, ciasteczko: string | null | undefined): Request {
  return new Request(`https://kasa.test/api/reservations/${reservationId}/purchase`, {
    method: "POST",
    headers: ciasteczko ? { cookie: ciasteczko } : {},
  });
}

/** Zakup z ciasteczkiem tej rezerwacji (jak w przeglądarce, która ją zrobiła), chyba że podano inne. */
export async function kup(
  z: Zaleznosci,
  reservationId: string,
  opcje: { ciasteczko?: string | null } = {},
): Promise<Wynik<{ code: string; error?: string }>> {
  const ciasteczko = "ciasteczko" in opcje ? opcje.ciasteczko : ciasteczka.get(reservationId);
  return odczytaj(await obsluzZakup(zadanieZakupu(reservationId, ciasteczko), () => z, reservationId));
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
    batch: (zdania: D1PreparedStatement[]) => db.batch(zdania),
  } as unknown as D1Database;
}
