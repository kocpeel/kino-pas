// Reguły rezerwacji i zakupu. Bez Next.js i bez Cloudflare: baza przychodzi jako argument.

import * as miejsca from "../db/zapytania-miejsca";
import { BladDomenowy } from "./bledy";
import {
  czyPoprawneIdSeansu,
  czyPoprawnyKluczIdempotencji,
  KOMUNIKATY_POL,
  normalizujEmail,
  normalizujImie,
} from "./dane-klienta";
import type { KupionyBilet, UtworzonaRezerwacja, WejscieRezerwacji } from "./typy";
import { czyPoprawneMiejsce } from "./uklad-sali";

export {
  czyPoprawneIdRezerwacji,
  czyPoprawneIdSeansu,
  czyPoprawnyKluczIdempotencji,
  normalizujEmail,
  normalizujImie,
} from "./dane-klienta";

/** Waliduje i normalizuje dane wejściowe rezerwacji. Rzuca 400 z błędami pól. */
export function walidujRezerwacje(surowe: {
  eventId?: unknown;
  seatId?: unknown;
  name?: unknown;
  email?: unknown;
  idempotencyKey?: unknown;
}): WejscieRezerwacji {
  const bledy: Record<string, string> = {};
  if (!czyPoprawneIdSeansu(surowe.eventId)) bledy.eventId = "Nieznany seans.";
  if (!czyPoprawneMiejsce(surowe.seatId)) bledy.seatId = "Nie ma takiego fotela na tej sali.";
  const name = normalizujImie(surowe.name);
  if (name === null) bledy.name = KOMUNIKATY_POL.name;
  const email = normalizujEmail(surowe.email);
  if (email === null) bledy.email = KOMUNIKATY_POL.email;
  if (surowe.idempotencyKey !== undefined && !czyPoprawnyKluczIdempotencji(surowe.idempotencyKey)) {
    bledy.idempotencyKey = "Niepoprawny nagłówek Idempotency-Key (8–128 znaków: litery, cyfry, _ . : -).";
  }
  if (Object.keys(bledy).length > 0 || name === null || email === null) {
    throw new BladDomenowy("NIEPOPRAWNE_DANE", { szczegoly: bledy });
  }
  return {
    eventId: surowe.eventId as string,
    seatId: surowe.seatId as string,
    name,
    email,
    ...(surowe.idempotencyKey !== undefined ? { idempotencyKey: surowe.idempotencyKey as string } : {}),
  };
}

export interface OpcjeRezerwacji {
  teraz: number;
  ttlMs: number;
  limitNaEmail: number;
  noweId?: () => string;
}

export interface WynikRezerwacji {
  rezerwacja: UtworzonaRezerwacja;
  /** true, gdy to powtórka tego samego żądania (nic nie zapisano). */
  powtorka: boolean;
}

function powtorka(rezerwacja: UtworzonaRezerwacja): WynikRezerwacji {
  return { rezerwacja, powtorka: true };
}

export async function zarezerwuj(
  db: D1Database,
  wejscie: WejscieRezerwacji,
  opcje: OpcjeRezerwacji,
): Promise<WynikRezerwacji> {
  const klucz = wejscie.idempotencyKey ?? null;

  if (klucz) {
    const poprzednia = await poprzedniaRezerwacja(db, klucz, wejscie, opcje.teraz);
    if (poprzednia) return powtorka(poprzednia);
  }

  const reservationId = (opcje.noweId ?? (() => crypto.randomUUID()))();
  const expiresAt = opcje.teraz + opcje.ttlMs;

  let zapisano: boolean;
  try {
    zapisano = await miejsca.zarezerwujMiejsce(db, {
      eventId: wejscie.eventId,
      seatId: wejscie.seatId,
      reservationId,
      expiresAt,
      customerName: wejscie.name,
      email: wejscie.email,
      idempotencyKey: klucz,
      teraz: opcje.teraz,
      limitNaEmail: opcje.limitNaEmail,
    });
  } catch (blad) {
    // Równoległe żądanie z tym samym kluczem zapisało go pierwsze (na innym fotelu).
    if (klucz && miejsca.naruszonaUnikalnosc(blad) === "idempotencyKey") {
      const poprzednia = await poprzedniaRezerwacja(db, klucz, wejscie, opcje.teraz);
      if (poprzednia) return powtorka(poprzednia);
      throw new BladDomenowy("KLUCZ_UZYTY");
    }
    throw blad;
  }

  if (zapisano) return { rezerwacja: { reservationId, expiresAt }, powtorka: false };

  // 0 zmian. Najpierw: może to równoległa powtórka z tym samym kluczem, która wygrała.
  if (klucz) {
    const poprzednia = await poprzedniaRezerwacja(db, klucz, wejscie, opcje.teraz);
    if (poprzednia) return powtorka(poprzednia);
  }
  const stan = await miejsca.stanMiejsca(db, wejscie.eventId, wejscie.seatId);
  // Identyczne żądanie (ten sam seans, fotel, imię i e-mail) bez klucza albo z innym kluczem, gdy fotel trzyma
  // już ważna rezerwacja tego klienta: to podwójne kliknięcie albo ponowienie, więc oddajemy tę samą rezerwację.
  if (
    stan?.status === "reserved" &&
    stan.reservationId &&
    stan.expiresAt !== null &&
    stan.expiresAt > opcje.teraz &&
    stan.email === wejscie.email &&
    stan.customerName === wejscie.name
  ) {
    return powtorka({ reservationId: stan.reservationId, expiresAt: stan.expiresAt });
  }
  throw await przyczynaOdmowy(db, wejscie, opcje, stan);
}

