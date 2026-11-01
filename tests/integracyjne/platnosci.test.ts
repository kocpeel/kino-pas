// Etap II: karta A (cena, sesja płatności), karta B (webhook, inbox), płatność po czasie i odczyt rezerwacji.
// Prawdziwy D1, prawdziwa weryfikacja podpisu z SDK, Stripe bez sieci (sztuczna bramka).

import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { utworzZegarTestowy } from "../../src/lib/czas";
import { zwolnijWygasleRezerwacje } from "../../src/lib/db/zapytania-miejsca";
import { obsluzZdarzeniePlatnosci } from "../../src/lib/domain/platnosc";
import { obsluzWebhookStripe } from "../../src/lib/http/trasy";
import {
  CENA,
  checkout,
  odbierzKod,
  SEANS,
  stanRezerwacji,
  sztucznaBramka,
  TTL_MS,
  wierszMiejsca,
  wyslijZdarzenie,
  zadanieRezerwacji,
  zadanieWebhooka,
  zaplac,
  zarezerwuj,
  zasiej,
  zaleznosci,
  zdarzenieOplacenia,
  zepsutaBaza,
} from "./pomocnicze";

beforeEach(async () => {
  await zasiej();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const NIEZNANA = "0f8fad5b-d9cb-469f-a165-70867728950e";

async function liczba(tabela: string): Promise<number> {
  const w = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${tabela}`).first<{ n: number }>();
  return w?.n ?? 0;
}

async function jobyZwrotu() {
  const { results } = await env.DB.prepare(`SELECT * FROM outbox WHERE task = 'stripe-refund'`).all<{
    id: string;
    input: string;
  }>();
  return results;
}

describe("cena i kwota", () => {
  it("POST /api/reservations zwraca amount, a późniejsza zmiana ceny go nie rusza", async () => {
    const z = zaleznosci();
    const r = await zarezerwuj(z, { seatId: "A1" }, { klucz: "cena-klucz-0001" });
    expect(r.cialo.amount).toBe(CENA);

    await env.DB.prepare("UPDATE events SET price = 9900 WHERE id = ?1").bind(SEANS).run();

    expect((await stanRezerwacji(z, r.cialo.reservationId)).cialo.amount).toBe(CENA);
    const powtorka = await zarezerwuj(z, { seatId: "A1" }, { klucz: "cena-klucz-0001" });
    expect(powtorka.cialo).toEqual(r.cialo);
    await checkout(z, r.cialo.reservationId);
    const [sesja] = [...(z.platnosci as ReturnType<typeof sztucznaBramka>).sesje.values()];
    expect(sesja?.parametry.amount).toBe(CENA);
    // Nowa rezerwacja ma już nową cenę.
    expect((await zarezerwuj(z, { seatId: "A2", email: "nowa@example.com" })).cialo.amount).toBe(9900);
  });
});

describe("POST /api/reservations/:id/checkout", () => {
  it("tworzy sesję z kwotą z rezerwacji, adresami powrotu i id rezerwacji", async () => {
    const zegar = utworzZegarTestowy();
    const bramka = sztucznaBramka(zegar.teraz);
    const z = zaleznosci({ zegar, platnosci: bramka });
    const r = await zarezerwuj(z, { seatId: "F7" });
    const id = r.cialo.reservationId;

    const odp = await checkout(z, id);
    expect(odp.status).toBe(200);
    expect(Object.keys(odp.cialo)).toEqual(["url"]);
    expect(odp.cialo.url).toMatch(/^https:\/\/checkout\.stripe\.test\//);

    const sesja = bramka.sesje.get(`checkout:${id}`);
    expect(sesja?.parametry).toMatchObject({
      reservationId: id,
      amount: CENA,
      nazwa: "Bilet: Metropolis",
      adresSukcesu: `https://kasa.test/bilet/${id}?seans=${SEANS}&miejsce=F7&session_id={CHECKOUT_SESSION_ID}`,
      adresPrzerwania: `https://kasa.test/rezerwacja/${id}?seans=${SEANS}&miejsce=F7&platnosc=przerwana`,
    });
    expect(sesja?.parametry.opis).toContain("Rząd F, miejsce 7");
    expect(sesja?.parametry.uwaga).toMatch(/do \d\d:\d\d:\d\d\./);
  });

  it("podwójne kliknięcie: po kolei i równolegle ta sama sesja", async () => {
    const bramka = sztucznaBramka(utworzZegarTestowy().teraz);
    const z = zaleznosci({ platnosci: bramka });
    const { reservationId } = (await zarezerwuj(z, { seatId: "B1" })).cialo;

    const wyniki = await Promise.all(Array.from({ length: 10 }, () => checkout(z, reservationId)));
    expect(wyniki.every((w) => w.status === 200)).toBe(true);
    expect(new Set(wyniki.map((w) => w.cialo.url)).size).toBe(1);
    expect(bramka.sesje.size).toBe(1);

    // Kolejne kliknięcie (np. powrót po przerwanej płatności) nie idzie już do Stripe'a.
    const przed = bramka.wywolaniaUtworz;
    expect((await checkout(z, reservationId)).cialo.url).toBe(wyniki[0]?.cialo.url);
    expect(bramka.wywolaniaUtworz).toBe(przed);
  });

  it("odmawia: wygasła 410, opłacona 409, nieznana 404, zły identyfikator 400", async () => {
    const zegar = utworzZegarTestowy();
    const z = zaleznosci({ zegar });
    const oplacona = await zarezerwuj(z, { seatId: "C1", email: "o@example.com" });
    await zaplac(z, oplacona.cialo.reservationId);
    const wygasla = await zarezerwuj(z, { seatId: "C2", email: "w@example.com" });
    zegar.przewin(TTL_MS);

    const odmowa = await checkout(z, wygasla.cialo.reservationId);
    expect(odmowa.status).toBe(410);
    expect(odmowa.cialo.error).toBe("reservation_expired");
    const juz = await checkout(z, oplacona.cialo.reservationId);
    expect(juz.status).toBe(409);
    expect(juz.cialo.error).toBe("reservation_already_paid");
    expect((await checkout(z, NIEZNANA)).status).toBe(404);
    expect((await checkout(z, "abc")).status).toBe(400);
  });

  it("Stripe nie odpowiada: 503 z Retry-After, rezerwacja dalej trzyma fotel, a ponowienie działa", async () => {
    const bramka = sztucznaBramka(utworzZegarTestowy().teraz);
    const z = zaleznosci({ platnosci: bramka });
    const { reservationId } = (await zarezerwuj(z, { seatId: "D1" })).cialo;

    bramka.awaria = new Error("connection refused");
    const odp = await checkout(z, reservationId);
    expect(odp.status).toBe(503);
    expect(odp.cialo.error).toBe("payments_unavailable");
    expect(odp.naglowki.get("retry-after")).not.toBeNull();
    expect((await stanRezerwacji(z, reservationId)).cialo.status).toBe("held");

    bramka.awaria = null;
    expect((await checkout(z, reservationId)).status).toBe(200);
  });

  it("bez klucza Stripe'a: 503, a nie 500", async () => {
    const z = zaleznosci({ platnosci: undefined });
    const { reservationId } = (await zarezerwuj(z, { seatId: "D2" })).cialo;
    expect((await checkout(z, reservationId)).status).toBe(503);
  });

  it("padamy między Stripe'em a zapisem: ponowienie dostaje tę samą sesję i ją zapisuje", async () => {
    const bramka = sztucznaBramka(utworzZegarTestowy().teraz);
    const z = zaleznosci({ platnosci: bramka });
    const { reservationId } = (await zarezerwuj(z, { seatId: "D3" })).cialo;

    // Baza, której pierwszy zapis (batch sesji) się nie uda, a odczyty działają.
    const padajaca = { ...env.DB, prepare: env.DB.prepare.bind(env.DB), batch: () => Promise.reject(new Error("D1_ERROR: padło")) };
    const zPadajaca = zaleznosci({ platnosci: bramka, db: padajaca as unknown as D1Database });
    expect((await checkout(zPadajaca, reservationId)).status).toBe(503);
    expect(bramka.sesje.size).toBe(1);

    const ponowienie = await checkout(z, reservationId);
    expect(ponowienie.status).toBe(200);
    expect(bramka.sesje.size).toBe(1);
    const wiersz = await env.DB.prepare("SELECT stripeSessionUrl FROM reservations WHERE id = ?1").bind(reservationId).first();
    expect(wiersz?.stripeSessionUrl).toBe(ponowienie.cialo.url);
  });
});

