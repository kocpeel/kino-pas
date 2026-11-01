// 📤 Outbox: zwroty i strażnik sesji. Claim → wywołanie cudzego systemu z kluczem idempotencji → ack,
// ponowienia z backoffem i DLQ. Plus sprzątanie inboxu, outboxu i historii rezerwacji.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { utworzZegarTestowy } from "../../src/lib/czas";
import { MAX_PROB, opoznieniePonowienia, przetworzOutbox } from "../../src/lib/domain/outbox";
import { sprzatnijHistorie, wyslijOutbox } from "../../workers/sprzatanie/src/zadania";
import { kontrolaZdrowia } from "../../workers/sprzatanie/src/zdrowie";
import {
  checkout,
  stanRezerwacji,
  sztucznaBramka,
  TTL_MS,
  wierszMiejsca,
  zaplac,
  zarezerwuj,
  zasiej,
  zaleznosci,
  type SztucznaBramka,
} from "./pomocnicze";

const DOBA_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await zasiej();
  await env.DB.prepare("DELETE FROM alert_state").run();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

async function job(id: string) {
  return env.DB.prepare("SELECT * FROM outbox WHERE id = ?1").bind(id).first<{
    id: string;
    visibleAt: number;
    totalTried: number;
    completedAt: number | null;
    hasError: number;
    lastError: string | null;
  }>();
}

/** Płatność po czasie: rezerwacja wygasła, w outboxie czeka zwrot. */
async function platnoscPoCzasie(seatId: string, paymentIntent: string) {
  const zegar = utworzZegarTestowy();
  const bramka = sztucznaBramka(zegar.teraz);
  const z = zaleznosci({ zegar, platnosci: bramka });
  const { reservationId, expiresAt } = (await zarezerwuj(z, { seatId, email: `${seatId}@example.com` })).cialo;
  zegar.ustaw(expiresAt + 1000);
  await zaplac(z, reservationId, { paymentIntent });
  return { zegar, bramka, z, reservationId, idJoba: `stripe-refund:${paymentIntent}` };
}

