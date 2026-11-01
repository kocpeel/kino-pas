// Kontrola zdrowia aplikacji co minutę i alerty. Worker sprzątający woła przez service binding
// `GET /api/zdrowie` głównego Workera (pełna ścieżka: Worker, Next.js, D1). Każdy problem trafia do logów
// jako jedna linia JSON z polem `alert` (Workers Logs: filtr `alert`), a gdy ustawiono sekret
// ALERT_WEBHOOK_URL, także na webhook (Slack, Discord albo inny przyjmujący JSON z `text`/`content`).
// Stan w tabeli alert_state, żeby nie wysyłać alertu co minutę.

import { policzDlq } from "../../../src/lib/db/zapytania-outbox";

const NAZWA_KONTROLI = "aplikacja";
const NAZWA_KONTROLI_DLQ = "outbox-dlq";
/** Tyle kolejnych nieudanych kontroli, zanim pójdzie alert (pojedynczy błysk nie budzi nikogo). */
const PROG_NIEUDANYCH = 2;
const PRZYPOMNIENIE_MS = 30 * 60_000;
const TIMEOUT_KONTROLI_MS = 5_000;

export interface SrodowiskoZdrowia {
  DB: D1Database;
  /** Service binding do Workera `kasa-kino`. */
  APLIKACJA?: Fetcher;
  /** Sekret (opcjonalny): adres webhooka na alerty. */
  ALERT_WEBHOOK_URL?: string;
}

export interface WynikKontroli {
  ok: boolean;
  opis: string;
}

export interface OpcjeKontroli {
  teraz?: number;
  /** Wysyłka na webhook (w testach podmieniana). */
  wyslij?: (adres: string, tresc: object) => Promise<unknown>;
}

export async function sprawdzAplikacje(env: SrodowiskoZdrowia): Promise<WynikKontroli> {
  if (!env.APLIKACJA) return { ok: true, opis: "brak bindingu APLIKACJA, kontrola pominięta" };
  try {
    const odp = await env.APLIKACJA.fetch("https://kasa-kino.internal/api/zdrowie", {
      signal: AbortSignal.timeout(TIMEOUT_KONTROLI_MS),
    });
    const cialo = (await odp.json().catch(() => null)) as { status?: string; error?: string; db?: { latencyMs?: number } } | null;
    if (odp.status !== 200) return { ok: false, opis: `/api/zdrowie → HTTP ${odp.status} (${cialo?.error ?? "bez opisu"})` };
    if (cialo?.status !== "ok") return { ok: false, opis: `/api/zdrowie → ${cialo?.status ?? "?"}: baza zwolniła, działa load shedding` };
    return { ok: true, opis: `ok, baza ${cialo.db?.latencyMs ?? "?"} ms` };
  } catch (blad) {
    return { ok: false, opis: `/api/zdrowie nie odpowiada: ${blad instanceof Error ? blad.message : String(blad)}` };
  }
}

async function wyslijNaWebhook(adres: string, tresc: object): Promise<unknown> {
  const odp = await fetch(adres, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(tresc),
    signal: AbortSignal.timeout(TIMEOUT_KONTROLI_MS),
  });
  if (!odp.ok) throw new Error(`webhook → HTTP ${odp.status}`);
  return odp;
}

async function powiadom(env: SrodowiskoZdrowia, poziom: "problem" | "naprawione", opis: string, o: OpcjeKontroli) {
  const tekst = poziom === "problem" ? `🔴 Kino Pas: ${opis}` : `🟢 Kino Pas działa znowu: ${opis}`;
  // Jedna linia JSON: łatwo wyszukać i podpiąć powiadomienia w Workers Logs.
  console.error(JSON.stringify({ alert: "kasa-kino", poziom, opis }));
  if (!env.ALERT_WEBHOOK_URL) return;
  try {
    await (o.wyslij ?? wyslijNaWebhook)(env.ALERT_WEBHOOK_URL, { text: tekst, content: tekst });
  } catch (blad) {
    console.error(JSON.stringify({ alert: "kasa-kino", poziom: "webhook", opis: String(blad) }));
  }
}

interface StanAlertu {
  consecutiveFailures: number;
  alertedAt: number;
}

/** Wiadomość w DLQ czeka na człowieka: np. zwrot, którego Stripe nie przyjął przez kilka godzin. */
async function sprawdzDlq(env: SrodowiskoZdrowia): Promise<WynikKontroli> {
  try {
    const liczba = await policzDlq(env.DB);
    return liczba > 0
      ? { ok: false, opis: `w DLQ outboxu czeka zadań: ${liczba} (SELECT * FROM outbox WHERE hasError = 1)` }
      : { ok: true, opis: "DLQ outboxu puste" };
  } catch {
    // Awarię bazy zgłasza kontrola aplikacji.
    return { ok: true, opis: "DLQ outboxu: baza niedostępna" };
  }
}

/** Kontrola + decyzja o alercie. Zwraca wynik kontroli aplikacji (do logów i testów). */
export async function kontrolaZdrowia(env: SrodowiskoZdrowia, o: OpcjeKontroli = {}): Promise<WynikKontroli> {
  const wynik = await sprawdzAplikacje(env);
  await zalatwWynik(env, NAZWA_KONTROLI, wynik, o);
  await zalatwWynik(env, NAZWA_KONTROLI_DLQ, await sprawdzDlq(env), o);
  return wynik;
}

async function zalatwWynik(env: SrodowiskoZdrowia, nazwa: string, wynik: WynikKontroli, o: OpcjeKontroli): Promise<void> {
  const teraz = o.teraz ?? Date.now();
  let stan: StanAlertu;
  try {
    stan = (await env.DB.prepare("SELECT consecutiveFailures, alertedAt FROM alert_state WHERE name = ?1")
      .bind(nazwa)
      .first<StanAlertu>()) ?? { consecutiveFailures: 0, alertedAt: 0 };
  } catch (blad) {
    // Bez stanu (zwykle: baza leży) lepiej powiadomić za często niż wcale.
    if (!wynik.ok) await powiadom(env, "problem", `${wynik.opis}; stan alertów niedostępny: ${String(blad)}`, o);
    return;
  }

  const nowy: StanAlertu = { consecutiveFailures: 0, alertedAt: 0 };
  if (wynik.ok) {
    if (stan.alertedAt > 0) await powiadom(env, "naprawione", wynik.opis, o);
  } else {
    nowy.consecutiveFailures = stan.consecutiveFailures + 1;
    nowy.alertedAt = stan.alertedAt;
    const czasNaAlert =
      nowy.consecutiveFailures >= PROG_NIEUDANYCH && (stan.alertedAt === 0 || teraz - stan.alertedAt >= PRZYPOMNIENIE_MS);
    if (czasNaAlert) {
      await powiadom(env, "problem", wynik.opis, o);
      nowy.alertedAt = teraz;
    }
  }
  if (nowy.consecutiveFailures !== stan.consecutiveFailures || nowy.alertedAt !== stan.alertedAt) {
    try {
      await env.DB.prepare(
        `INSERT INTO alert_state (name, consecutiveFailures, alertedAt) VALUES (?1, ?2, ?3)
         ON CONFLICT (name) DO UPDATE SET consecutiveFailures = excluded.consecutiveFailures, alertedAt = excluded.alertedAt`,
      )
        .bind(nazwa, nowy.consecutiveFailures, nowy.alertedAt)
        .run();
    } catch (blad) {
      console.error(JSON.stringify({ alert: "kasa-kino", poziom: "stan-alertow", opis: String(blad) }));
    }
  }
}
