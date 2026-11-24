// Worker outboxu: claim → wywołanie cudzego systemu → ack. Uruchamiają go budzik outboxu (Durable Object z alarmem
// na najbliższy job), żądania (od razu po zdarzeniu albo leniwie przy odczycie) i Cron co minutę jako siatka.
// Outbox gwarantuje, że wiadomość wyjdzie co najmniej raz (≥1), a duplikat u dostawcy rozpoznaje
// klucz idempotencji wzięty z joba (Stripe, Resend) albo historia karty (Voucherify nie ma kluczy).
// Dostawca nie odpowiada? Job wróci po backoffie. Ciągle odmawia? Po limicie prób idzie do DLQ.
//
// Etap III: tu są kroki sagi zakupu, które idą po bilecie, i kompensacje (E08):
//   punkty-naliczenie     krok tylko do przodu: punkty za zakup na kartę klienta
//   mail-bilet            krok tylko do przodu, świadome ≥1: mail z biletem i podsumowaniem
//   stripe-refund         kompensacja płatności: zwrot na kartę
//   punkty-zwrot          kompensacja wydania punktów: punkty wracają na kartę
//   stripe-session-watch  strażnik: rozlicza zgubione webhooki, wygasza sesję po czasie i uruchamia kompensację
//
// Etap IV (lista oczekujących):
//   lista-kolejka         karta B: zwolnione miejsca dla kolejnych osób z kolejki, koniec ofert
//   mail-oferta           karta C: mail z ofertą; trwała odmowa Resend = oferta odpada, kolejka idzie dalej

import type { Zegar } from "../czas";
import {
  jobDoDlq,
  odlozJob,
  oznaczNieudanePunkty,
  oznaczNieudanyMail,
  oznaczNieudanyZwrot,
  ponowJob,
  potwierdzJob,
  potwierdzZwrot,
  wezJob,
  wezJobPoId,
  zdanieAck,
  type JobOutboxu,
} from "../db/zapytania-outbox";
import {
  TASK_MAIL,
  TASK_NALICZENIE,
  TASK_ODDANIE_PUNKTOW,
  zdaniaOddaniaPunktow,
  znajdzRezerwacje,
  type WierszRezerwacji,
} from "../db/zapytania-platnosci";
import {
  sagaZakupu,
  zdanieKrokSagi,
  zdanieSkompensowana,
  zdanieWynikiSagi,
  zdanieZakonczKompensacje,
  zdanieZakonczSageJesliGotowa,
  zdanieZapiszSaldo,
  type WynikiSagi,
} from "../db/zapytania-punktow";
import {
  TASK_KOLEJKA,
  TASK_MAIL_OFERTY,
  zapisListy,
  zdaniaOdrzucOferte,
  zdanieMailOfertyWyslany,
} from "../db/zapytania-listy";
import { BladMaila, type BramkaMaili } from "../maile/resend";
import { mailBiletu } from "../maile/szablon-biletu";
import { mailOferty } from "../maile/szablon-oferty";
import { BladPunktow } from "../punkty/voucherify";
import {
  czyBylaOperacja,
  idWydania,
  KontoZajete,
  wBudzecie,
  zapewnijKarte,
  zeszloWProbie,
  zWylacznoscia,
  type UslugaPunktow,
} from "./konto-punktowe";
import { przesunKolejke } from "./lista-oczekujacych";
import {
  CO_ILE_STRAZNIK_MS,
  rozliczPlatnosc,
  statusRezerwacji,
  TASK_STRAZNIK_SESJI,
  TASK_ZWROT,
  type BramkaPlatnosci,
} from "./platnosc";

/** Worker może paść w trakcie: wtedy job wróci sam po tym czasie. */
const NIEWIDOCZNY_W_TRAKCIE_MS = 5 * 60_000;
/** Razem z backoffem to około 3 godziny prób: awaria dostawcy musi potrwać, żeby job trafił do DLQ. */
export const MAX_PROB = 8;
const BAZA_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
/** Ochrona przed limitem żądań na jedno uruchomienie Workera. Reszta poczeka minutę, do następnego Crona. */
const DOMYSLNY_LIMIT_JOBOW = 15;
/** Brak klucza usługi to nie porażka joba: czeka, aż sekret zostanie ustawiony. */
const CZEKAJ_NA_KONFIGURACJE_MS = 10 * 60_000;
/** Na punktach klienta trwa inna operacja (np. checkout): spróbujemy za chwilę. */
const CZEKAJ_NA_KONTO_MS = 10_000;

