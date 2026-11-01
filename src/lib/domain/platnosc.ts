// Płatność przez Stripe Checkout. Stripe to cudzy system: każde przejście ma swojego strażnika.
//
//   Sesja płatności      🔑 klucz idempotencji    podwójne kliknięcie i ponowienie = ta sama sesja
//   Webhook od Stripe'a  ✍️ podpis                nikt inny nie oznaczy rezerwacji jako opłaconej
//   Bilet                📥 inbox + warunek       jedna transakcja, drugie dostarczenie niczego nie zmienia
//   Zwrot, wygaszenie    📤 outbox + 🔑 klucz     zapisane razem z naszymi danymi, wysyła Cron (domain/outbox.ts)
//
// Bez Next.js i bez SDK Stripe'a: baza przychodzi jako argument, a Stripe przez interfejs `BramkaPlatnosci`.

import {
  czyDuplikatZdarzenia,
  czyKolizjaKodu,
  zaksieguj,
  zapiszSesje,
  znajdzRezerwacje,
  type WierszRezerwacji,
} from "../db/zapytania-platnosci";
import { formatujGodzineZSekundami, formatujTermin } from "../format";
import { BladDomenowy } from "./bledy";
import { czyPoprawneIdRezerwacji } from "./dane-klienta";
import { generujKodBiletu } from "./rezerwacja";
import type { SesjaPlatnosci, StanRezerwacji, StatusRezerwacji } from "./typy";
import { opisMiejsca } from "./uklad-sali";

export const WALUTA = "pln";
export const TASK_ZWROT = "stripe-refund";
export const TASK_STRAZNIK_SESJI = "stripe-session-watch";
export const CO_ILE_STRAZNIK_MS = 60_000;

/**
 * Stripe nie pozwala na sesję krótszą niż 30 minut, więc sesja zawsze przeżyje rezerwację (15 min, w testach 2).
 * Liczymy od expiresAt rezerwacji, a nie od „teraz”: parametry muszą być takie same przy każdej próbie,
 * bo ten sam klucz idempotencji z innymi parametrami to błąd Stripe'a. Po wygaśnięciu rezerwacji sesję
 * wygasza strażnik, a płatność, która mimo to zdąży, wraca do klienta (`rozliczPlatnosc`).
 */
const ZAPAS_SESJI_S = 31 * 60;
const MAX_PROB_KODU = 5;

export interface ParametrySesji {
  reservationId: string;
  /** W groszach, zawsze z rezerwacji. */
  amount: number;
  nazwa: string;
  opis: string;
  /** Widać ją na stronie Stripe'a przy przycisku płatności. */
  uwaga: string;
  adresSukcesu: string;
  adresPrzerwania: string;
  /** Epoch s. */
  wygasaO: number;
}

export interface StanSesji {
  status: "open" | "complete" | "expired";
  oplacona: boolean;
  paymentIntentId: string | null;
  kwota: number | null;
  waluta: string | null;
  /** Epoch ms przyjęcia płatności, jeśli Stripe ją zna. */
  oplaconoO: number | null;
}

/** Awaria albo odmowa po stronie dostawcy płatności. */
export class BladBramki extends Error {
  constructor(
    komunikat: string,
    readonly ponowZaS?: number,
  ) {
    super(komunikat);
    this.name = "BladBramki";
  }
}

export interface BramkaPlatnosci {
  utworzSesje(p: ParametrySesji, kluczIdempotencji: string): Promise<{ id: string; url: string }>;
  pobierzSesje(id: string): Promise<StanSesji>;
  wygasSesje(id: string): Promise<void>;
  zwrocPlatnosc(paymentIntentId: string, kluczIdempotencji: string, reservationId: string): Promise<void>;
}

/** Fragment zdarzenia od Stripe'a, którego używamy. */
export interface ZdarzeniePlatnosci {
  id: string;
  type: string;
  /** Epoch s: kiedy Stripe utworzył zdarzenie, czyli przyjął płatność. Takie samo przy każdej powtórce. */
  created: number;
  data: {
    object: {
      client_reference_id?: string | null;
      payment_status?: string | null;
      payment_intent?: string | { id: string } | null;
      amount_total?: number | null;
      currency?: string | null;
    };
  };
}

// ——— Stan rezerwacji ———

/** Fotel w `seats` mówi, czy rezerwacja żyje. Gdy ma już innego właściciela albo jest wolny, ta wygasła. */
export function statusRezerwacji(w: WierszRezerwacji, teraz: number): StatusRezerwacji {
  if (w.seatStatus === "purchased") return "paid";
  if (w.seatStatus === "reserved" && w.expiresAt > teraz) return "held";
  return "expired";
}

export function stanDlaKlienta(w: WierszRezerwacji, teraz: number): StanRezerwacji {
  const status = statusRezerwacji(w, teraz);
  const stan: StanRezerwacji = { status, amount: w.amount, expiresAt: w.expiresAt };
  if (status === "paid" && w.code) stan.code = w.code;
  if (w.refundStatus) stan.refund = w.refundStatus;
  return stan;
}