describe("zwrot przez outbox", () => {
  it("wysyła zwrot z kluczem z joba, a po ack nic się nie powtarza", async () => {
    const { zegar, bramka, z, reservationId, idJoba } = await platnoscPoCzasie("A1", "pi_a1");
    expect((await job(idJoba))?.completedAt).toBeNull();

    expect(await przetworzOutbox(env.DB, bramka, { zegar })).toMatchObject({ wyslane: 1, ponowione: 0, doDlq: 0 });
    expect(bramka.zwroty).toEqual([{ paymentIntentId: "pi_a1", klucz: idJoba, reservationId }]);
    expect((await job(idJoba))?.completedAt).toBe(zegar.teraz());
    expect((await stanRezerwacji(z, reservationId)).cialo.refund).toBe("done");

    zegar.przewin(DOBA_MS);
    expect(await przetworzOutbox(env.DB, bramka, { zegar })).toMatchObject({ wyslane: 0 });
    expect(bramka.zwroty).toHaveLength(1);
  });

  it("zwrot i bilet nie wychodzą razem: to samo zdarzenie dwa razy = jeden job", async () => {
    const { zegar, bramka, z, reservationId } = await platnoscPoCzasie("A2", "pi_a2");
    await zaplac(z, reservationId, { paymentIntent: "pi_a2" });
    await przetworzOutbox(env.DB, bramka, { zegar });
    expect(bramka.zwroty).toHaveLength(1);
  });

  it("Stripe nie odpowiada: job wraca po backoffie z tym samym kluczem, a skutek jest jeden", async () => {
    const { zegar, bramka, idJoba } = await platnoscPoCzasie("A3", "pi_a3");
    bramka.awaria = new Error("Stripe nie odpowiada");

    expect(await przetworzOutbox(env.DB, bramka, { zegar })).toMatchObject({ ponowione: 1 });
    const poBledzie = await job(idJoba);
    expect(poBledzie).toMatchObject({ totalTried: 1, completedAt: null, hasError: 0, lastError: "Stripe nie odpowiada" });
    expect(poBledzie?.visibleAt).toBe(zegar.teraz() + opoznieniePonowienia(1));

    // Przed visibleAt nikt go nie weźmie.
    expect(await przetworzOutbox(env.DB, bramka, { zegar })).toMatchObject({ ponowione: 0, wyslane: 0 });

    bramka.awaria = null;
    zegar.przewin(opoznieniePonowienia(1));
    expect(await przetworzOutbox(env.DB, bramka, { zegar })).toMatchObject({ wyslane: 1 });
    expect(bramka.zwroty.map((z) => z.klucz)).toEqual([idJoba]);
  });

  it("worker pada między zwrotem a ackiem: job wraca sam i Stripe dostaje ten sam klucz", async () => {
    const { zegar, bramka, idJoba } = await platnoscPoCzasie("A4", "pi_a4");
    // Bramka wykona zwrot, ale potem „serwer pada”: ack się nie zapisuje.
    const padajaca = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: () => Promise.reject(new Error("serwer padł")),
    } as unknown as D1Database;
    await przetworzOutbox(padajaca, bramka, { zegar, limit: 1 });
    expect(bramka.zwroty).toHaveLength(1);

    zegar.przewin(10 * 60_000);
    await przetworzOutbox(env.DB, bramka, { zegar });
    expect(bramka.zwroty.map((z) => z.klucz)).toEqual([idJoba, idJoba]);
    expect((await job(idJoba))?.completedAt).not.toBeNull();
  });

  it("po limicie prób job idzie do DLQ, zwrot jest failed, a alert wychodzi", async () => {
    const logi = vi.spyOn(console, "error").mockImplementation(() => {});
    const { zegar, bramka, z, reservationId, idJoba } = await platnoscPoCzasie("A5", "pi_a5");
    bramka.awaria = new Error("Stripe ciągle odmawia");
    for (let i = 0; i < MAX_PROB; i++) {
      await przetworzOutbox(env.DB, bramka, { zegar });
      zegar.przewin(2 * 60 * 60_000);
    }
    const koniec = await job(idJoba);
    expect(koniec).toMatchObject({ hasError: 1, completedAt: null, totalTried: MAX_PROB });
    expect((await stanRezerwacji(z, reservationId)).cialo.refund).toBe("failed");
    expect(logi).toHaveBeenCalledWith(expect.stringContaining('"poziom":"outbox-dlq"'));

    // DLQ nie jest już brane.
    bramka.awaria = null;
    zegar.przewin(DOBA_MS);
    expect(await przetworzOutbox(env.DB, bramka, { zegar })).toMatchObject({ wyslane: 0 });
    expect(bramka.zwroty).toEqual([]);

    // Kontrola zdrowia zgłasza DLQ po 2 kontrolach, raz.
    const wyslane: object[] = [];
    const wyslij = async (_a: string, tresc: object) => wyslane.push(tresc);
    const srodowisko = { DB: env.DB, ALERT_WEBHOOK_URL: "https://hooks.example/a" };
    await kontrolaZdrowia(srodowisko, { teraz: 1, wyslij });
    await kontrolaZdrowia(srodowisko, { teraz: 2, wyslij });
    await kontrolaZdrowia(srodowisko, { teraz: 3, wyslij });
    expect(wyslane).toHaveLength(1);
    expect(JSON.stringify(wyslane[0])).toContain("DLQ");
  });

  it("nieznany task i zepsute dane: od razu DLQ, bez ponawiania i bez blokowania kolejki", async () => {
    const zegar = utworzZegarTestowy();
    const bramka = sztucznaBramka(zegar.teraz);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO outbox (id, task, input, visibleAt, createdAt) VALUES ('j1', 'cos-nowego', '{}', 1, 1)"),
      env.DB.prepare("INSERT INTO outbox (id, task, input, visibleAt, createdAt) VALUES ('j2', 'stripe-refund', 'nie json', 2, 2)"),
      env.DB.prepare(
        `INSERT INTO outbox (id, task, input, visibleAt, createdAt)
         VALUES ('j3', 'stripe-refund', '{"paymentIntentId":"pi_j3","reservationId":"r3"}', 3, 3)`,
      ),
    ]);
    expect(await przetworzOutbox(env.DB, bramka, { zegar })).toMatchObject({ doDlq: 2, wyslane: 1 });
    expect((await job("j1"))?.hasError).toBe(1);
    expect((await job("j2"))?.hasError).toBe(1);
    expect(bramka.zwroty).toEqual([{ paymentIntentId: "pi_j3", klucz: "j3", reservationId: "r3" }]);
  });

  it("dwa równoległe przebiegi nie wezmą tego samego joba", async () => {
    const { zegar, bramka, idJoba } = await platnoscPoCzasie("A6", "pi_a6");
    await Promise.all(Array.from({ length: 5 }, () => przetworzOutbox(env.DB, bramka, { zegar })));
    expect(bramka.zwroty.map((z) => z.klucz)).toEqual([idJoba]);
  });
});