export function opoznieniePonowienia(totalTried: number): number {
  return Math.min(MAX_BACKOFF_MS, BAZA_BACKOFF_MS * 2 ** Math.max(0, totalTried - 1));
}

/** Błąd, którego ponawianie nic nie zmieni, np. nieznany task. */
class BladTrwaly extends Error {}

/** Usługa nie jest skonfigurowana (brak klucza): job czeka, nic nie przepada. */
class BrakUslugi extends Error {}

export interface UslugiOutboxu {
  platnosci?: BramkaPlatnosci | undefined;
  punkty?: UslugaPunktow | undefined;
  maile?: BramkaMaili | undefined;
}

function wymagaj<T>(usluga: T | undefined, nazwa: string): T {
  if (!usluga) throw new BrakUslugi(`${nazwa} nie jest skonfigurowany.`);
  return usluga;
}

function czytajDane<T extends Record<string, string>>(job: JobOutboxu, pola: (keyof T)[]): T {
  let dane: unknown;
  try {
    dane = JSON.parse(job.input);
  } catch {
    throw new BladTrwaly("Niepoprawny JSON w polu input.");
  }
  for (const pole of pola) {
    if (typeof (dane as Record<keyof T, unknown> | null)?.[pole] !== "string") {
      throw new BladTrwaly(`Brak pola ${String(pole)} w input.`);
    }
  }
  return dane as T;
}

type Wynik = { rodzaj: "gotowe" } | { rodzaj: "odlozony"; doKiedy: number };
const GOTOWE: Wynik = { rodzaj: "gotowe" };

/** 🔑 Klucz z joba: ten sam przy każdej próbie, więc Stripe zrobi jeden zwrot. */
async function wykonajZwrot(db: D1Database, u: UslugiOutboxu, job: JobOutboxu, teraz: number): Promise<Wynik> {
  const { paymentIntentId, reservationId } = czytajDane<{ paymentIntentId: string; reservationId: string }>(job, [
    "paymentIntentId",
    "reservationId",
  ]);
  await wymagaj(u.platnosci, "Stripe").zwrocPlatnosc(paymentIntentId, job.id, reservationId);
  await potwierdzZwrot(db, job.id, reservationId, teraz);
  return GOTOWE;
}

/**
 * Rezerwacja wygasła, a sesji nie da się już opłacić (wygaszona albo nigdy nie powstała): kompensujemy
 * to, co się udało. Pieniędzy nie ma do oddania, ale wydane punkty tak. Niepewne wydanie (bez odpowiedzi
 * od Voucherify) też: job oddania sam sprawdzi historię karty.
 */
async function kompensujBezPlatnosci(db: D1Database, r: WierszRezerwacji, teraz: number): Promise<void> {
  const saga = await sagaZakupu(db, r.id);
  // Sesja powstała, a płatność nie przyszła na czas: nie udał się bilet (jak przy płatności po czasie).
  // Sesja nie powstała (np. Stripe nie działał): nie udała się płatność.
  const failedStep = saga?.completed.includes("platnosc") ? "bilet" : "platnosc";
  const niepewne = r.pointsUsed === 0 && saga?.results.wydanieNiepewne === true;
  if (r.pointsUsed > 0 || niepewne) {
    await db.batch(zdaniaOddaniaPunktow(db, r.id, teraz, failedStep, niepewne));
  } else if (saga) {
    // Przed porażką nie udało się nic, co trzeba by cofać (sesja bez punktów wygasła bez płatności).
    await zdanieSkompensowana(db, r.id, failedStep, teraz).run();
  }
}

/**
 * Strażnik sesji: pilnuje rzeczy, na które nie ma zdarzenia od Stripe'a.
 * Webhook zaginął (Stripe nie ponowi w nieskończoność), więc sami pytamy o stan sesji i rozliczamy płatność.
 * Rezerwacja wygasła, a sesja nadal jest otwarta (minimum 30 minut), więc ją wygaszamy, żeby nikt nie zapłacił
 * za fotel, którego już nie ma, i kompensujemy wydane punkty. Gdy klient zdąży przed wygaszeniem, płatność
 * wróci do niego (zwrot), a punkty razem z nią (`rozliczPlatnosc`).
 * Strażnik powstaje już przy wydaniu punktów, więc pilnuje też rezerwacji, dla której sesja nie powstała.
 */