describe("POST /api/webhooks/stripe: podpis", () => {
  it.each([
    ["bez podpisu", { podpis: null }],
    ["podpis innym sekretem", { sekret: "whsec_inny" }],
    ["znacznik czasu sprzed godziny", { timestamp: Math.floor(Date.now() / 1000) - 3600 }],
  ])("%s → 400 i nic się nie zmienia", async (_opis, opcje) => {
    const z = zaleznosci();
    const { reservationId } = (await zarezerwuj(z, { seatId: "E1" })).cialo;
    const odp = await obsluzWebhookStripe(await zadanieWebhooka(zdarzenieOplacenia(reservationId), opcje), () => z);
    expect(odp.status).toBe(400);
    expect(((await odp.json()) as { error: string }).error).toBe("invalid_signature");
    expect((await wierszMiejsca("E1"))?.status).toBe("reserved");
    expect(await liczba("inbox")).toBe(0);
  });

  it("podmienione ciało przy prawdziwym podpisie → 400", async () => {
    const z = zaleznosci();
    const { reservationId } = (await zarezerwuj(z, { seatId: "E2" })).cialo;
    const prawdziwe = await zadanieWebhooka(zdarzenieOplacenia(reservationId, { amount: 1 }));
    const podmienione = new Request(prawdziwe.url, {
      method: "POST",
      headers: prawdziwe.headers,
      body: JSON.stringify(zdarzenieOplacenia(reservationId)),
    });
    expect((await obsluzWebhookStripe(podmienione, () => z)).status).toBe(400);
    expect((await wierszMiejsca("E2"))?.status).toBe("reserved");
  });

  it("brak sekretu w konfiguracji → 503, żeby Stripe ponowił, gdy to naprawimy", async () => {
    const z = zaleznosci({ sekretWebhooka: undefined });
    const { reservationId } = (await zarezerwuj(z, { seatId: "E3" })).cialo;
    expect((await zaplac(z, reservationId)).status).toBe(503);
  });

  it("pełna ścieżka Workera: prawdziwy podpis przez trasę", async () => {
    const utworzona = await exports.default.fetch(zadanieRezerwacji({ seatId: "E4", email: "w@example.com" }, { ip: "10.2.0.1" }));
    const { reservationId } = (await utworzona.json()) as { reservationId: string };
    const odp = await exports.default.fetch(await zadanieWebhooka(zdarzenieOplacenia(reservationId)));
    expect(odp.status).toBe(200);
    expect(await odp.json()).toEqual({ received: true });
    const stan = await exports.default.fetch(new Request(`https://kasa.test/api/reservations/${reservationId}`));
    expect(await stan.json()).toMatchObject({ status: "paid", amount: CENA, code: expect.stringMatching(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/) });
  });
});

