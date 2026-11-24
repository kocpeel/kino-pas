// Karta A etapu III: konto punktowe klienta. Prawdą o saldzie jest Voucherify, my trzymamy mapowanie
// e-mail → karta, pamięć podręczną salda i blokadę, dzięki której operacje na punktach jednego klienta
// idą po kolei (dwie rezerwacje tego klienta nie wydadzą tych samych punktów).
//
// Każde wywołanie Voucherify przechodzi przez budżet (sandbox: 100 wywołań na godzinę).

import type { Zegar } from "../czas";
import {
  kontoKlienta,
  odblokujKonto,
  zablokujKonto,
  zdanieKartaZakladana,
  zdaniePowitanie,
  zdanieZapamietajKarte,
  zdanieZapiszKarte,
  zdanieZapiszSaldo,
} from "../db/zapytania-punktow";
import type { BudzetWywolan, RodzajWywolania } from "../punkty/budzet";
import { BladPunktow, type BramkaPunktow, type KartaPunktow } from "../punkty/voucherify";
import { BladDomenowy } from "./bledy";
import { PUNKTY_POWITALNE } from "./punkty";

export interface UslugaPunktow {
  bramka: BramkaPunktow;
  /** undefined = bez limitu (testy, `next dev`). */
  budzet?: BudzetWywolan | undefined;
  /** Jak długo saldo z pamięci podręcznej uchodzi za aktualne. */
  swiezoscSaldaMs: number;
}

/** Ile trwa blokada konta: z zapasem na kilka wywołań Voucherify po 5 s. */
export const BLOKADA_KONTA_MS = 30_000;
const PRZERWA_BLOKADY_MS = 250;

/** Inna operacja na punktach tego klienta jeszcze trwa. */
export class KontoZajete extends Error {
  constructor() {
    super("Trwa inna operacja na punktach tego klienta.");
    this.name = "KontoZajete";
  }
}

/** Wywołanie Voucherify w budżecie. Brak zgody = błąd przejściowy z czasem ponowienia, bez wywołania. */
export async function wBudzecie<T>(u: UslugaPunktow, rodzaj: RodzajWywolania, praca: () => Promise<T>): Promise<T> {
  if (u.budzet) {
    const zgoda = await u.budzet.zgoda(rodzaj);
    if (!zgoda.ok) {
      throw new BladPunktow("Budżet wywołań Voucherify na tę godzinę wyczerpany.", "przejsciowy", { ponowZaS: zgoda.ponowZaS });
    }
  }
  return praca();
}

/**
 * Praca z wyłącznym dostępem do punktów klienta. Czeka najwyżej `czekajMs` prawdziwego czasu (zegar domeny
 * wyznacza tylko termin blokady, a w testach stoi), potem `KontoZajete`.
 */
export async function zWylacznoscia<T>(
  db: D1Database,
  email: string,
  zegar: Zegar,
  czekajMs: number,
  praca: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const teraz = zegar.teraz();
    const doKiedy = teraz + BLOKADA_KONTA_MS;
    if (await zablokujKonto(db, email, teraz, doKiedy)) {
      try {
        return await praca();
      } finally {
        await odblokujKonto(db, email, doKiedy).catch((blad: unknown) => console.warn("Nie zdjęto blokady konta punktowego", blad));
      }
    }
    if (Date.now() - start >= czekajMs) throw new KontoZajete();
    await new Promise((r) => setTimeout(r, PRZERWA_BLOKADY_MS));
  }
}

/** Czy na karcie jest operacja z tym `sourceId` (uzgodnienie przed ponowieniem niepewnej operacji). */
export async function czyBylaOperacja(u: UslugaPunktow, memberId: string, sourceId: string): Promise<boolean> {
  return (await wBudzecie(u, "zapis", () => u.bramka.zmianyWHistorii(memberId, [sourceId]))).has(sourceId);
}