async function pilnujSesji(db: D1Database, u: UslugiOutboxu, job: JobOutboxu, teraz: number): Promise<Wynik> {
  const { reservationId } = czytajDane<{ reservationId: string }>(job, ["reservationId"]);
  const rezerwacja = await znajdzRezerwacje(db, reservationId);
  if (!rezerwacja || statusRezerwacji(rezerwacja, teraz) === "paid") {
    await potwierdzJob(db, job.id, teraz);
    return GOTOWE;
  }
  const sessionId = rezerwacja.stripeSessionId ?? (JSON.parse(job.input) as { sessionId?: string }).sessionId ?? null;
  if (sessionId) {
    const bramka = wymagaj(u.platnosci, "Stripe");
    const sesja = await bramka.pobierzSesje(sessionId);
    if (sesja.oplacona && sesja.paymentIntentId) {
      await rozliczPlatnosc(db, rezerwacja, {
        paymentIntentId: sesja.paymentIntentId,
        kwota: sesja.kwota,
        waluta: sesja.waluta,
        paidAt: sesja.oplaconoO ?? teraz,
        teraz,
      });
      await potwierdzJob(db, job.id, teraz);
      return GOTOWE;
    }
    if (sesja.status === "open") {
      if (teraz < rezerwacja.expiresAt) {
        return { rodzaj: "odlozony", doKiedy: Math.min(teraz + CO_ILE_STRAZNIK_MS, rezerwacja.expiresAt) };
      }
      await bramka.wygasSesje(sessionId);
    }
  } else if (teraz < rezerwacja.expiresAt) {
    return { rodzaj: "odlozony", doKiedy: rezerwacja.expiresAt };
  }
  await kompensujBezPlatnosci(db, rezerwacja, teraz);
  await potwierdzJob(db, job.id, teraz);
  return GOTOWE;
}

/**
 * Operacja na punktach w kroku sagi, z notatką „niepewne” zapisaną przed wywołaniem. Gdy notatka została
 * z poprzedniej próby, najpierw sprawdzamy historię karty: Voucherify nie zna naszych kluczy idempotencji,
 * więc to jedyny sposób, żeby punkty nie weszły dwa razy. Zwraca saldo po zmianie albo null (już była).
 */
async function operacjaNaPunktach(
  db: D1Database,
  usluga: UslugaPunktow,
  p: {
    reservationId: string;
    memberId: string;
    punkty: number;
    sourceId: string;
    powod: string;
    notatka: "naliczenieNiepewne" | "oddanieNiepewne";
    poprzedniaNiepewna: boolean;
    teraz: number;
  },
): Promise<number | null> {
  if (p.poprzedniaNiepewna && (await czyBylaOperacja(usluga, p.memberId, p.sourceId))) {
    return null;
  }
  await zdanieWynikiSagi(db, p.reservationId, { [p.notatka]: true }, p.teraz).run();
  try {
    return (await wBudzecie(usluga, "zapis", () => usluga.bramka.zmienSaldo(p.memberId, p.punkty, { sourceId: p.sourceId, powod: p.powod })))
      .saldo;
  } catch (blad) {
    // Odpowiedź dotarła i mówi „nie”: nic się nie zmieniło.
    if (!(blad instanceof BladPunktow) || !blad.niepewny) await zdanieWynikiSagi(db, p.reservationId, { [p.notatka]: false }, p.teraz).run();
    throw blad;
  }
}