describe("POST /api/webhooks/stripe: inbox", () => {
  it("udana płatność zamienia rezerwację w bilet", async () => {
    const z = zaleznosci();
    const r = await zarezerwuj(z, { seatId: "F1" });
    const odp = await zaplac(z, r.cialo.reservationId, { paymentIntent: "pi_jeden" });
    expect(odp.status).toBe(200);
    expect(odp.cialo).toEqual({ received: true });

    const wiersz = await wierszMiejsca("F1");
    expect(wiersz).toMatchObject({ status: "purchased", expiresAt: null, reservationId: r.cialo.reservationId });
    expect(wiersz?.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(await liczba("inbox")).toBe(1);
    expect(await jobyZwrotu()).toEqual([]);
  });

  it("to samo zdarzenie dwa razy: 200 obu razy, jeden bilet, ten sam kod", async () => {
    const z = zaleznosci();
    const { reservationId } = (await zarezerwuj(z, { seatId: "F2" })).cialo;
    const zdarzenie = zdarzenieOplacenia(reservationId, { paidAt: z.zegar.teraz() });

    expect((await wyslijZdarzenie(z, zdarzenie)).status).toBe(200);
    const kod = (await wierszMiejsca("F2"))?.code;
    expect((await wyslijZdarzenie(z, zdarzenie)).status).toBe(200);

    expect((await wierszMiejsca("F2"))?.code).toBe(kod);
    expect((await wierszMiejsca("F2"))?.version).toBe(2);
    expect(await liczba("inbox")).toBe(1);
  });

  it("10 równoległych dostarczeń: jeden bilet", async () => {
    const z = zaleznosci();
    const { reservationId } = (await zarezerwuj(z, { seatId: "F3" })).cialo;
    const zdarzenie = zdarzenieOplacenia(reservationId, { paidAt: z.zegar.teraz() });
    const wyniki = await Promise.all(Array.from({ length: 10 }, () => wyslijZdarzenie(z, zdarzenie)));
    expect(wyniki.every((w) => w.status === 200)).toBe(true);
    expect(await liczba("inbox")).toBe(1);
    expect((await wierszMiejsca("F3"))?.version).toBe(2);
  });

  it("inne zdarzenie o tej samej płatności: ten sam bilet i bez zwrotu", async () => {
    const z = zaleznosci();
    const { reservationId } = (await zarezerwuj(z, { seatId: "F4" })).cialo;
    await zaplac(z, reservationId, { paymentIntent: "pi_ta_sama" });
    const kod = (await wierszMiejsca("F4"))?.code;
    await zaplac(z, reservationId, { paymentIntent: "pi_ta_sama", type: "checkout.session.async_payment_succeeded" });
    expect((await wierszMiejsca("F4"))?.code).toBe(kod);
    expect(await jobyZwrotu()).toEqual([]);
  });

  it("druga, inna płatność za opłaconą rezerwację wraca do klienta", async () => {
    const z = zaleznosci();
    const { reservationId } = (await zarezerwuj(z, { seatId: "F5" })).cialo;
    await zaplac(z, reservationId, { paymentIntent: "pi_pierwsza" });
    await zaplac(z, reservationId, { paymentIntent: "pi_druga" });
    expect((await jobyZwrotu()).map((j) => j.id)).toEqual(["stripe-refund:pi_druga"]);
    expect((await stanRezerwacji(z, reservationId)).cialo).toMatchObject({ status: "paid", refund: "pending" });
  });

  it("inne typy zdarzeń i nieopłacona sesja: 200 bez skutku, a opóźnione potwierdzenie daje bilet", async () => {
    const z = zaleznosci();
    const { reservationId } = (await zarezerwuj(z, { seatId: "F6" })).cialo;
    expect((await zaplac(z, reservationId, { type: "payment_intent.created" })).status).toBe(200);
    expect((await zaplac(z, reservationId, { paymentStatus: "unpaid" })).status).toBe(200);
    expect((await wierszMiejsca("F6"))?.status).toBe("reserved");
    expect(await liczba("inbox")).toBe(0);

    await zaplac(z, reservationId, { type: "checkout.session.async_payment_succeeded" });
    expect((await wierszMiejsca("F6"))?.status).toBe("purchased");
  });

  it("zdarzenie cudzej rezerwacji (inne środowisko na tym samym koncie Stripe): 200, bez zwrotu", async () => {
    const z = zaleznosci();
    expect((await zaplac(z, NIEZNANA)).status).toBe(200);
    expect((await wyslijZdarzenie(z, zdarzenieOplacenia(null))).status).toBe(200);
    expect((await wyslijZdarzenie(z, zdarzenieOplacenia("abc"))).status).toBe(200);
    expect(await jobyZwrotu()).toEqual([]);
    expect(await liczba("inbox")).toBe(0);
  });

  it("zła kwota albo waluta: bez biletu, a płatność wraca", async () => {
    const z = zaleznosci();
    const a = await zarezerwuj(z, { seatId: "F7", email: "a@example.com" });
    const b = await zarezerwuj(z, { seatId: "F8", email: "b@example.com" });
    await zaplac(z, a.cialo.reservationId, { amount: CENA - 1, paymentIntent: "pi_kwota" });
    await zaplac(z, b.cialo.reservationId, { currency: "eur", paymentIntent: "pi_waluta" });
    expect((await wierszMiejsca("F7"))?.status).toBe("reserved");
    expect((await wierszMiejsca("F8"))?.status).toBe("reserved");
    expect((await jobyZwrotu()).map((j) => j.id).sort()).toEqual(["stripe-refund:pi_kwota", "stripe-refund:pi_waluta"]);
  });

  it("kolizja wylosowanego kodu: nowe losowanie i cała transakcja jeszcze raz, a zdarzenie zostaje w inboxie raz", async () => {
    const z = zaleznosci();
    const a = await zarezerwuj(z, { seatId: "G6", email: "a@example.com" });
    const b = await zarezerwuj(z, { seatId: "G7", email: "b@example.com" });
    await zaplac(z, a.cialo.reservationId);
    const zajetyKod = (await wierszMiejsca("G6"))?.code as string;

    const kody = [zajetyKod, "ZZZZ-ZZZZ"];
    const zdarzenie = zdarzenieOplacenia(b.cialo.reservationId, { paidAt: z.zegar.teraz() });
    const wynik = await obsluzZdarzeniePlatnosci(env.DB, zdarzenie, {
      teraz: z.zegar.teraz(),
      generujKod: () => kody.shift() as string,
    });
    expect(wynik.biletWydany).toBe(true);
    expect((await wierszMiejsca("G7"))?.code).toBe("ZZZZ-ZZZZ");
    expect(await liczba("inbox")).toBe(2);
  });

  it("awaria bazy: 503, żeby Stripe ponowił, a ponowienie dochodzi do skutku", async () => {
    const z = zaleznosci();
    const { reservationId } = (await zarezerwuj(z, { seatId: "G1" })).cialo;
    const zdarzenie = zdarzenieOplacenia(reservationId, { paidAt: z.zegar.teraz() });
    expect((await wyslijZdarzenie(zaleznosci({ db: zepsutaBaza() }), zdarzenie)).status).toBe(503);
    expect(await liczba("inbox")).toBe(0);
    expect((await wyslijZdarzenie(z, zdarzenie)).status).toBe(200);
    expect((await wierszMiejsca("G1"))?.status).toBe("purchased");
  });
});

describe("płatność a czas (sesja Stripe'a żyje co najmniej 30 minut, rezerwacja krócej)", () => {
  it("płatność po wygaśnięciu: bez biletu, fotel wolny, zwrot w outboxie, status expired", async () => {
    const zegar = utworzZegarTestowy();
    const z = zaleznosci({ zegar });
    const { reservationId, expiresAt } = (await zarezerwuj(z, { seatId: "H1" })).cialo;
    zegar.ustaw(expiresAt + 1000);

    expect((await zaplac(z, reservationId, { paymentIntent: "pi_po_czasie" })).status).toBe(200);

    expect((await wierszMiejsca("H1"))?.status).toBe("reserved"); // nieaktywna, fotel do wzięcia
    const stan = await stanRezerwacji(z, reservationId);
    expect(stan.cialo).toEqual({ status: "expired", amount: CENA, expiresAt, refund: "pending" });
    expect(await jobyZwrotu()).toEqual([expect.objectContaining({ id: "stripe-refund:pi_po_czasie" })]);
    expect((await zarezerwuj(z, { seatId: "H1", email: "nastepny@example.com" })).status).toBe(201);
  });

  it("zapłacono na czas, webhook spóźniony: liczy się chwila płatności, klient dostaje bilet", async () => {
    const zegar = utworzZegarTestowy();
    const z = zaleznosci({ zegar });
    const { reservationId, expiresAt } = (await zarezerwuj(z, { seatId: "H2" })).cialo;
    zegar.ustaw(expiresAt + 30_000);
    await zaplac(z, reservationId, { paidAt: expiresAt - 2000 });
    expect((await stanRezerwacji(z, reservationId)).cialo.status).toBe("paid");
    expect(await jobyZwrotu()).toEqual([]);
  });

  it("zapłacono na czas, a Cron już zwolnił fotel: bilet, bo nikt inny go nie wziął", async () => {
    const zegar = utworzZegarTestowy();
    const z = zaleznosci({ zegar });
    const { reservationId, expiresAt } = (await zarezerwuj(z, { seatId: "H3" })).cialo;
    zegar.ustaw(expiresAt + 60_000);
    await zwolnijWygasleRezerwacje(env.DB, zegar.teraz());
    expect((await wierszMiejsca("H3"))?.status).toBe("free");

    await zaplac(z, reservationId, { paidAt: expiresAt - 1000 });
    expect(await wierszMiejsca("H3")).toMatchObject({ status: "purchased", reservationId, expiresAt: null });
    expect((await stanRezerwacji(z, reservationId)).cialo.status).toBe("paid");
  });

  it("zapłacono na czas, ale fotel ma już inny, żywy właściciel: on zostaje, a pieniądze wracają", async () => {
    const zegar = utworzZegarTestowy();
    const z = zaleznosci({ zegar });
    const x = await zarezerwuj(z, { seatId: "H4", email: "x@example.com" });
    zegar.ustaw(x.cialo.expiresAt + 1);
    const y = await zarezerwuj(z, { seatId: "H4", email: "y@example.com" });
    await zaplac(z, x.cialo.reservationId, { paidAt: x.cialo.expiresAt - 1000, paymentIntent: "pi_x" });

    expect(await wierszMiejsca("H4")).toMatchObject({ status: "reserved", reservationId: y.cialo.reservationId, email: "y@example.com" });
    expect((await stanRezerwacji(z, x.cialo.reservationId)).cialo).toMatchObject({ status: "expired", refund: "pending" });
    expect((await stanRezerwacji(z, y.cialo.reservationId)).cialo.status).toBe("held");
    expect((await jobyZwrotu()).map((j) => j.id)).toEqual(["stripe-refund:pi_x"]);
  });

  it("zapłacono na czas, a fotel przejmuje cudza, już wygasła rezerwacja: bilet bez cudzych danych", async () => {
    const zegar = utworzZegarTestowy();
    const z = zaleznosci({ zegar });
    const x = await zarezerwuj(z, { seatId: "H5", email: "x@example.com" });
    zegar.ustaw(x.cialo.expiresAt + 1);
    const y = await zarezerwuj(z, { seatId: "H5", name: "Inna Osoba", email: "y@example.com" });
    zegar.ustaw(y.cialo.expiresAt + 1);

    await zaplac(z, x.cialo.reservationId, { paidAt: x.cialo.expiresAt - 1000 });
    expect(await wierszMiejsca("H5")).toMatchObject({
      status: "purchased",
      reservationId: x.cialo.reservationId,
      email: null,
      customerName: null,
      secretHash: null,
    });
  });

  it("5 razy z rzędu: na granicy wygaśnięcia płatność X i rezerwacja Y równolegle, zawsze jeden właściciel", async () => {
    for (let runda = 1; runda <= 5; runda++) {
      const seatId = `G${runda + 1}`;
      const zegar = utworzZegarTestowy();
      const z = zaleznosci({ zegar });
      const x = await zarezerwuj(z, { seatId, email: `x${runda}@example.com` });
      const { reservationId, expiresAt } = x.cialo;
      zegar.ustaw(expiresAt);

      const [platnosc, rezerwacjaY] = await Promise.all([
        zaplac(z, reservationId, { paidAt: expiresAt - 500, paymentIntent: `pi_${runda}` }),
        zarezerwuj(z, { seatId, email: `y${runda}@example.com` }),
      ]);
      expect(platnosc.status).toBe(200);

      const wiersz = await wierszMiejsca(seatId);
      const stanX = (await stanRezerwacji(z, reservationId)).cialo;
      if (rezerwacjaY.status === 201) {
        // Y wygrał: X nie ma biletu, a jego pieniądze wracają.
        expect(wiersz).toMatchObject({ status: "reserved", reservationId: rezerwacjaY.cialo.reservationId });
        expect(stanX).toMatchObject({ status: "expired", refund: "pending" });
      } else {
        expect(rezerwacjaY.status).toBe(409);
        expect(wiersz).toMatchObject({ status: "purchased", reservationId });
        expect(stanX.status).toBe("paid");
        expect(stanX.refund).toBeUndefined();
      }
    }
  });

  it("kupione miejsce nie zwalnia się po czasie", async () => {
    const zegar = utworzZegarTestowy();
    const z = zaleznosci({ zegar });
    const { reservationId } = (await zarezerwuj(z, { seatId: "A5" })).cialo;
    await zaplac(z, reservationId);
    zegar.przewin(10 * TTL_MS);
    await zwolnijWygasleRezerwacje(env.DB, zegar.teraz());
    expect((await wierszMiejsca("A5"))?.status).toBe("purchased");
    expect((await stanRezerwacji(z, reservationId)).cialo.status).toBe("paid");
    expect((await zarezerwuj(z, { seatId: "A5", email: "inny@example.com" })).status).toBe(409);
  });
});

describe("GET /api/reservations/:id", () => {
  it("held → dokładnie { status, amount, expiresAt }", async () => {
    const z = zaleznosci();
    const r = await zarezerwuj(z, { seatId: "B5" });
    const stan = await stanRezerwacji(z, r.cialo.reservationId);
    expect(stan.status).toBe(200);
    expect(stan.cialo).toEqual({ status: "held", amount: CENA, expiresAt: r.cialo.expiresAt });
    expect(stan.naglowki.get("cache-control")).toBe("no-store");
  });

  it("paid → z kodem i tym samym expiresAt, także po kolejnych odczytach", async () => {
    const z = zaleznosci();
    const r = await zarezerwuj(z, { seatId: "B6" });
    await zaplac(z, r.cialo.reservationId);
    const kod = (await wierszMiejsca("B6"))?.code;
    expect((await stanRezerwacji(z, r.cialo.reservationId)).cialo).toEqual({
      status: "paid",
      amount: CENA,
      expiresAt: r.cialo.expiresAt,
      code: kod,
    });
  });

  it("expired → także gdy fotel ma już nowego właściciela (historia rezerwacji)", async () => {
    const zegar = utworzZegarTestowy();
    const z = zaleznosci({ zegar });
    const r = await zarezerwuj(z, { seatId: "B7", email: "s@example.com" });
    zegar.ustaw(r.cialo.expiresAt);
    expect((await stanRezerwacji(z, r.cialo.reservationId)).cialo.status).toBe("expired");

    await zarezerwuj(z, { seatId: "B7", email: "n@example.com" });
    expect((await stanRezerwacji(z, r.cialo.reservationId)).cialo).toEqual({
      status: "expired",
      amount: CENA,
      expiresAt: r.cialo.expiresAt,
    });
  });

  it("nieznana 404, zły identyfikator 400, awaria bazy 503", async () => {
    expect((await stanRezerwacji(zaleznosci(), NIEZNANA)).status).toBe(404);
    expect((await stanRezerwacji(zaleznosci(), "abc")).status).toBe(400);
    expect((await stanRezerwacji(zaleznosci({ db: zepsutaBaza() }), NIEZNANA)).status).toBe(503);
  });
});

describe("POST /api/reservations/:id/purchase po wprowadzeniu płatności", () => {
  it("nie ma drogi na skróty: bez płatności 402, po płatności ten sam kod", async () => {
    const z = zaleznosci();
    const { reservationId } = (await zarezerwuj(z, { seatId: "C5" })).cialo;
    const bezPlatnosci = await odbierzKod(z, reservationId);
    expect(bezPlatnosci.status).toBe(402);
    expect(bezPlatnosci.cialo.error).toBe("payment_required");
    expect((await wierszMiejsca("C5"))?.status).toBe("reserved");

    await zaplac(z, reservationId);
    const kod = (await wierszMiejsca("C5"))?.code;
    const [a, b] = await Promise.all([odbierzKod(z, reservationId), odbierzKod(z, reservationId)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.cialo.code, b.cialo.code]).toEqual([kod, kod]);
  });

  it("po czasie i dla nieznanej 410, zły identyfikator 400", async () => {
    const zegar = utworzZegarTestowy();
    const z = zaleznosci({ zegar });
    const { reservationId } = (await zarezerwuj(z, { seatId: "C6" })).cialo;
    zegar.przewin(TTL_MS);
    expect((await odbierzKod(z, reservationId)).status).toBe(410);
    expect((await odbierzKod(z, NIEZNANA)).status).toBe(410);
    expect((await odbierzKod(z, "abc")).status).toBe(400);
  });
});
