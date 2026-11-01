// Cron Triggery Workera sprzątającego. SQL jest w aplikacji (src/lib/db), tu tylko wywołania.
// - co minutę: wygasłe rezerwacje wracają do puli, a imię, e-mail i klucz idempotencji są czyszczone.
//   Spóźniony albo pominięty przebieg niczego nie psuje: aplikacja sama traktuje rezerwacje
//   po `expiresAt` jako wygasłe. Do tego wysyłka outboxu do Stripe'a (zwroty, strażnik sesji)
//   oraz kontrola zdrowia aplikacji i alerty (zdrowie.ts);
// - raz na dobę: retencja danych osobowych. Kupione bilety tracą imię i e-mail DATA_RETENTION_DAYS dni
//   po seansie (domyślnie 30: zapas na reklamacje i zwroty). Tego samego dnia sprzątanie inboxu,
//   wysłanych wiadomości z outboxu i starej historii rezerwacji.

import { zegarSystemowy } from "../../../src/lib/czas";
import { anonimizujPoSeansach, zwolnijWygasleRezerwacje } from "../../../src/lib/db/zapytania-miejsca";
import { wyczyscOutbox } from "../../../src/lib/db/zapytania-outbox";
import { wyczyscHistorieRezerwacji, wyczyscInbox } from "../../../src/lib/db/zapytania-platnosci";
import { przetworzOutbox, type PodsumowanieOutboxu } from "../../../src/lib/domain/outbox";
import { bramkaZeSrodowiska, type SrodowiskoStripe } from "../../../src/lib/platnosci/stripe";
import type { SrodowiskoZdrowia } from "./zdrowie";

export const CRON_RETENCJI = "17 3 * * *";
const DOMYSLNA_RETENCJA_DNI = 30;
const DOBA_MS = 24 * 60 * 60 * 1000;
/** Stripe ponawia zdarzenia do 3 dni, więc inbox pamięta dłużej. */
const PAMIEC_INBOXU_DNI = 7;
const PAMIEC_OUTBOXU_DNI = 7;

export interface SrodowiskoSprzatania extends SrodowiskoZdrowia, SrodowiskoStripe {
  DB: D1Database;
  DATA_RETENTION_DAYS?: string;
}

export async function sprzataj(env: SrodowiskoSprzatania, teraz = zegarSystemowy.teraz()): Promise<number> {
  const zwolnione = await zwolnijWygasleRezerwacje(env.DB, teraz);
  if (zwolnione > 0) console.log(`Sprzątanie: zwolniono ${zwolnione} wygasłych rezerwacji.`);
  return zwolnione;
}

function dniRetencji(env: SrodowiskoSprzatania): number {
  const dni = Number(env.DATA_RETENTION_DAYS ?? DOMYSLNA_RETENCJA_DNI);
  // Zła wartość nie może wyłączyć retencji ani skasować danych za wcześnie: wracamy do domyślnej.
  if (!Number.isInteger(dni) || dni < 1 || dni > 3650) {
    console.error(`DATA_RETENTION_DAYS="${env.DATA_RETENTION_DAYS}" poza zakresem 1–3650, używam ${DOMYSLNA_RETENCJA_DNI}.`);
    return DOMYSLNA_RETENCJA_DNI;
  }
  return dni;
}

export async function retencja(env: SrodowiskoSprzatania, teraz = zegarSystemowy.teraz()): Promise<number> {
  const dni = dniRetencji(env);
  const zanonimizowane = await anonimizujPoSeansach(env.DB, teraz - dni * DOBA_MS);
  console.log(`Retencja: zanonimizowano ${zanonimizowane} biletów z seansów sprzed ponad ${dni} dni.`);
  return zanonimizowane;
}

export async function sprzatnijHistorie(env: SrodowiskoSprzatania, teraz = zegarSystemowy.teraz()): Promise<void> {
  const inbox = await wyczyscInbox(env.DB, teraz - PAMIEC_INBOXU_DNI * DOBA_MS);
  const outbox = await wyczyscOutbox(env.DB, teraz - PAMIEC_OUTBOXU_DNI * DOBA_MS);
  const rezerwacje = await wyczyscHistorieRezerwacji(env.DB, teraz - dniRetencji(env) * DOBA_MS);
  console.log(`Sprzątanie historii: inbox ${inbox}, outbox ${outbox}, rezerwacje ${rezerwacje}.`);
}

/** Wysyłka outboxu. Bez klucza Stripe'a wiadomości czekają w bazie, nic nie przepada. */
export async function wyslijOutbox(env: SrodowiskoSprzatania): Promise<PodsumowanieOutboxu | null> {
  const bramka = bramkaZeSrodowiska(env);
  if (!bramka) return null;
  const wynik = await przetworzOutbox(env.DB, bramka, { zegar: zegarSystemowy });
  if (wynik.wyslane > 0 || wynik.ponowione > 0 || wynik.doDlq > 0) {
    console.log(`Outbox: wysłane ${wynik.wyslane}, ponowione ${wynik.ponowione}, DLQ ${wynik.doDlq}.`);
  }
  return wynik;
}