/** Krok sagi po bilecie: punkty za zakup na kartę klienta (nowemu zakłada ją z punktami powitalnymi). */
async function naliczPunkty(db: D1Database, u: UslugiOutboxu, zegar: Zegar, job: JobOutboxu, teraz: number): Promise<Wynik> {
  const { reservationId } = czytajDane<{ reservationId: string }>(job, ["reservationId"]);
  const r = await znajdzRezerwacje(db, reservationId);
  const punkty = r?.pointsEarned ?? 0;
  if (!r || statusRezerwacji(r, teraz) !== "paid" || r.pointsStatus === "done" || punkty === 0) {
    await db.batch([
      zdanieAck(db, job.id, teraz),
      db.prepare(`UPDATE reservations SET pointsStatus = 'done' WHERE id = ?1 AND pointsStatus = 'pending'`).bind(reservationId),
      zdanieKrokSagi(db, reservationId, "naliczenie", { naliczenie: "done" }, teraz),
      zdanieZakonczSageJesliGotowa(db, reservationId, teraz),
    ]);
    return GOTOWE;
  }
  const usluga = wymagaj(u.punkty, "Voucherify");
  const email = r.seatEmail;
  if (!email) throw new BladTrwaly("Brak e-maila klienta: nie ma komu dopisać punktów.");
  return zWylacznoscia(db, email, zegar, 0, async () => {
    const karta = await zapewnijKarte(db, usluga, email, teraz);
    const saga = await sagaZakupu(db, reservationId);
    const saldo = await operacjaNaPunktach(db, usluga, {
      reservationId,
      memberId: karta.memberId,
      punkty,
      sourceId: `naliczenie:${reservationId}`,
      powod: `Punkty za zakup biletu, rezerwacja ${reservationId}`,
      notatka: "naliczenieNiepewne",
      poprzedniaNiepewna: saga?.results.naliczenieNiepewne === true,
      teraz,
    });
    const wyniki: WynikiSagi = { naliczenie: "done", naliczenieNiepewne: false, memberId: karta.memberId };
    await db.batch([
      zdanieAck(db, job.id, teraz),
      db.prepare(`UPDATE reservations SET pointsStatus = 'done' WHERE id = ?1`).bind(reservationId),
      ...(saldo !== null ? [zdanieZapiszSaldo(db, email, saldo, teraz)] : []),
      zdanieKrokSagi(db, reservationId, "naliczenie", wyniki, teraz),
      zdanieZakonczSageJesliGotowa(db, reservationId, teraz),
    ]);
    return GOTOWE;
  });
}

/** ↩️ Kompensacja kroku „punkty”: wydane punkty wracają na kartę, bo bilet nie powstał. */
async function oddajPunkty(db: D1Database, u: UslugiOutboxu, zegar: Zegar, job: JobOutboxu, teraz: number): Promise<Wynik> {
  const { reservationId } = czytajDane<{ reservationId: string }>(job, ["reservationId"]);
  const r = await znajdzRezerwacje(db, reservationId);
  const saga = await sagaZakupu(db, reservationId);
  const memberId = saga?.results.memberId;
  const email = saga?.results.email ?? r?.seatEmail ?? null;
  let punkty = r?.pointsUsed || saga?.results.punkty || 0;
  const zakoncz = () =>
    db.batch([
      zdanieAck(db, job.id, teraz),
      db.prepare(`UPDATE reservations SET pointsStatus = 'done' WHERE id = ?1 AND pointsUsed > 0`).bind(reservationId),
      zdanieZakonczKompensacje(db, reservationId, teraz),
    ]);
  // Bilet jednak jest (np. płatność na czas rozliczona później): punktów nie oddajemy.
  if (!r || statusRezerwacji(r, teraz) === "paid") {
    await potwierdzJob(db, job.id, teraz);
    return GOTOWE;
  }
  // Wydanie nie dotarło do Voucherify: nie ma czego oddawać.
  if (!memberId || !email || punkty === 0) {
    await zakoncz();
    return GOTOWE;
  }
  const usluga = wymagaj(u.punkty, "Voucherify");
  return zWylacznoscia(db, email, zegar, 0, async () => {
    // Wydanie było niepewne: ile punktów naprawdę zeszło (mogło nic, mogło mniej, gdy Voucherify je obciął,
    // a korekta mogła już część oddać)? Oddajemy tylko to, co zostało zdjęte.
    if (r.pointsUsed === 0) {
      punkty = await zeszloWProbie(usluga, memberId, saga?.results.wydanieId ?? idWydania(reservationId, 1));
      if (punkty === 0) {
        await zakoncz();
        return GOTOWE;
      }
    }
    const saldo = await operacjaNaPunktach(db, usluga, {
      reservationId,
      memberId,
      punkty,
      sourceId: `zwrot:${reservationId}`,
      powod: `Zwrot punktów: rezerwacja ${reservationId} bez biletu`,
      notatka: "oddanieNiepewne",
      poprzedniaNiepewna: saga?.results.oddanieNiepewne === true,
      teraz,
    });
    await db.batch([
      zdanieAck(db, job.id, teraz),
      db.prepare(`UPDATE reservations SET pointsStatus = 'done' WHERE id = ?1`).bind(reservationId),
      ...(saldo !== null ? [zdanieZapiszSaldo(db, email, saldo, teraz)] : []),
      zdanieWynikiSagi(db, reservationId, { oddanieNiepewne: false }, teraz),
      zdanieZakonczKompensacje(db, reservationId, teraz),
    ]);
    return GOTOWE;
  });
}

