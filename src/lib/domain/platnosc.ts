// Płatność przez Stripe Checkout, a od etapu III także punktami. Zakup to saga (E08): kroki w cudzych systemach,
// każdy z kompensacją, a postęp zapisany w `sagas`.
//
//   Punkty (Voucherify)  🔒 blokada konta + notatka   punkty schodzą raz; niepewna próba = sprawdzenie historii karty
//   Sesja płatności      🔑 klucz idempotencji         podwójne kliknięcie i ponowienie = ta sama sesja
//   Webhook od Stripe'a  ✍️ podpis                     nikt inny nie oznaczy rezerwacji jako opłaconej
//   Bilet                📥 inbox + warunek            jedna transakcja razem z kolejnymi krokami sagi w outboksie
//   Zwroty, mail         📤 outbox + 🔑 klucz          zwrot na kartę, oddanie punktów, naliczenie, mail (domain/outbox.ts)
//
// Bez Next.js i bez SDK: baza przychodzi jako argument, Stripe i Voucherify przez interfejsy.

import type { Zegar } from "../czas";
import { sagaZakupu, zdanieKrokSagi, zdanieRozpocznijSage, zdanieWynikiSagi, zdanieZapiszSaldo } from "../db/zapytania-punktow";
import {
  czyDuplikatZdarzenia,
  czyKolizjaKodu,
  zaksieguj,
  zapiszSesje,
  zdanieStraznika,
  znajdzRezerwacje,
  type WierszRezerwacji,
} from "../db/zapytania-platnosci";
import { formatujCene, formatujGodzineZSekundami, formatujTermin } from "../format";
import { BladPunktow, type ZmianaSalda } from "../punkty/voucherify";
import { BladDomenowy } from "./bledy";
import { czyPoprawneIdRezerwacji } from "./dane-klienta";
import {
  idKorekty,
  idWydania,
  KontoZajete,
  saldoKarty,
  wBudzecie,
  zapewnijKarte,
  zeszloWProbie,
  zWylacznoscia,
  type UslugaPunktow,
} from "./konto-punktowe";
import { doZaplatyKarta, punktyZaZakup, walidujPunkty } from "./punkty";
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
  const stan: StanRezerwacji = { status, amount: w.amount, expiresAt: w.expiresAt, pointsUsed: w.pointsUsed };
  if (status === "paid" && w.code) stan.code = w.code;
  if (status === "paid" && w.pointsEarned !== null) stan.pointsEarned = w.pointsEarned;
  if (w.refundStatus) stan.refund = w.refundStatus;
  if (w.pointsStatus) stan.pointsStatus = w.pointsStatus;
  if (w.emailStatus) stan.emailStatus = w.emailStatus;
  return stan;
}

// ——— Karta A: sesja płatności ———

/** Klucz zależy od punktów, bo od nich zależy kwota sesji (ten sam klucz z inną kwotą to błąd Stripe'a). */
export function kluczCheckoutu(reservationId: string, punkty = 0): string {
  return `checkout:${reservationId}:${punkty}`;
}

export function kluczZwrotu(paymentIntentId: string): string {
  return `${TASK_ZWROT}:${paymentIntentId}`;
}