/**
 * Szuka rezerwacji zapisanej pod tym kluczem. Ta sama (seans, fotel, e-mail) i nadal ważna
 * → zwraca ją. Inne dane → 422. Wygasła → null, czyli traktujemy jako nowe żądanie.
 */
async function poprzedniaRezerwacja(
  db: D1Database,
  klucz: string,
  wejscie: WejscieRezerwacji,
  teraz: number,
): Promise<UtworzonaRezerwacja | null> {
  const wiersz = await miejsca.znajdzPoKluczuIdempotencji(db, klucz);
  if (!wiersz) return null;
  const teSameDane =
    wiersz.eventId === wejscie.eventId && wiersz.seatId === wejscie.seatId && wiersz.email === wejscie.email;
  if (!teSameDane) throw new BladDomenowy("KLUCZ_UZYTY");
  if (wiersz.status === "reserved" && wiersz.reservationId && wiersz.expiresAt !== null && wiersz.expiresAt > teraz) {
    return { reservationId: wiersz.reservationId, expiresAt: wiersz.expiresAt };
  }
  if (wiersz.status === "purchased") {
    throw new BladDomenowy("ZAJETE", { komunikat: "Ta rezerwacja została już opłacona, bilet jest gotowy." });
  }
  return null;
}

/** Dobiera komunikat po nieudanym zapisie. Poprawność od tego odczytu nie zależy. */
async function przyczynaOdmowy(
  db: D1Database,
  wejscie: WejscieRezerwacji,
  opcje: OpcjeRezerwacji,
  stan: miejsca.StanMiejsca | null,
) {
  if (!stan) return new BladDomenowy("NIE_ZNALEZIONO", { komunikat: "Nie ma takiego seansu albo fotela." });
  const zajete =
    stan.status === "purchased" || (stan.status === "reserved" && stan.expiresAt !== null && stan.expiresAt > opcje.teraz);
  if (zajete) return new BladDomenowy("ZAJETE");
  if (opcje.limitNaEmail > 0) {
    const aktywne = await miejsca.aktywneRezerwacjeEmaila(db, wejscie.email, opcje.teraz);
    if (aktywne.liczba >= opcje.limitNaEmail) {
      const ponowZaS =
        aktywne.najwczesniejWygasa !== null
          ? Math.max(1, Math.ceil((aktywne.najwczesniejWygasa - opcje.teraz) / 1000))
          : undefined;
      return new BladDomenowy("LIMIT_REZERWACJI", { ponowZaS });
    }
  }
  // Stan zmienił się między zapisem a odczytem (ktoś zajął i zwolnił fotel w tej samej chwili).
  return new BladDomenowy("ZAJETE");
}

// ——— Zakup ———

const ALFABET_KODU = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford: bez I, L, O, U
const MAX_PROB_KODU = 5;

/** Losowy kod biletu w formacie XXXX-XXXX (40 bitów losowości). */
export function generujKodBiletu(losuj: (bufor: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  const bajty = losuj(new Uint8Array(8));
  let kod = "";
  for (let i = 0; i < 8; i++) {
    kod += ALFABET_KODU[(bajty[i] ?? 0) & 31];
    if (i === 3) kod += "-";
  }
  return kod;
}

export interface OpcjeZakupu {
  teraz: number;
  generujKod?: () => string;
}

export interface WynikZakupu {
  bilet: KupionyBilet;
  /** false, gdy bilet był już kupiony wcześniej (powtórzone żądanie) i zwracamy zapisany kod. */
  nowy: boolean;
}

export async function kupBilet(db: D1Database, reservationId: string, opcje: OpcjeZakupu): Promise<WynikZakupu> {
  const generujKod = opcje.generujKod ?? (() => generujKodBiletu());

  for (let proba = 1; ; proba++) {
    // Kod losujemy przed zapytaniem. Jeśli wygra inne, równoległe kliknięcie, ten kod przepada.
    const code = generujKod();
    try {
      if (await miejsca.kupMiejsce(db, { reservationId, code, teraz: opcje.teraz })) {
        return { bilet: { code }, nowy: true };
      }
      break;
    } catch (blad) {
      if (miejsca.naruszonaUnikalnosc(blad) === "code" && proba < MAX_PROB_KODU) continue;
      throw blad;
    }
  }

  const wiersz = await miejsca.znajdzPoRezerwacji(db, reservationId);
  if (wiersz?.status === "purchased" && wiersz.code) {
    return { bilet: { code: wiersz.code }, nowy: false };
  }
  // Brak wiersza = wygasła i fotel ma już nową rezerwację albo nigdy nie istniała. Ta sama odmowa.
  throw new BladDomenowy("WYGASLA");
}