/**
 * Krok sagi po bilecie: mail z biletem i podsumowaniem. ⚖️ Świadome ≥1: Resend pamięta klucz idempotencji
 * 24 h, a joby żyją krócej, więc ponowienie nie wyśle drugiego maila. Wysłanego maila nie da się cofnąć,
 * dlatego to ostatni krok sagi. Trwała odmowa (adres spoza dozwolonych w sandboksie) nie psuje zakupu:
 * bilet jest na stronie, a strona mówi, że mail nie wyszedł.
 */
async function wyslijMail(db: D1Database, u: UslugiOutboxu, job: JobOutboxu, teraz: number): Promise<Wynik> {
  const { reservationId } = czytajDane<{ reservationId: string }>(job, ["reservationId"]);
  const r = await znajdzRezerwacje(db, reservationId);
  if (!r || statusRezerwacji(r, teraz) !== "paid" || !r.code || (r.emailStatus !== null && r.emailStatus !== "pending")) {
    await potwierdzJob(db, job.id, teraz);
    return GOTOWE;
  }
  const maile = wymagaj(u.maile, "Resend");
  if (!r.seatEmail) throw new BladTrwaly("Brak e-maila klienta.");
  const saga = await sagaZakupu(db, reservationId);
  const zapytanie = `seans=${encodeURIComponent(r.eventId)}&miejsce=${encodeURIComponent(r.seatId)}`;
  const mail = mailBiletu({
    email: r.seatEmail,
    imie: r.customerName ?? "",
    kod: r.code,
    film: r.movie,
    startsAt: r.startsAt,
    sala: r.hall,
    seatId: r.seatId,
    kwotaKarta: r.amount - r.pointsUsed,
    punktyUzyte: r.pointsUsed,
    punktyZebrane: r.pointsEarned ?? 0,
    adresBiletu: saga?.results.adres ? `${saga.results.adres}/bilet/${reservationId}?${zapytanie}` : null,
    reservationId,
  });
  let status: "sent" | "failed";
  let emailId: string | null = null;
  try {
    emailId = (await maile.wyslij(mail, `bilet/${reservationId}`)).id;
    status = "sent";
  } catch (blad) {
    if (!(blad instanceof BladMaila) || blad.rodzaj !== "trwaly") throw blad;
    console.warn(JSON.stringify({ ostrzezenie: "kasa-kino", poziom: "mail-odrzucony", reservationId, powod: blad.message }));
    status = "failed";
  }
  await db.batch([
    zdanieAck(db, job.id, teraz),
    db.prepare(`UPDATE reservations SET emailStatus = ?2, emailId = ?3 WHERE id = ?1`).bind(reservationId, status, emailId),
    zdanieKrokSagi(db, reservationId, "mail", { mail: status }, teraz),
    zdanieZakonczSageJesliGotowa(db, reservationId, teraz),
  ]);
  return GOTOWE;
}

function czytajKolejke(job: JobOutboxu): { eventId: string; ttlMs: number } {
  const { eventId } = czytajDane<{ eventId: string }>(job, ["eventId"]);
  const ttlMs = (JSON.parse(job.input) as { ttlMs?: unknown }).ttlMs;
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs <= 0) throw new BladTrwaly("Brak ttlMs w input.");
  return { eventId, ttlMs };
}

/**
 * Karta B etapu IV: sprawdzenie kolejki listy oczekujących na najbliższe wygaśnięcie rezerwacji na sali. Nowe oferty
 * mają już swój job maila (ta sama transakcja), więc ten sam przebieg outboxu je wyśle. Gdy ktoś nadal czeka, job
 * odkłada się na następne wygaśnięcie zamiast się kończyć.
 */
async function sprawdzKolejke(db: D1Database, job: JobOutboxu, teraz: number): Promise<Wynik> {
  const { eventId, ttlMs } = czytajKolejke(job);
  const { nastepnyTermin } = await przesunKolejke(db, eventId, { teraz, ttlMs });
  if (nastepnyTermin !== null && nastepnyTermin > teraz) return { rodzaj: "odlozony", doKiedy: nastepnyTermin };
  await potwierdzJob(db, job.id, teraz);
  return GOTOWE;
}