describe("strażnik sesji", () => {
  async function zSesja(seatId: string) {
    const zegar = utworzZegarTestowy();
    const bramka: SztucznaBramka = sztucznaBramka(zegar.teraz);
    const z = zaleznosci({ zegar, platnosci: bramka });
    const { reservationId, expiresAt } = (await zarezerwuj(z, { seatId, email: `${seatId}@example.com` })).cialo;
    await checkout(z, reservationId);
    const idSesji = [...bramka.sesje.values()][0]?.id as string;
    return { zegar, bramka, z, reservationId, expiresAt, idSesji, idJoba: `stripe-session-watch:${reservationId}` };
  }

  it("powstaje razem z sesją i czeka: przed czasem nikt go nie bierze", async () => {
    const { zegar, bramka, idJoba } = await zSesja("B1");
    const j = await job(idJoba);
    expect(j?.visibleAt).toBe(zegar.teraz() + 60_000);
    expect(await przetworzOutbox(env.DB, bramka, { zegar })).toMatchObject({ wyslane: 0, odlozone: 0 });
  });

  it("rezerwacja ważna, sesja otwarta: odkłada się bez kary, aż do wygaśnięcia", async () => {
    const { zegar, bramka, expiresAt, idJoba } = await zSesja("B2");
    zegar.przewin(60_000);
    expect(await przetworzOutbox(env.DB, bramka, { zegar })).toMatchObject({ odlozone: 1 });
    expect(await job(idJoba)).toMatchObject({ totalTried: 0, completedAt: null, visibleAt: expiresAt });
    expect(bramka.wygaszone).toEqual([]);
  });

  it("rezerwacja wygasła, sesja otwarta: wygasza sesję, żeby nikt nie zapłacił za stracony fotel", async () => {
    const { zegar, bramka, expiresAt, idSesji, idJoba } = await zSesja("B3");
    zegar.ustaw(expiresAt);
    expect(await przetworzOutbox(env.DB, bramka, { zegar })).toMatchObject({ wyslane: 1 });
    expect(bramka.wygaszone).toEqual([idSesji]);
    expect((await job(idJoba))?.completedAt).toBe(expiresAt);
  });

  it("zgubiony webhook: sesja opłacona, strażnik sam wydaje bilet, a późny webhook niczego nie zmienia", async () => {
    const { zegar, bramka, z, reservationId, expiresAt, idJoba } = await zSesja("B4");
    bramka.stanSesji = {
      status: "complete",
      oplacona: true,
      paymentIntentId: "pi_b4",
      kwota: 3200,
      waluta: "pln",
      oplaconoO: zegar.teraz() + 30_000,
    };
    zegar.przewin(60_000);
    expect(await przetworzOutbox(env.DB, bramka, { zegar })).toMatchObject({ wyslane: 1 });
    expect((await stanRezerwacji(z, reservationId)).cialo.status).toBe("paid");
    const kod = (await wierszMiejsca("B4"))?.code;
    expect((await job(idJoba))?.completedAt).not.toBeNull();

    await zaplac(z, reservationId, { paymentIntent: "pi_b4", paidAt: expiresAt - 1000 });
    expect((await wierszMiejsca("B4"))?.code).toBe(kod);
    expect(bramka.zwroty).toEqual([]);
    await przetworzOutbox(env.DB, bramka, { zegar });
    expect(bramka.zwroty).toEqual([]);
  });

  it("zapłacono mimo wygaśnięcia, a webhook zaginął: zwrot zamiast biletu", async () => {
    const { zegar, bramka, z, reservationId, expiresAt } = await zSesja("B5");
    bramka.stanSesji = {
      status: "complete",
      oplacona: true,
      paymentIntentId: "pi_b5",
      kwota: 3200,
      waluta: "pln",
      oplaconoO: expiresAt + 5000,
    };
    zegar.ustaw(expiresAt + 60_000);
    await przetworzOutbox(env.DB, bramka, { zegar });
    expect((await stanRezerwacji(z, reservationId)).cialo).toMatchObject({ status: "expired" });
    await przetworzOutbox(env.DB, bramka, { zegar });
    expect(bramka.zwroty.map((w) => w.paymentIntentId)).toEqual(["pi_b5"]);
  });

  it("rezerwacja już opłacona przez webhook: kończy się bez pytania Stripe'a", async () => {
    const { zegar, bramka, z, reservationId, idJoba } = await zSesja("B6");
    await zaplac(z, reservationId);
    const pobierz = vi.spyOn(bramka, "pobierzSesje");
    zegar.przewin(60_000);
    expect(await przetworzOutbox(env.DB, bramka, { zegar })).toMatchObject({ wyslane: 1 });
    expect(pobierz).not.toHaveBeenCalled();
    expect((await job(idJoba))?.completedAt).not.toBeNull();
  });

  it("sesja już wygasła po stronie Stripe'a: koniec pracy", async () => {
    const { zegar, bramka, expiresAt, idJoba } = await zSesja("B7");
    bramka.stanSesji = { status: "expired" };
    zegar.ustaw(expiresAt + 1);
    await przetworzOutbox(env.DB, bramka, { zegar });
    expect(bramka.wygaszone).toEqual([]);
    expect((await job(idJoba))?.completedAt).not.toBeNull();
  });
});