function parametrySesji(w: WierszRezerwacji, adresBazowy: string, punkty: number): ParametrySesji {
  const zapytanie = `seans=${encodeURIComponent(w.eventId)}&miejsce=${encodeURIComponent(w.seatId)}`;
  const opis = [
    w.startsAt ? formatujTermin(w.startsAt) : null,
    w.hall,
    opisMiejsca(w.seatId),
    punkty > 0 ? `punktami ${punkty} pkt (${formatujCene(punkty)})` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    reservationId: w.id,
    amount: doZaplatyKarta(w.amount, punkty),
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
  /** Program punktowy (Voucherify). undefined = wyłączony: płatność bez punktów działa dalej. */
  punkty?: UslugaPunktow | undefined;
  /** Baza dla kroku z punktami: kilka krótkich zapytań między wywołaniami Voucherify, więc poza pulą. */
  db?: D1Database | undefined;
  zegar?: Zegar | undefined;
  teraz: number;
}

/** Ile checkout z punktami czeka, gdy na punktach klienta trwa inna operacja (np. podwójne kliknięcie). */
const CZEKAJ_NA_KONTO_MS = 4000;

function opisZablokowanych(punkty: number): string {
  return punkty > 0
    ? `Płatność tej rezerwacji jest już przygotowana z ${punkty} pkt. Dokończ ją albo poczekaj, aż rezerwacja wygaśnie.`
    : "Płatność tej rezerwacji jest już przygotowana bez punktów. Dokończ ją albo poczekaj, aż rezerwacja wygaśnie.";
}

/** Voucherify odmówił, bo na karcie jest za mało punktów (klucze z dokumentacji błędów, na wypadek odmowy zamiast obcięcia). */
function czyBrakPunktow(blad: BladPunktow): boolean {
  return blad.rodzaj === "trwaly" && /points_exceeded|not_enough|insufficient|zero_card_balance/i.test(`${blad.klucz ?? ""} ${blad.message}`);
}

function zaMaloPunktow(saldo: number, punkty: number): BladDomenowy {
  return new BladDomenowy("ZA_MALO_PUNKTOW", {
    komunikat: `Masz ${saldo} pkt, a chcesz wydać ${punkty} pkt.`,
    szczegoly: { points: `Masz ${saldo} pkt.` },
  });
}

interface ProbaWydania {
  db: D1Database;
  u: UslugaPunktow;
  reservationId: string;
  email: string;
  memberId: string;
  teraz: number;
}

/**
 * ↩️ Kompensacja obciętej próby wydania. Voucherify zdejmuje najwyżej tyle, ile jest na karcie, więc gdy zeszło
 * mniej, niż klient chciał wydać, oddajemy to, co zeszło (`korekta:<source_id próby>`), i kasujemy notatkę.
 * Gdy korekta się nie uda, notatka zostaje: następny checkout albo strażnik po końcu rezerwacji odda punkty
 * w liczbie z historii karty. Zwraca saldo po korekcie (przewidywane, gdy korekta czeka).
 */
async function oddajObciete(p: ProbaWydania, wydanieId: string, zeszlo: number, saldoPrzed: number): Promise<number> {
  const { db, u, reservationId, email, memberId, teraz } = p;
  if (zeszlo <= 0) {
    await db.batch([zdanieWynikiSagi(db, reservationId, { wydanieNiepewne: false }, teraz), zdanieZapiszSaldo(db, email, saldoPrzed, teraz)]);
    return saldoPrzed;
  }
  try {
    const { saldo } = await wBudzecie(u, "zapis", () =>
      u.bramka.zmienSaldo(memberId, zeszlo, {
        sourceId: idKorekty(wydanieId),
        powod: `Korekta: zwrot ${zeszlo} pkt z obciętego wydania, rezerwacja ${reservationId}`,
      }),
    );
    await db.batch([zdanieWynikiSagi(db, reservationId, { wydanieNiepewne: false }, teraz), zdanieZapiszSaldo(db, email, saldo, teraz)]);
    return saldo;
  } catch (blad) {
    console.error("Korekta obciętego wydania punktów nie wyszła, odda je strażnik:", blad instanceof Error ? blad.message : String(blad));
    return saldoPrzed + zeszlo;
  }
}

/**
 * Krok 1 sagi: punkty schodzą z karty klienta w Voucherify. Pod blokadą konta, więc dwa równoległe checkouty
 * (podwójne kliknięcie, dwie rezerwacje jednego klienta) nie wydadzą tych samych punktów. Przed wywołaniem
 * zapisujemy notatkę i strażnika: gdy odpowiedź nie dotrze, strażnik po końcu rezerwacji sprawdzi historię karty
 * i odda punkty, jeśli zeszły, a ponowiony checkout najpierw sprawdzi, ile zeszło.
 * Voucherify nie odmawia odjęcia większego niż saldo, tylko je obcina (sprawdzone na sandboksie). Gdy zejdzie
 * mniej, niż trzeba (saldo w pamięci było starsze niż wydatek w kasie), oddajemy to, co zeszło, i odmawiamy 422.
 */
async function wydajPunkty(k: KontekstPlatnosci, w: WierszRezerwacji, punkty: number): Promise<void> {
  const u = k.punkty;
  const db = k.db;
  if (!u || !db) {
    throw new BladDomenowy("PUNKTY_NIEDOSTEPNE", {
      komunikat: "Program punktowy jest chwilowo wyłączony. Możesz zapłacić bez punktów.",
      ponowZaS: 60,
    });
  }
  const email = w.seatEmail;
  if (!email) throw new BladDomenowy("WYGASLA");
  const zegar = k.zegar ?? { teraz: () => k.teraz };
  const straznik = {
    id: `${TASK_STRAZNIK_SESJI}:${w.id}`,
    task: TASK_STRAZNIK_SESJI,
    input: { reservationId: w.id },
    visibleAt: w.expiresAt,
  };
  try {
    await zWylacznoscia(db, email, zegar, CZEKAJ_NA_KONTO_MS, async () => {
      const teraz = zegar.teraz();
      const swieza = await znajdzRezerwacje(db, w.id);
      if (swieza && swieza.pointsUsed > 0) {
        // Równoległe żądanie zdążyło pierwsze.
        if (swieza.pointsUsed !== punkty) throw new BladDomenowy("PUNKTY_ZABLOKOWANE", { komunikat: opisZablokowanych(swieza.pointsUsed) });
        return;
      }
      const saga = await sagaZakupu(db, w.id);
      const { memberId } = await zapewnijKarte(db, u, email, teraz);
      const proba: ProbaWydania = { db, u, reservationId: w.id, email, memberId, teraz };
      const zapiszWydanie = (wydane: number, saldoPo: number | null) =>
        db.batch([
          db.prepare(`UPDATE reservations SET pointsUsed = ?2 WHERE id = ?1 AND pointsUsed = 0`).bind(w.id, wydane),
          zdanieKrokSagi(db, w.id, "punkty", { email, memberId, punkty: wydane, wydanieNiepewne: false }, teraz),
          ...(saldoPo !== null ? [zdanieZapiszSaldo(db, email, saldoPo, teraz)] : []),
          zdanieStraznika(db, straznik, teraz),
        ]);

      // Poprzednia próba nie dostała odpowiedzi: historia karty mówi, ile naprawdę zeszło. Całość to wydanie
      // w liczbie z notatki (klient mógł w międzyczasie zmienić żądanie), a część to obcięcie, więc ją oddajemy.
      if (saga?.results.wydanieNiepewne) {
        const poprzednia = saga.results.wydanieId ?? idWydania(w.id, 1);
        const zadane = saga.results.punkty ?? punkty;
        const zeszlo = await zeszloWProbie(u, memberId, poprzednia);
        if (zeszlo === zadane) {
          await zapiszWydanie(zadane, null);
          if (zadane !== punkty) throw new BladDomenowy("PUNKTY_ZABLOKOWANE", { komunikat: opisZablokowanych(zadane) });
          return;
        }
        const saldoTeraz = await saldoKarty(db, u, email, memberId, teraz, "zapis");
        await oddajObciete(proba, poprzednia, zeszlo, saldoTeraz);
      }

      const saldo = await saldoKarty(db, u, email, memberId, teraz, "zapis");
      if (saldo < punkty) throw zaMaloPunktow(saldo, punkty);
      const numer = (saga?.results.wydaniaProby ?? 0) + 1;
      const wydanieId = idWydania(w.id, numer);
      await db.batch([
        zdanieWynikiSagi(db, w.id, { email, memberId, punkty, wydanieNiepewne: true, wydanieId, wydaniaProby: numer }, teraz),
        zdanieStraznika(db, straznik, teraz),
      ]);
      let wynik: ZmianaSalda;
      try {
        wynik = await wBudzecie(u, "zapis", () =>
          u.bramka.zmienSaldo(memberId, -punkty, { sourceId: wydanieId, powod: `Bilet: ${w.movie ?? "seans"}, rezerwacja ${w.id}` }),
        );
      } catch (blad) {
        // Odpowiedź dotarła i mówi „nie”: punkty na pewno nie zeszły.
        if (blad instanceof BladPunktow && !blad.niepewny) await zdanieWynikiSagi(db, w.id, { wydanieNiepewne: false }, teraz).run();
        throw blad;
      }
      const zeszlo = -wynik.zmiana;
      if (zeszlo === punkty) {
        await zapiszWydanie(punkty, wynik.saldo);
        return;
      }
      throw zaMaloPunktow(await oddajObciete(proba, wydanieId, zeszlo, wynik.saldo), punkty);
    });
  } catch (blad) {
    if (blad instanceof KontoZajete) {
      throw new BladDomenowy("PUNKTY_NIEDOSTEPNE", { komunikat: "Trwa inna operacja na Twoich punktach. Spróbuj za chwilę.", ponowZaS: 2 });
    }
    if (blad instanceof BladPunktow) {
      if (czyBrakPunktow(blad)) throw new BladDomenowy("ZA_MALO_PUNKTOW", { przyczyna: blad });
      console.error("Voucherify przy wydaniu punktów:", blad.message);
      throw new BladDomenowy("PUNKTY_NIEDOSTEPNE", { ponowZaS: blad.ponowZaS ?? 5, przyczyna: blad });
    }
    throw blad;
  }
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
  punktyZadane?: unknown,
): Promise<SesjaPlatnosci> {
  const w = await k.wBazie((db) => znajdzRezerwacje(db, reservationId));
  if (!w) throw new BladDomenowy("NIE_ZNALEZIONO", { komunikat: "Nie ma takiej rezerwacji." });
  const status = statusRezerwacji(w, k.teraz);
  if (status === "paid") throw new BladDomenowy("JUZ_OPLACONA");
  if (status === "expired") throw new BladDomenowy("WYGASLA");
  // Punkty ustala pierwszy udany checkout. Bez `points` działa jak w etapie II: ta sama sesja.
  const zadane = punktyZadane === undefined ? undefined : walidujPunkty(punktyZadane, w.amount);
  const ustalone = w.pointsUsed > 0 || w.stripeSessionUrl !== null;
  if (ustalone && zadane !== undefined && zadane !== w.pointsUsed) {
    throw new BladDomenowy("PUNKTY_ZABLOKOWANE", { komunikat: opisZablokowanych(w.pointsUsed) });
  }
  if (w.stripeSessionUrl) return { url: w.stripeSessionUrl };

  if (!k.bramka) {
    console.error("Brak STRIPE_SECRET_KEY: płatności wyłączone.");
    throw new BladDomenowy("PLATNOSCI_NIEDOSTEPNE", { ponowZaS: 30 });
  }
  const punkty = w.pointsUsed > 0 ? w.pointsUsed : (zadane ?? 0);
  await k.wBazie((db) =>
    zdanieRozpocznijSage(db, w.id, { adres: adresBazowy, ...(w.seatEmail ? { email: w.seatEmail } : {}) }, k.teraz).run(),
  );
  if (punkty > 0 && w.pointsUsed === 0) await wydajPunkty(k, w, punkty);

  let sesja: { id: string; url: string };
  try {
    sesja = await k.bramka.utworzSesje(parametrySesji(w, adresBazowy, punkty), kluczCheckoutu(w.id, punkty));
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
  // Kartą płaci się cenę pomniejszoną o punkty: tyle musi pokazać Stripe.
  const kwotaKarta = doZaplatyKarta(r.amount, r.pointsUsed);
  const kwotaZgodna = p.kwota === kwotaKarta && p.waluta === WALUTA;
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
        punktyZaZakup: punktyZaZakup(kwotaKarta),
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