/**
 * Karta C etapu IV: mail z ofertą (wydarzenie, miejsce, link do zapłaty, godzina, do której miejsce czeka).
 * ⚖️ Świadome ≥1 jak mail z biletem: `Idempotency-Key: oferta/<rezerwacja>`. Oferta, która w międzyczasie się
 * skończyła, maila już nie dostaje. Trwała odmowa Resend (np. adres spoza sandboksa) znaczy „mail nie dojdzie”:
 * tak jak odbity mail z webhooka, oferta przechodzi na następną osobę (karta C daje znać karcie B).
 */
async function wyslijMailOferty(db: D1Database, u: UslugiOutboxu, job: JobOutboxu, teraz: number): Promise<Wynik> {
  const { waitlistId, reservationId } = czytajDane<{ waitlistId: string; reservationId: string }>(job, ["waitlistId", "reservationId"]);
  const ttlMs = Number((JSON.parse(job.input) as { ttlMs?: unknown }).ttlMs) || 15 * 60_000;
  const zapis = await zapisListy(db, waitlistId);
  if (!zapis || zapis.status !== "offered" || zapis.reservationId !== reservationId || !zapis.seatId || (zapis.offerExpiresAt ?? 0) <= teraz) {
    await potwierdzJob(db, job.id, teraz);
    return GOTOWE;
  }
  const maile = wymagaj(u.maile, "Resend");
  const seans = await db
    .prepare(`SELECT movie, startsAt, hall, price FROM events WHERE id = ?1`)
    .bind(zapis.eventId)
    .first<{ movie: string; startsAt: string; hall: string; price: number }>();
  const adres = zapis.adres ?? "";
  const zapytanie = `seans=${encodeURIComponent(zapis.eventId)}&miejsce=${encodeURIComponent(zapis.seatId)}`;
  const mail = mailOferty({
    email: zapis.email,
    imie: zapis.customerName,
    film: seans?.movie ?? null,
    startsAt: seans?.startsAt ?? null,
    sala: seans?.hall ?? null,
    seatId: zapis.seatId,
    cena: seans?.price ?? 0,
    czekaDo: zapis.offerExpiresAt as number,
    adresPlatnosci: `${adres}/rezerwacja/${reservationId}?${zapytanie}`,
    adresListy: adres ? `${adres}/lista/${waitlistId}` : null,
  });
  try {
    const { id } = await maile.wyslij(mail, `oferta/${reservationId}`);
    await db.batch([zdanieAck(db, job.id, teraz), zdanieMailOfertyWyslany(db, waitlistId, reservationId, id)]);
  } catch (blad) {
    if (!(blad instanceof BladMaila) || blad.rodzaj !== "trwaly") throw blad;
    console.warn(JSON.stringify({ ostrzezenie: "kasa-kino", poziom: "mail-oferty-odrzucony", waitlistId, powod: blad.message }));
    await db.batch([
      zdanieAck(db, job.id, teraz),
      db.prepare(`UPDATE waitlist SET emailStatus = 'failed' WHERE id = ?1 AND reservationId = ?2`).bind(waitlistId, reservationId),
      ...zdaniaOdrzucOferte(db, { waitlistId, nowyStatus: "missed", ttlMs, teraz, eventId: zapis.eventId }),
    ]);
  }
  return GOTOWE;
}

function wykonaj(db: D1Database, u: UslugiOutboxu, zegar: Zegar, job: JobOutboxu, teraz: number): Promise<Wynik> {
  switch (job.task) {
    case TASK_ZWROT:
      return wykonajZwrot(db, u, job, teraz);
    case TASK_STRAZNIK_SESJI:
      return pilnujSesji(db, u, job, teraz);
    case TASK_NALICZENIE:
      return naliczPunkty(db, u, zegar, job, teraz);
    case TASK_ODDANIE_PUNKTOW:
      return oddajPunkty(db, u, zegar, job, teraz);
    case TASK_MAIL:
      return wyslijMail(db, u, job, teraz);
    case TASK_KOLEJKA:
      return sprawdzKolejke(db, job, teraz);
    case TASK_MAIL_OFERTY:
      return wyslijMailOferty(db, u, job, teraz);
    default:
      throw new BladTrwaly(`Nieznany task: ${job.task}`);
  }
}

function idRezerwacjiJoba(job: JobOutboxu): string | null {
  try {
    return czytajDane<{ reservationId: string }>(job, ["reservationId"]).reservationId;
  } catch {
    return null;
  }
}