/** `source_id` próby wydania: pierwsza `wydanie:<id>`, kolejne (tylko po obciętym wydaniu) `wydanie:<id>:<n>`. */
export function idWydania(reservationId: string, proba: number): string {
  return proba <= 1 ? `wydanie:${reservationId}` : `wydanie:${reservationId}:${proba}`;
}

/** `source_id` korekty, która oddaje to, co zeszło w obciętej próbie wydania. */
export function idKorekty(wydanieId: string): string {
  return `korekta:${wydanieId}`;
}

/**
 * Ile punktów naprawdę zeszło w próbie wydania, po odjęciu jej korekty, według historii karty. 0 = nic
 * (próba nie doszła, Voucherify niczego nie zdjął albo korekta już wszystko oddała).
 */
export async function zeszloWProbie(u: UslugaPunktow, memberId: string, wydanieId: string): Promise<number> {
  const korekta = idKorekty(wydanieId);
  const zmiany = await wBudzecie(u, "zapis", () => u.bramka.zmianyWHistorii(memberId, [wydanieId, korekta]));
  return Math.max(0, -((zmiany.get(wydanieId) ?? 0) + (zmiany.get(korekta) ?? 0)));
}

export interface KartaKlienta {
  memberId: string;
  /** Saldo po ostatniej znanej operacji; null, gdy trzeba je odczytać. */
  saldo: number | null;
}

/**
 * Karta klienta: z naszej bazy, a gdy jej tam nie ma, z Voucherify (mogła powstać w innym kanale albo w naszej
 * poprzedniej, przerwanej próbie). Nowemu klientowi zakładamy kartę i dopisujemy punkty powitalne, raz:
 * jeśli przyznanie mogło się już wykonać, najpierw sprawdzamy historię karty. Punkty powitalne należą się tylko
 * karcie, którą założył nasz sklep (notatka `cardRequestedAt` przed wywołaniem); klient z innego kanału (kasy,
 * aplikacja) nie jest u nas nowy. Wołać pod blokadą konta.
 */
export async function zapewnijKarte(db: D1Database, u: UslugaPunktow, email: string, teraz: number): Promise<KartaKlienta> {
  const konto = await kontoKlienta(db, email);
  let memberId = konto?.memberId ?? null;
  let saldo: number | null = konto?.balance ?? null;
  let nowaKarta = false;
  let naszaKarta = (konto?.cardRequestedAt ?? null) !== null;

  if (!memberId) {
    let karta: KartaPunktow | null = await wBudzecie(u, "zapis", () => u.bramka.znajdzKarte(email));
    if (!karta) {
      await zdanieKartaZakladana(db, email, teraz).run();
      karta = await wBudzecie(u, "zapis", () => u.bramka.zalozKarte(email));
      nowaKarta = true;
      naszaKarta = true;
    }
    memberId = karta.memberId;
    saldo = karta.saldo;
    await zdanieZapiszKarte(db, email, memberId, saldo, teraz).run();
  }

  if (naszaKarta && !konto?.welcomeAt) {
    const sourceId = `powitanie:${email}`;
    const karta = memberId;
    // Karta z poprzedniej próby: punkty powitalne mogły już wejść, a odpowiedź nie dotrzeć.
    const juzSa = !nowaKarta && (await czyBylaOperacja(u, karta, sourceId));
    saldo = juzSa
      ? null
      : (await wBudzecie(u, "zapis", () => u.bramka.zmienSaldo(karta, PUNKTY_POWITALNE, { sourceId, powod: "Punkty powitalne" }))).saldo;
    await zdaniePowitanie(db, email, saldo, teraz).run();
  }
  return { memberId, saldo };
}