describe("Cron", () => {
  it("bez klucza Stripe'a wiadomości czekają w bazie", async () => {
    const { idJoba } = await platnoscPoCzasie("C1", "pi_c1");
    expect(await wyslijOutbox({ DB: env.DB })).toBeNull();
    expect((await job(idJoba))?.completedAt).toBeNull();
  });

  it("klucz produkcyjny nie uruchamia płatności ani zwrotów", async () => {
    expect(await wyslijOutbox({ DB: env.DB, STRIPE_SECRET_KEY: "sk_live_nie" })).toBeNull();
  });

  it("sprzątanie: inbox po 7 dniach, wysłane po 7 dniach, stara historia bez kupionych i bez otwartych zwrotów", async () => {
    const zegar = utworzZegarTestowy();
    const bramka = sztucznaBramka(zegar.teraz);
    const z = zaleznosci({ zegar, platnosci: bramka });
    const kupiona = await zarezerwuj(z, { seatId: "D1", email: "k@example.com" });
    await zaplac(z, kupiona.cialo.reservationId, { id: "evt_stary" });
    const porzucona = await zarezerwuj(z, { seatId: "D2", email: "p@example.com" });
    const zwrotDoZrobienia = await zarezerwuj(z, { seatId: "D3", email: "z@example.com" });
    zegar.przewin(TTL_MS + 1);
    await zaplac(z, zwrotDoZrobienia.cialo.reservationId, { paymentIntent: "pi_d3" });

    // Wiersz porzuconej rezerwacji zwalnia Cron; fotel nie wskazuje już na nią.
    await env.DB.prepare("UPDATE seats SET status = 'free', reservationId = NULL, expiresAt = NULL WHERE seatId = 'D2'").run();

    await sprzatnijHistorie({ DB: env.DB }, zegar.teraz() + 6 * DOBA_MS);
    expect(await env.DB.prepare("SELECT id FROM inbox WHERE id = 'evt_stary'").first()).not.toBeNull();

    await sprzatnijHistorie({ DB: env.DB }, zegar.teraz() + 8 * DOBA_MS);
    expect(await env.DB.prepare("SELECT id FROM inbox WHERE id = 'evt_stary'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM reservations WHERE id = ?1").bind(porzucona.cialo.reservationId).first()).not.toBeNull();

    await sprzatnijHistorie({ DB: env.DB }, zegar.teraz() + 31 * DOBA_MS);
    const pozostale = async (id: string) => env.DB.prepare("SELECT id FROM reservations WHERE id = ?1").bind(id).first();
    expect(await pozostale(porzucona.cialo.reservationId)).toBeNull();
    expect(await pozostale(kupiona.cialo.reservationId)).not.toBeNull();
    expect(await pozostale(zwrotDoZrobienia.cialo.reservationId)).not.toBeNull();
    // Zwrot wciąż czeka, więc job nie znika.
    expect(await job("stripe-refund:pi_d3")).not.toBeNull();
  });
});
