// Etap IV, karty A i B: lista oczekujących na wyprzedane wydarzenie.
//
// Karta A: zapis (POST /api/events/:id/waitlist), stan i miejsce w kolejce (GET /api/waitlist/:id), wypisanie
// (DELETE). Karta B: gdy miejsce się zwolni, pierwsza osoba z kolejki dostaje je jako zwykłą rezerwację z etapu I
// (reservationId, expiresAt = teraz + TTL), a gdy nie zapłaci na czas albo mail do niej nie dojdzie, miejsce
// dostaje następna osoba.
//
// Kiedy kolejka się przesuwa: „leniwie”, przy każdym odczycie i rezerwacji na tej sali (jak wygasanie rezerwacji
// z etapu I), a bez ruchu w sklepie przez job `lista-kolejka` nastawiony na najbliższe wygaśnięcie: wykonuje go
// budzik outboxu w terminie, a w ostateczności Cron. Przesunięcie jest idempotentne i bezpieczne równolegle.

import {
  aktywnyZapisKlienta,
  czekajacy,
  czyPowtorzonyZapis,
  pozycjaWKolejce,
  wolneMiejsca,
  wyprzedanie,
  zaoferuj,
  zapisListy,
  zaplanujKolejke,
  zdaniaOdrzucOferte,
  zdaniaZamknijOferty,
  zdanieNowyZapis,
  type WierszZapisu,
} from "../db/zapytania-listy";
import { BladDomenowy } from "./bledy";
import { czyPoprawneIdRezerwacji, czyPoprawneIdSeansu, KOMUNIKATY_POL, normalizujEmail, normalizujImie } from "./dane-klienta";
import type { StanZapisuNaListe, ZapisNaListe } from "./typy";

export interface OpcjeListy {
  teraz: number;
  /** Jak długo miejsce czeka na osobę z listy: tyle co zwykła rezerwacja (RESERVATION_TTL_SECONDS). */
  ttlMs: number;
  noweId?: () => string;
}

export interface WejscieZapisu {
  eventId: string;
  email: string;
  customerName: string;
  /** Adres sklepu (origin żądania): link w mailu z ofertą. */
  adres: string;
}

/** Najwięcej ofert w jednym przesunięciu: tyle naraz zwalnia się najwyżej przy dużej sali. */
const MAX_OFERT_NARAZ = 20;

export function walidujZapis(eventId: string, cialo: Record<string, unknown>, adres: string): WejscieZapisu {
  if (!czyPoprawneIdSeansu(eventId)) throw new BladDomenowy("NIE_ZNALEZIONO", { komunikat: "Nie ma takiego wydarzenia." });
  const bledy: Record<string, string> = {};
  const email = normalizujEmail(cialo.email);
  if (email === null) bledy.email = KOMUNIKATY_POL.email;
  // Kontrakt: `customerName`; jak w rezerwacji przyjmujemy też dawne `name`.
  const surowe = cialo.customerName !== undefined || cialo.name === undefined ? cialo.customerName : cialo.name;
  const customerName = normalizujImie(surowe);
  if (customerName === null) bledy[cialo.customerName !== undefined || cialo.name === undefined ? "customerName" : "name"] = KOMUNIKATY_POL.name;
  if (email === null || customerName === null) throw new BladDomenowy("NIEPOPRAWNE_DANE", { szczegoly: bledy });
  return { eventId, email, customerName, adres };
}

export function wymagajIdZapisu(id: string): void {
  if (!czyPoprawneIdRezerwacji(id)) {
    throw new BladDomenowy("NIEPOPRAWNE_DANE", { komunikat: "Niepoprawny identyfikator zapisu na listę." });
  }
}

export interface WynikPrzesuniecia {
  /** Rezerwacje z nowych ofert: ich maile warto wysłać od razu, a mapę sali odświeżyć. */
  oferty: string[];
  /** Następne sprawdzenie kolejki (najbliższe wygaśnięcie, gdy ktoś czeka); null = nie trzeba. */
  nastepnyTermin: number | null;
}