/** Aktualne saldo karty: z pamięci, jeśli świeże, inaczej z Voucherify (i zapis do pamięci). */
export async function saldoKarty(
  db: D1Database,
  u: UslugaPunktow,
  email: string,
  memberId: string,
  teraz: number,
  rodzaj: RodzajWywolania,
): Promise<number> {
  const konto = await kontoKlienta(db, email);
  if (konto?.balance !== null && konto?.balance !== undefined && konto.balanceAt !== null && teraz - konto.balanceAt <= u.swiezoscSaldaMs) {
    return konto.balance;
  }
  const saldo = await wBudzecie(u, rodzaj, () => u.bramka.saldo(memberId));
  await zdanieZapiszSaldo(db, email, saldo, teraz).run();
  return saldo;
}

export interface SaldoKlienta {
  points: number;
  /** Saldo z pamięci (albo domyślne powitalne), bo Voucherify albo budżet odmówił. */
  nieaktualne: boolean;
  /** Wiek salda z pamięci; null, gdy go nie było (domyślne powitalne). */
  wiekMs: number | null;
}

/**
 * GET /api/loyalty. Źródłem prawdy jest Voucherify, z którego korzystają też aplikacja i kasy, więc e-mail,
 * którego jeszcze nie znamy, też sprawdzamy u niego (budżet odczytów): karta z innego kanału ma swoje saldo,
 * a e-mail bez karty nic jeszcze nie kupił, więc ma punkty powitalne. Znany klient: saldo świeże z pamięci,
 * inaczej z Voucherify; gdy się nie da, ostatnie znane (albo powitalne) z oznaczeniem.
 */
export async function saldoDlaKlienta(
  db: D1Database,
  u: UslugaPunktow | undefined,
  email: string,
  teraz: number,
): Promise<SaldoKlienta> {
  const konto = await kontoKlienta(db, email);
  if (!konto?.memberId) return saldoNieznanegoEmaila(db, u, email, teraz);
  const wiekMs = konto.balanceAt !== null ? teraz - konto.balanceAt : Number.POSITIVE_INFINITY;
  if (konto.balance !== null && u && wiekMs <= u.swiezoscSaldaMs) return { points: konto.balance, nieaktualne: false, wiekMs };
  try {
    if (!u) throw new BladPunktow("Program punktowy nie jest skonfigurowany.", "przejsciowy", { ponowZaS: 60 });
    const memberId = konto.memberId;
    const saldo = await wBudzecie(u, "odczyt", () => u.bramka.saldo(memberId));
    await zdanieZapiszSaldo(db, email, saldo, teraz).run();
    return { points: saldo, nieaktualne: false, wiekMs: 0 };
  } catch (blad) {
    if (!(blad instanceof BladPunktow)) throw blad;
    if (konto.balance !== null) return { points: konto.balance, nieaktualne: true, wiekMs };
    throw new BladDomenowy("PUNKTY_NIEDOSTEPNE", { ponowZaS: blad.ponowZaS ?? 30, przyczyna: blad });
  }
}

/**
 * E-mail bez karty w naszej bazie. Kartę mógł mu założyć inny kanał (aplikacja, kasy): wtedy ją zapamiętujemy
 * razem z saldem. Bez karty klient nic jeszcze nie kupił, więc ma punkty powitalne (kartę założy pierwszy zakup).
 * Gdy Voucherify albo budżet odmówi, zakładamy nowego klienta, z oznaczeniem, że to nie jest odczyt.
 */
async function saldoNieznanegoEmaila(db: D1Database, u: UslugaPunktow | undefined, email: string, teraz: number): Promise<SaldoKlienta> {
  const domyslne: SaldoKlienta = { points: PUNKTY_POWITALNE, nieaktualne: true, wiekMs: null };
  if (!u) return domyslne;
  try {
    const karta = await wBudzecie(u, "odczyt", () => u.bramka.znajdzKarte(email));
    if (!karta) return { points: PUNKTY_POWITALNE, nieaktualne: false, wiekMs: 0 };
    await zdanieZapamietajKarte(db, email, karta.memberId, karta.saldo, teraz).run();
    return { points: karta.saldo, nieaktualne: false, wiekMs: 0 };
  } catch (blad) {
    if (!(blad instanceof BladPunktow)) throw blad;
    return domyslne;
  }
}