// ——— Karta A: sesja płatności ———

export function kluczCheckoutu(reservationId: string): string {
  return `checkout:${reservationId}`;
}

export function kluczZwrotu(paymentIntentId: string): string {
  return `${TASK_ZWROT}:${paymentIntentId}`;
}

function parametrySesji(w: WierszRezerwacji, adresBazowy: string): ParametrySesji {
  const zapytanie = `seans=${encodeURIComponent(w.eventId)}&miejsce=${encodeURIComponent(w.seatId)}`;
  const opis = [w.startsAt ? formatujTermin(w.startsAt) : null, w.hall, opisMiejsca(w.seatId)].filter(Boolean).join(" · ");
  return {
    reservationId: w.id,
    amount: w.amount,
    nazwa: `Bilet: ${w.movie ?? "seans"}`,
    opis,
    uwaga: `Rezerwacja trzyma fotel do ${formatujGodzineZSekundami(w.expiresAt)}. Zapłać przed tą godziną: po niej bilet nie powstanie, a płatność wróci na kartę.`,
    // {CHECKOUT_SESSION_ID} podstawia Stripe przy przekierowaniu.
    adresSukcesu: `${adresBazowy}/bilet/${w.id}?${zapytanie}&session_id={CHECKOUT_SESSION_ID}`,
    adresPrzerwania: `${adresBazowy}/rezerwacja/${w.id}?${zapytanie}&platnosc=przerwana`,
    wygasaO: Math.floor(w.expiresAt / 1000) + ZAPAS_SESJI_S,
  };
}

export interface KontekstPlatnosci {
  /** Praca na bazie w puli i z timeoutem. Wywołanie Stripe'a jest celowo poza nią. */
  wBazie: <T>(praca: (db: D1Database) => Promise<T>) => Promise<T>;
  bramka: BramkaPlatnosci | undefined;
  teraz: number;
}

function bladDostawcy(blad: unknown): BladDomenowy {
  console.error("Stripe nie utworzył sesji:", blad instanceof Error ? blad.message : String(blad));
  const ponowZaS = blad instanceof BladBramki && blad.ponowZaS !== undefined ? blad.ponowZaS : 3;
  return new BladDomenowy("PLATNOSCI_NIEDOSTEPNE", { ponowZaS });
}

/**
 * Podwójne kliknięcie, retry i powrót po przerwanej płatności dają tę samą sesję: najpierw z naszej bazy,
 * a gdy zapis jeszcze nie zdążył, z klucza idempotencji u Stripe'a. Gdy padniemy między wywołaniem Stripe'a
 * a zapisem, ponowienie dostanie tę samą sesję i ją zapisze. Klient nie dostał adresu, więc nic nie przepada.
 */
export async function utworzPlatnosc(
  k: KontekstPlatnosci,
  reservationId: string,
  adresBazowy: string,
): Promise<SesjaPlatnosci> {
  const w = await k.wBazie((db) => znajdzRezerwacje(db, reservationId));
  if (!w) throw new BladDomenowy("NIE_ZNALEZIONO", { komunikat: "Nie ma takiej rezerwacji." });
  const status = statusRezerwacji(w, k.teraz);
  if (status === "paid") throw new BladDomenowy("JUZ_OPLACONA");
  if (status === "expired") throw new BladDomenowy("WYGASLA");
  if (w.stripeSessionUrl) return { url: w.stripeSessionUrl };

  if (!k.bramka) {
    console.error("Brak STRIPE_SECRET_KEY: płatności wyłączone.");
    throw new BladDomenowy("PLATNOSCI_NIEDOSTEPNE", { ponowZaS: 30 });
  }
  let sesja: { id: string; url: string };
  try {
    sesja = await k.bramka.utworzSesje(parametrySesji(w, adresBazowy), kluczCheckoutu(w.id));
  } catch (blad) {
    throw bladDostawcy(blad);
  }
  await k.wBazie((db) =>
    zapiszSesje(db, {
      reservationId: w.id,
      sessionId: sesja.id,
      url: sesja.url,
      teraz: k.teraz,
      straznik: {
        id: `${TASK_STRAZNIK_SESJI}:${w.id}`,
        task: TASK_STRAZNIK_SESJI,
        input: { reservationId: w.id, sessionId: sesja.id },
        visibleAt: Math.min(k.teraz + CO_ILE_STRAZNIK_MS, w.expiresAt),
      },
    }),
  );
  return { url: sesja.url };
}

// ——— Karta B: rozliczenie płatności ———

export interface WynikRozliczenia {
  biletWydany: boolean;
  zwrotZaplanowany: boolean;
  duplikat: boolean;
}