/**
 * Karta B: zamyka skończone oferty (kupione → done, minione → missed) i oddaje wolne fotele kolejnym
 * czekającym. Oferta powstaje w jednej transakcji tylko, gdy fotel był do wzięcia i osoba nadal czekała.
 */
export async function przesunKolejke(db: D1Database, eventId: string, o: OpcjeListy): Promise<WynikPrzesuniecia> {
  await db.batch(zdaniaZamknijOferty(db, eventId, o.teraz));
  const oferty: string[] = [];
  const osoby = await czekajacy(db, eventId, MAX_OFERT_NARAZ);
  if (osoby.length > 0) {
    const fotele = await wolneMiejsca(db, eventId, o.teraz, osoby.length);
    const noweId = o.noweId ?? (() => crypto.randomUUID());
    let i = 0;
    for (const seatId of fotele) {
      while (i < osoby.length) {
        const zapis = osoby[i] as WierszZapisu;
        const reservationId = noweId();
        if (await zaoferuj(db, { zapis, seatId, reservationId, expiresAt: o.teraz + o.ttlMs, teraz: o.teraz })) {
          oferty.push(reservationId);
          i++;
          break;
        }
        // Nie wyszło. Osoba nadal czeka → fotel ktoś właśnie wziął: ta sama osoba, następny fotel.
        // Osoba już nie czeka (wypisała się albo dostała ofertę równolegle) → następna osoba, ten sam fotel.
        const teraz = await zapisListy(db, zapis.id);
        if (teraz?.status === "waiting") break;
        i++;
      }
    }
  }
  const nastepnyTermin = await zaplanujKolejke(db, eventId, o.ttlMs, o.teraz);
  return { oferty, nastepnyTermin };
}

function opisStanu(zapis: WierszZapisu, pozycja: number): StanZapisuNaListe {
  const stan: StanZapisuNaListe = { status: zapis.status, position: zapis.status === "waiting" ? pozycja : 0 };
  if (zapis.reservationId && zapis.status !== "left" && zapis.offerExpiresAt !== null) {
    stan.reservationId = zapis.reservationId;
    stan.offerExpiresAt = zapis.offerExpiresAt;
    if (zapis.seatId) stan.seatId = zapis.seatId;
  }
  return stan;
}

async function stanZWiersza(db: D1Database, zapis: WierszZapisu): Promise<StanZapisuNaListe> {
  return opisStanu(zapis, zapis.status === "waiting" ? await pozycjaWKolejce(db, zapis) : 0);
}

export interface WynikZapisu {
  zapis: ZapisNaListe;
  /** false = klient już był na liście: oddajemy ten sam zapis (idempotentnie). */
  nowy: boolean;
  oferty: string[];
}

/**
 * Karta A: zapis na listę. Najpierw kolejka (zwolnione miejsca należą się czekającym), potem decyzja, czy jest
 * wyprzedane. Ten sam klient drugi raz dostaje ten sam zapis, także przy dwóch równoległych żądaniach.
 */
export async function zapiszNaListe(db: D1Database, w: WejscieZapisu, o: OpcjeListy): Promise<WynikZapisu> {
  const { oferty } = await przesunKolejke(db, w.eventId, o);
  const zZapisu = async (zapis: WierszZapisu, nowy: boolean): Promise<WynikZapisu> => ({
    zapis: { waitlistId: zapis.id, position: (await stanZWiersza(db, zapis)).position },
    nowy,
    oferty,
  });

  const istniejacy = await aktywnyZapisKlienta(db, w.eventId, w.email);
  if (istniejacy) return zZapisu(istniejacy, false);
  const sala = await wyprzedanie(db, w.eventId, o.teraz);
  if (!sala) throw new BladDomenowy("NIE_ZNALEZIONO", { komunikat: "Nie ma takiego wydarzenia." });
  if (!sala.wyprzedane) throw new BladDomenowy("NIE_WYPRZEDANE");

  const id = (o.noweId ?? (() => crypto.randomUUID()))();
  try {
    await zdanieNowyZapis(db, { id, eventId: w.eventId, email: w.email, customerName: w.customerName, adres: w.adres, teraz: o.teraz }).run();
  } catch (blad) {
    // Równoległy zapis tego samego klienta zdążył pierwszy.
    if (czyPowtorzonyZapis(blad)) {
      const rownolegly = await aktywnyZapisKlienta(db, w.eventId, w.email);
      if (rownolegly) return zZapisu(rownolegly, false);
    }
    throw blad;
  }
  // Teraz ktoś czeka: sprawdzenie kolejki na najbliższe wygaśnięcie rezerwacji na tej sali.
  await zaplanujKolejke(db, w.eventId, o.ttlMs, o.teraz);
  const zapis = await zapisListy(db, id);
  if (!zapis) throw new Error("Zapis na listę zniknął zaraz po utworzeniu.");
  return zZapisu(zapis, true);
}