async function doDlq(db: D1Database, job: JobOutboxu, opis: string): Promise<void> {
  await jobDoDlq(db, job.id, opis);
  const reservationId = idRezerwacjiJoba(job);
  if (reservationId) {
    if (job.task === TASK_ZWROT) await oznaczNieudanyZwrot(db, reservationId);
    if (job.task === TASK_NALICZENIE || job.task === TASK_ODDANIE_PUNKTOW) await oznaczNieudanePunkty(db, reservationId);
    if (job.task === TASK_MAIL) await oznaczNieudanyMail(db, reservationId);
  }
  console.error(JSON.stringify({ alert: "kasa-kino", poziom: "outbox-dlq", job: job.id, task: job.task, opis }));
}

/**
 * Za ile ms job może wrócić bez liczenia porażki: budżet albo limit dostawcy (odpowiedź dotarła, więc
 * nic się nie wykonało), zajęte konto klienta, brak klucza usługi. null = zwykła porażka.
 */
function odlozenieBezPorazki(blad: unknown): number | null {
  if (blad instanceof KontoZajete) return CZEKAJ_NA_KONTO_MS;
  if (blad instanceof BrakUslugi) return CZEKAJ_NA_KONFIGURACJE_MS;
  if ((blad instanceof BladPunktow || blad instanceof BladMaila) && blad.rodzaj === "przejsciowy" && blad.ponowZaS !== undefined) {
    if (blad instanceof BladPunktow && blad.niepewny) return null;
    return blad.ponowZaS * 1000;
  }
  return null;
}

function czyTrwaly(blad: unknown): boolean {
  return blad instanceof BladTrwaly || ((blad instanceof BladPunktow || blad instanceof BladMaila) && blad.rodzaj === "trwaly");
}

export interface PodsumowanieOutboxu {
  wyslane: number;
  odlozone: number;
  ponowione: number;
  doDlq: number;
}

export async function przetworzOutbox(
  db: D1Database,
  uslugi: UslugiOutboxu,
  opcje: {
    zegar: Zegar;
    limit?: number;
    /** Te joby najpierw (jeśli są gotowe), potem zwykła kolejność: np. kroki sagi właśnie opłaconej rezerwacji. */
    najpierw?: readonly string[];
    /** Tylko joby z `najpierw`, bez reszty outboxu (dokończenie operacji jednego klienta w żądaniu). */
    tylkoTe?: boolean;
  },
): Promise<PodsumowanieOutboxu> {
  const podsumowanie: PodsumowanieOutboxu = { wyslane: 0, odlozone: 0, ponowione: 0, doDlq: 0 };
  const limit = opcje.limit ?? DOMYSLNY_LIMIT_JOBOW;
  const najpierw = [...(opcje.najpierw ?? [])];
  for (let i = 0; i < limit; i++) {
    const teraz = opcje.zegar.teraz();
    let job: JobOutboxu | null = null;
    while (!job && najpierw.length > 0) job = await wezJobPoId(db, najpierw.shift() as string, teraz, teraz + NIEWIDOCZNY_W_TRAKCIE_MS);
    if (!job && !opcje.tylkoTe) job = await wezJob(db, teraz, teraz + NIEWIDOCZNY_W_TRAKCIE_MS);
    if (!job) break;
    try {
      const wynik = await wykonaj(db, uslugi, opcje.zegar, job, teraz);
      if (wynik.rodzaj === "odlozony") {
        await odlozJob(db, job.id, wynik.doKiedy);
        podsumowanie.odlozone++;
      } else {
        podsumowanie.wyslane++;
      }
    } catch (blad) {
      const opis = blad instanceof Error ? blad.message : String(blad);
      const odlozenie = odlozenieBezPorazki(blad);
      if (odlozenie !== null) {
        if (blad instanceof BrakUslugi) console.warn(`Outbox: ${job.id} czeka: ${opis}`);
        await odlozJob(db, job.id, teraz + odlozenie);
        podsumowanie.odlozone++;
      } else if (czyTrwaly(blad) || job.totalTried >= MAX_PROB) {
        await doDlq(db, job, opis);
        podsumowanie.doDlq++;
      } else {
        console.warn(`Outbox: ${job.id}, próba ${job.totalTried} nieudana: ${opis}`);
        await ponowJob(db, job.id, teraz + opoznieniePonowienia(job.totalTried), opis);
        podsumowanie.ponowione++;
      }
    }
  }
  return podsumowanie;
}
