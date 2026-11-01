// Worker outboxu, uruchamiany przez Cron: claim → wywołanie cudzego systemu → ack.
// Outbox gwarantuje, że wiadomość wyjdzie co najmniej raz (≥1), a duplikat u Stripe'a rozpoznaje
// klucz idempotencji wzięty z joba: każda próba wysyła ten sam, więc skutek jest jeden.
// Stripe nie odpowiada? Job wróci po backoffie. Ciągle odmawia? Po limicie prób idzie do DLQ.

import type { Zegar } from "../czas";
import {
  jobDoDlq,
  odlozJob,
  oznaczNieudanyZwrot,
  ponowJob,
  potwierdzJob,
  potwierdzZwrot,
  wezJob,
  type JobOutboxu,
} from "../db/zapytania-outbox";
import { znajdzRezerwacje } from "../db/zapytania-platnosci";
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
/** Razem z backoffem to około 3 godziny prób: awaria Stripe'a musi potrwać, żeby job trafił do DLQ. */
export const MAX_PROB = 8;
const BAZA_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
/** Ochrona przed limitem żądań na jedno uruchomienie Workera. Reszta poczeka minutę, do następnego Crona. */
const DOMYSLNY_LIMIT_JOBOW = 15;

export function opoznieniePonowienia(totalTried: number): number {
  return Math.min(MAX_BACKOFF_MS, BAZA_BACKOFF_MS * 2 ** Math.max(0, totalTried - 1));
}

/** Błąd, którego ponawianie nic nie zmieni, np. nieznany task. */
class BladTrwaly extends Error {}

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
async function wykonajZwrot(db: D1Database, bramka: BramkaPlatnosci, job: JobOutboxu, teraz: number): Promise<Wynik> {
  const { paymentIntentId, reservationId } = czytajDane<{ paymentIntentId: string; reservationId: string }>(job, [
    "paymentIntentId",
    "reservationId",
  ]);
  await bramka.zwrocPlatnosc(paymentIntentId, job.id, reservationId);
  await potwierdzZwrot(db, job.id, reservationId, teraz);
  return GOTOWE;
}

/**
 * Strażnik sesji: pilnuje dwóch rzeczy, na które nie ma zdarzenia od Stripe'a.
 * Webhook zaginął (Stripe nie ponowi w nieskończoność), więc sami pytamy o stan sesji i rozliczamy płatność.
 * Rezerwacja wygasła, a sesja nadal jest otwarta (minimum 30 minut), więc ją wygaszamy, żeby nikt nie zapłacił
 * za fotel, którego już nie ma. Gdy klient zdąży przed wygaszeniem, płatność wróci do niego (zwrot).
 */
async function pilnujSesji(db: D1Database, bramka: BramkaPlatnosci, job: JobOutboxu, teraz: number): Promise<Wynik> {
  const { reservationId, sessionId } = czytajDane<{ reservationId: string; sessionId: string }>(job, [
    "reservationId",
    "sessionId",
  ]);
  const rezerwacja = await znajdzRezerwacje(db, reservationId);
  if (!rezerwacja || statusRezerwacji(rezerwacja, teraz) === "paid") {
    await potwierdzJob(db, job.id, teraz);
    return GOTOWE;
  }
  const sesja = await bramka.pobierzSesje(sessionId);
  if (sesja.oplacona && sesja.paymentIntentId) {
    await rozliczPlatnosc(db, rezerwacja, {
      paymentIntentId: sesja.paymentIntentId,
      kwota: sesja.kwota,
      waluta: sesja.waluta,
      paidAt: sesja.oplaconoO ?? teraz,
      teraz,
    });
  } else if (sesja.status === "open") {
    if (teraz < rezerwacja.expiresAt) {
      return { rodzaj: "odlozony", doKiedy: Math.min(teraz + CO_ILE_STRAZNIK_MS, rezerwacja.expiresAt) };
    }
    await bramka.wygasSesje(sessionId);
  }
  await potwierdzJob(db, job.id, teraz);
  return GOTOWE;
}

function wykonaj(db: D1Database, bramka: BramkaPlatnosci, job: JobOutboxu, teraz: number): Promise<Wynik> {
  if (job.task === TASK_ZWROT) return wykonajZwrot(db, bramka, job, teraz);
  if (job.task === TASK_STRAZNIK_SESJI) return pilnujSesji(db, bramka, job, teraz);
  throw new BladTrwaly(`Nieznany task: ${job.task}`);
}

async function doDlq(db: D1Database, job: JobOutboxu, opis: string): Promise<void> {
  await jobDoDlq(db, job.id, opis);
  if (job.task === TASK_ZWROT) {
    try {
      const { reservationId } = czytajDane<{ reservationId: string }>(job, ["reservationId"]);
      await oznaczNieudanyZwrot(db, reservationId);
    } catch (blad) {
      if (!(blad instanceof BladTrwaly)) throw blad;
    }
  }
  console.error(JSON.stringify({ alert: "kasa-kino", poziom: "outbox-dlq", job: job.id, task: job.task, opis }));
}

export interface PodsumowanieOutboxu {
  wyslane: number;
  odlozone: number;
  ponowione: number;
  doDlq: number;
}

export async function przetworzOutbox(
  db: D1Database,
  bramka: BramkaPlatnosci,
  opcje: { zegar: Zegar; limit?: number },
): Promise<PodsumowanieOutboxu> {
  const podsumowanie: PodsumowanieOutboxu = { wyslane: 0, odlozone: 0, ponowione: 0, doDlq: 0 };
  const limit = opcje.limit ?? DOMYSLNY_LIMIT_JOBOW;
  for (let i = 0; i < limit; i++) {
    const teraz = opcje.zegar.teraz();
    const job = await wezJob(db, teraz, teraz + NIEWIDOCZNY_W_TRAKCIE_MS);
    if (!job) break;
    try {
      const wynik = await wykonaj(db, bramka, job, teraz);
      if (wynik.rodzaj === "odlozony") {
        await odlozJob(db, job.id, wynik.doKiedy);
        podsumowanie.odlozone++;
      } else {
        podsumowanie.wyslane++;
      }
    } catch (blad) {
      const opis = blad instanceof Error ? blad.message : String(blad);
      if (blad instanceof BladTrwaly || job.totalTried >= MAX_PROB) {
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