export interface WynikStanu {
  stan: StanZapisuNaListe;
  eventId: string;
  oferty: string[];
}

/** Karta A/B: stan zapisu. Najpierw przesuwa kolejkę jego wydarzenia, więc status jest zawsze aktualny. */
export async function stanZapisu(db: D1Database, waitlistId: string, o: OpcjeListy): Promise<WynikStanu> {
  wymagajIdZapisu(waitlistId);
  let zapis = await zapisListy(db, waitlistId);
  if (!zapis) throw new BladDomenowy("NIE_ZNALEZIONO", { komunikat: "Nie ma takiego zapisu na listę." });
  let oferty: string[] = [];
  if (zapis.status !== "left" && zapis.status !== "done") {
    oferty = (await przesunKolejke(db, zapis.eventId, o)).oferty;
    zapis = (await zapisListy(db, waitlistId)) ?? zapis;
  }
  return { stan: await stanZWiersza(db, zapis), eventId: zapis.eventId, oferty };
}

/**
 * Karta A: wypisanie. Czekający po prostu wychodzi z kolejki. Osoba z ofertą oddaje miejsce: jej rezerwacja
 * wygasa teraz (wydane punkty odda strażnik sesji), a miejsce od razu dostaje następna osoba. Po zakupie
 * nie ma z czego się wypisać (409). Wypisany albo pominięty: 200 bez zmian.
 */
export async function wypiszZListy(db: D1Database, waitlistId: string, o: OpcjeListy): Promise<WynikStanu> {
  wymagajIdZapisu(waitlistId);
  const przed = await zapisListy(db, waitlistId);
  if (!przed) throw new BladDomenowy("NIE_ZNALEZIONO", { komunikat: "Nie ma takiego zapisu na listę." });
  // Oferta mogła się właśnie skończyć (kupiona albo minęła): najpierw aktualny stan.
  await db.batch(zdaniaZamknijOferty(db, przed.eventId, o.teraz));
  for (let proba = 0; proba < 2; proba++) {
    const zapis = await zapisListy(db, waitlistId);
    if (!zapis) break;
    if (zapis.status === "done") throw new BladDomenowy("LISTA_ZAKONCZONA");
    if (zapis.status === "waiting") {
      const wynik = await db
        .prepare(`UPDATE waitlist SET status = 'left', updatedAt = ?2 WHERE id = ?1 AND status = 'waiting'`)
        .bind(waitlistId, o.teraz)
        .run();
      if (wynik.meta.changes === 1) break;
      continue; // W międzyczasie dostał ofertę: druga próba wypisze go razem z nią.
    }
    if (zapis.status === "offered") {
      await db.batch(zdaniaOdrzucOferte(db, { waitlistId, nowyStatus: "left", ttlMs: o.ttlMs, teraz: o.teraz, eventId: zapis.eventId }));
      break;
    }
    break; // left albo missed: nic do zmiany
  }
  const { oferty } = await przesunKolejke(db, przed.eventId, o);
  const zapis = (await zapisListy(db, waitlistId)) ?? przed;
  if (zapis.status === "done") throw new BladDomenowy("LISTA_ZAKONCZONA");
  return { stan: await stanZWiersza(db, zapis), eventId: zapis.eventId, oferty };
}