export interface PlatnoscDoRozliczenia {
  paymentIntentId: string;
  kwota: number | null | undefined;
  waluta: string | null | undefined;
  /** Kiedy Stripe przyjął płatność (epoch ms). Decyduje o „na czas”, a nie chwila dostarczenia webhooka. */
  paidAt: number;
  teraz: number;
  /** ID zdarzenia do inboxu. Brak = rozliczenie przez strażnika sesji. */
  idZdarzenia?: string;
  generujKod?: () => string;
}

/**
 * Płatność zamienia rezerwację w bilet tylko, gdy przyszła przed `expiresAt`, zgadza się kwota i fotel
 * nie ma innego właściciela. W każdym innym przypadku pieniądze wracają do klienta, a fotel zostaje przy
 * tym, kto go ma: nigdy dwóch właścicieli i nigdy biletu po czasie.
 * Spóźniony webhook nie szkodzi: liczy się chwila płatności, nie dostarczenia.
 */
export async function rozliczPlatnosc(
  db: D1Database,
  r: WierszRezerwacji,
  p: PlatnoscDoRozliczenia,
): Promise<WynikRozliczenia> {
  const generujKod = p.generujKod ?? (() => generujKodBiletu());
  const kwotaZgodna = p.kwota === r.amount && p.waluta === WALUTA;
  if (!kwotaZgodna) {
    console.error(
      JSON.stringify({ alert: "kasa-kino", poziom: "kwota-platnosci", reservationId: r.id, kwota: p.kwota, waluta: p.waluta }),
    );
  }
  for (let proba = 1; ; proba++) {
    try {
      const wynik = await zaksieguj(db, {
        reservationId: r.id,
        eventId: r.eventId,
        seatId: r.seatId,
        paymentIntentId: p.paymentIntentId,
        paidAt: p.paidAt,
        teraz: p.teraz,
        code: generujKod(),
        moznaWydacBilet: kwotaZgodna && p.paidAt < r.expiresAt,
        ...(p.idZdarzenia ? { idZdarzenia: p.idZdarzenia } : {}),
        zwrot: {
          id: kluczZwrotu(p.paymentIntentId),
          task: TASK_ZWROT,
          input: { paymentIntentId: p.paymentIntentId, reservationId: r.id },
          visibleAt: p.teraz,
        },
      });
      return { ...wynik, duplikat: false };
    } catch (blad) {
      // 2. dostarczenie tego samego zdarzenia: transakcja się wycofała, skutek jest z pierwszego razu.
      if (czyDuplikatZdarzenia(blad)) return { biletWydany: false, zwrotZaplanowany: false, duplikat: true };
      if (czyKolizjaKodu(blad) && proba < MAX_PROB_KODU) continue;
      throw blad;
    }
  }
}

function czyZdarzenieOplacenia(typ: string): boolean {
  // Drugi typ: metody z opóźnionym potwierdzeniem. Przy karcie płatność jest przyjęta już w pierwszym.
  return typ === "checkout.session.completed" || typ === "checkout.session.async_payment_succeeded";
}

export interface WynikZdarzenia extends WynikRozliczenia {
  /** Seans, którego stan mógł się zmienić. */
  eventId: string | null;
}

const BEZ_SKUTKU: WynikZdarzenia = { biletWydany: false, zwrotZaplanowany: false, duplikat: false, eventId: null };

/**
 * Obsługa zdarzenia z webhooka. Inne typy i cudze rezerwacje kończą się bez skutku, bo jedno konto Stripe
 * mogą dzielić środowiska: zdarzenie z innego środowiska nie może tu niczego zmienić ani zwrócić.
 */
export async function obsluzZdarzeniePlatnosci(
  db: D1Database,
  zdarzenie: ZdarzeniePlatnosci,
  opcje: { teraz: number; generujKod?: () => string },
): Promise<WynikZdarzenia> {
  if (!czyZdarzenieOplacenia(zdarzenie.type)) return BEZ_SKUTKU;
  const sesja = zdarzenie.data.object;
  if (sesja.payment_status !== "paid") return BEZ_SKUTKU;
  const reservationId = sesja.client_reference_id;
  if (!czyPoprawneIdRezerwacji(reservationId)) return BEZ_SKUTKU;
  const platnosc = sesja.payment_intent;
  const paymentIntentId = typeof platnosc === "string" ? platnosc : platnosc?.id;
  if (!paymentIntentId) return BEZ_SKUTKU;

  const rezerwacja = await znajdzRezerwacje(db, reservationId);
  if (!rezerwacja) return BEZ_SKUTKU;

  const wynik = await rozliczPlatnosc(db, rezerwacja, {
    paymentIntentId,
    kwota: sesja.amount_total,
    waluta: sesja.currency,
    paidAt: zdarzenie.created * 1000,
    teraz: opcje.teraz,
    idZdarzenia: zdarzenie.id,
    ...(opcje.generujKod ? { generujKod: opcje.generujKod } : {}),
  });
  return { ...wynik, eventId: rezerwacja.eventId };
}
