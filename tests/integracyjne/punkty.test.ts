// Etap III: program punktowy (Voucherify) i mail z biletem (Resend) jako kroki sagi zakupu (E08).
// Bez sieci: sztuczny Voucherify i sztuczny Resend trzymają reguły z dokumentacji (karta na klienta, historia
// operacji z naszym source_id, klucz idempotencji maila), a baza i podpisy webhooków są prawdziwe.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { utworzZegarTestowy } from "../../src/lib/czas";
import { przetworzOutbox } from "../../src/lib/domain/outbox";
import { obsluzWebhookResend } from "../../src/lib/http/trasy";
import { BladMaila } from "../../src/lib/maile/resend";
import { BladPunktow } from "../../src/lib/punkty/voucherify";
import {
  checkout,
  saldo,
  stanRezerwacji,
  sztucznaBramka,
  sztuczneKonto,
  sztucznyMailer,
  uslugaPunktow,
  wierszMiejsca,
  zaplac,
  zarezerwuj,
  zasiej,
  zaleznosci,
  type SztuczneKonto,
} from "./pomocnicze";
import type { BudzetWywolan } from "../../src/lib/punkty/budzet";

beforeEach(async () => {
  await zasiej();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

function srodowisko(opcje: { budzet?: BudzetWywolan } = {}) {
  const zegar = utworzZegarTestowy();
  const bramka = sztucznaBramka(zegar.teraz);
  const konto = sztuczneKonto();
  const mailer = sztucznyMailer();
  const punkty = uslugaPunktow(konto, opcje);
  const z = zaleznosci({ zegar, platnosci: bramka, punkty });
  const outbox = () => przetworzOutbox(env.DB, { platnosci: bramka, punkty, maile: mailer }, { zegar });
  return { zegar, bramka, konto, mailer, z, outbox };
}

async function saga(id: string) {
  const w = await env.DB.prepare("SELECT status, completed, results FROM sagas WHERE id = ?1")
    .bind(id)
    .first<{ status: string; completed: string; results: string }>();
  return w ? { status: w.status, completed: JSON.parse(w.completed) as string[], results: JSON.parse(w.results) as Record<string, unknown> } : null;
}

async function job(id: string) {
  return env.DB.prepare("SELECT id, totalTried, completedAt, hasError, visibleAt FROM outbox WHERE id = ?1").bind(id).first<{
    totalTried: number;
    completedAt: number | null;
    hasError: number;
    visibleAt: number;
  }>();
}

function operacje(konto: SztuczneKonto, email: string, sourceId?: string) {
  const ops = konto.karty.get(email)?.operacje ?? [];
  return sourceId ? ops.filter((o) => o.sourceId === sourceId) : ops;
}

/** Klient, który już ma kartę u nas i w Voucherify (założoną przez nasz sklep, z punktami powitalnymi). */
async function znanyKlient(konto: SztuczneKonto, email: string, punkty: number) {
  konto.karty.set(email, { memberId: `KARTA-${email}`, saldo: punkty, operacje: [] });
  await env.DB.prepare(`INSERT INTO loyalty_accounts (email, memberId, cardRequestedAt, welcomeAt, createdAt) VALUES (?1, ?2, 1, 1, 1)`)
    .bind(email, `KARTA-${email}`)
    .run();
}

describe("GET /api/loyalty", () => {
  it("e-mail, który nic jeszcze nie kupił (bez karty w Voucherify), ma 1000 punktów; karty nie zakładamy", async () => {
    const { z, konto } = srodowisko();
    const odp = await saldo(z, "Nowy@Example.com");
    expect(odp.status).toBe(200);
    expect(odp.cialo).toEqual({ email: "nowy@example.com", points: 1000 });
    expect(odp.naglowki.get("x-data-stale")).toBeNull();
    expect(konto.wywolania).toEqual(["znajdz:nowy@example.com"]);
    expect(konto.karty.size).toBe(0);
  });

  it("karta z innego kanału (aplikacja, kasy): saldo z Voucherify, a przy zakupie bez punktów powitalnych", async () => {
    const { z, konto } = srodowisko();
    konto.karty.set("app@example.com", { memberId: "KARTA-APP", saldo: 450, operacje: [] });
    expect((await saldo(z, "app@example.com")).cialo).toEqual({ email: "app@example.com", points: 450 });

    const { reservationId } = (await zarezerwuj(z, { seatId: "D1", email: "app@example.com" })).cialo;
    expect((await checkout(z, reservationId, { points: 450 })).status).toBe(200);
    expect(operacje(konto, "app@example.com").map((o) => [o.sourceId, o.punkty])).toEqual([[`wydanie:${reservationId}`, -450]]);
    expect((await saldo(z, "app@example.com")).cialo.points).toBe(0);
  });

  it("Voucherify nie odpowiada, e-mail nieznany: 1000 punktów powitalnych z X-Data-Stale", async () => {
    const { z, konto } = srodowisko();
    konto.awaria = new BladPunktow("Voucherify nie odpowiada", "przejsciowy", { niepewny: false });
    const odp = await saldo(z, "nowy@example.com");
    expect(odp.status).toBe(200);
    expect(odp.cialo.points).toBe(1000);
    expect(odp.naglowki.get("x-data-stale")).toBe("true");
  });

  it("zły e-mail → 400", async () => {
    const { z } = srodowisko();
    const odp = await saldo(z, "to-nie-email");
    expect(odp.status).toBe(400);
    expect(odp.cialo.error).toBe("invalid_input");
  });

  it("znany klient: saldo z Voucherify, potem z pamięci, a po jej czasie znów z Voucherify", async () => {
    const { z, konto, zegar } = srodowisko();
    await znanyKlient(konto, "k@example.com", 700);
    expect((await saldo(z, "k@example.com")).cialo.points).toBe(700);
    expect((await saldo(z, "k@example.com")).cialo.points).toBe(700);
    expect(konto.wywolania.filter((w) => w.startsWith("saldo:"))).toHaveLength(1);

    konto.karty.get("k@example.com")!.saldo = 650; // np. kasa w kinie
    zegar.przewin(31_000);
    expect((await saldo(z, "k@example.com")).cialo.points).toBe(650);
  });

  it("Voucherify nie odpowiada: ostatnie znane saldo z X-Data-Stale, a bez żadnego znanego salda 503", async () => {
    const { z, konto, zegar } = srodowisko();
    await znanyKlient(konto, "k@example.com", 700);
    await znanyKlient(konto, "bez-pamieci@example.com", 100);
    await saldo(z, "k@example.com");
    zegar.przewin(60_000);
    konto.awaria = new BladPunktow("Voucherify nie odpowiada", "przejsciowy", { niepewny: false });

    const stare = await saldo(z, "k@example.com");
    expect(stare.status).toBe(200);
    expect(stare.cialo.points).toBe(700);
    expect(stare.naglowki.get("x-data-stale")).toBe("true");

    const brak = await saldo(z, "bez-pamieci@example.com");
    expect(brak.status).toBe(503);
    expect(brak.cialo.error).toBe("points_unavailable");
  });
});

describe("checkout z punktami (kroki 1 i 2 sagi)", () => {
  it("nowy klient: karta z 1000 punktów powitalnych, 1000 schodzi, sesja na 22 zł", async () => {
    const { z, konto, bramka } = srodowisko();
    const r = await zarezerwuj(z, { seatId: "A1", email: "nowy@example.com" });
    const id = r.cialo.reservationId;

    const odp = await checkout(z, id, { points: 1000 });
    expect(odp.status).toBe(200);
    expect(bramka.sesje.get(`checkout:${id}:1000`)?.parametry.amount).toBe(2200);
    expect(operacje(konto, "nowy@example.com").map((o) => [o.sourceId, o.punkty])).toEqual([
      ["powitanie:nowy@example.com", 1000],
      [`wydanie:${id}`, -1000],
    ]);
    expect((await stanRezerwacji(z, id)).cialo).toMatchObject({ status: "held", pointsUsed: 1000 });
    expect(await saga(id)).toMatchObject({ status: "running", completed: ["punkty", "platnosc"] });
    expect((await saldo(z, "nowy@example.com")).cialo.points).toBe(0);
  });

  it("więcej niż połowa ceny albo ułamek → 400, bez wywołania Voucherify i bez sesji", async () => {
    const { z, konto, bramka } = srodowisko();
    const { reservationId } = (await zarezerwuj(z, { seatId: "A2", email: "a2@example.com" })).cialo;
    for (const points of [1601, 10.5, -1, "1000"]) {
      const odp = await checkout(z, reservationId, { points });
      expect(odp.status).toBe(400);
      expect(odp.cialo.error).toBe("invalid_input");
    }
    expect(konto.wywolania).toEqual([]);
    expect(bramka.wywolaniaUtworz).toBe(0);
  });

  it("za mało punktów → 422, punkty i sesja bez zmian", async () => {
    const { z, konto, bramka } = srodowisko();
    await znanyKlient(konto, "maly@example.com", 500);
    const { reservationId } = (await zarezerwuj(z, { seatId: "A3", email: "maly@example.com" })).cialo;

    const odp = await checkout(z, reservationId, { points: 1000 });
    expect(odp.status).toBe(422);
    expect(odp.cialo.error).toBe("not_enough_points");
    expect(konto.karty.get("maly@example.com")?.saldo).toBe(500);
    expect(bramka.wywolaniaUtworz).toBe(0);
    // Ten sam klient może zapłacić tym, co ma.
    expect((await checkout(z, reservationId, { points: 500 })).status).toBe(200);
  });

  it("dwa równoległe checkouty (podwójne „Zapłać”): punkty schodzą raz, ten sam adres", async () => {
    const { z, konto } = srodowisko();
    await znanyKlient(konto, "dwa@example.com", 3000);
    const { reservationId } = (await zarezerwuj(z, { seatId: "A4", email: "dwa@example.com" })).cialo;

    const [a, b] = await Promise.all([checkout(z, reservationId, { points: 1000 }), checkout(z, reservationId, { points: 1000 })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.cialo.url).toBe(b.cialo.url);
    expect(operacje(konto, "dwa@example.com", `wydanie:${reservationId}`)).toHaveLength(1);
    expect(konto.karty.get("dwa@example.com")?.saldo).toBe(2000);
  });

  it("dwie rezerwacje jednego klienta naraz: nie wydadzą tych samych punktów", async () => {
    const { z, konto } = srodowisko();
    await znanyKlient(konto, "jeden@example.com", 1000);
    const x = (await zarezerwuj(z, { seatId: "B1", email: "jeden@example.com" })).cialo.reservationId;
    const y = (await zarezerwuj(z, { seatId: "B2", email: "jeden@example.com" })).cialo.reservationId;

    const wyniki = await Promise.all([checkout(z, x, { points: 1000 }), checkout(z, y, { points: 1000 })]);
    expect(wyniki.map((w) => w.status).sort()).toEqual([200, 422]);
    expect(konto.karty.get("jeden@example.com")?.saldo).toBe(0);
  });

  it("punkty ustala pierwszy checkout: inna liczba → 409, bez points → ta sama sesja", async () => {
    const { z, konto } = srodowisko();
    await znanyKlient(konto, "u@example.com", 3000);
    const { reservationId } = (await zarezerwuj(z, { seatId: "B3", email: "u@example.com" })).cialo;
    const pierwszy = await checkout(z, reservationId, { points: 1000 });

    const inna = await checkout(z, reservationId, { points: 500 });
    expect(inna.status).toBe(409);
    expect(inna.cialo.error).toBe("points_locked");
    expect((await checkout(z, reservationId)).cialo.url).toBe(pierwszy.cialo.url);
    expect((await checkout(z, reservationId, { amount: 100 })).cialo.url).toBe(pierwszy.cialo.url);
    expect(konto.karty.get("u@example.com")?.saldo).toBe(2000);
  });

  it("Voucherify nie działa: 503 points_unavailable, bez sesji, a płatność bez punktów działa", async () => {
    const { z, konto, bramka } = srodowisko();
    const { reservationId } = (await zarezerwuj(z, { seatId: "B4", email: "b4@example.com" })).cialo;
    konto.awaria = new BladPunktow("Voucherify 503", "przejsciowy", { niepewny: true, status: 503 });

    const odp = await checkout(z, reservationId, { points: 1000 });
    expect(odp.status).toBe(503);
    expect(odp.cialo.error).toBe("points_unavailable");
    expect(bramka.wywolaniaUtworz).toBe(0);
    expect((await checkout(z, reservationId)).status).toBe(200);
  });

  it("zgubiona odpowiedź Voucherify: ponowienie sprawdza historię karty i nie zdejmuje punktów drugi raz", async () => {
    const { z, konto } = srodowisko();
    await znanyKlient(konto, "z@example.com", 3000);
    const { reservationId } = (await zarezerwuj(z, { seatId: "B5", email: "z@example.com" })).cialo;
    konto.zgubOdpowiedz = true;

    expect((await checkout(z, reservationId, { points: 1000 })).status).toBe(503);
    expect((await saga(reservationId))?.results).toMatchObject({ wydanieNiepewne: true });

    const ponowienie = await checkout(z, reservationId, { points: 1000 });
    expect(ponowienie.status).toBe(200);
    expect(operacje(konto, "z@example.com", `wydanie:${reservationId}`)).toHaveLength(1);
    expect(konto.karty.get("z@example.com")?.saldo).toBe(2000);
    expect((await stanRezerwacji(z, reservationId)).cialo.pointsUsed).toBe(1000);
  });

  it("zgubiona odpowiedź, a ponowienie z inną liczbą punktów: zapisane jest to, co zeszło, i 409", async () => {
    const { z, konto, bramka } = srodowisko();
    await znanyKlient(konto, "zmiana@example.com", 3000);
    const { reservationId } = (await zarezerwuj(z, { seatId: "B7", email: "zmiana@example.com" })).cialo;
    konto.zgubOdpowiedz = true;
    expect((await checkout(z, reservationId, { points: 1000 })).status).toBe(503);

    const inna = await checkout(z, reservationId, { points: 500 });
    expect(inna.status).toBe(409);
    expect(inna.cialo.error).toBe("points_locked");
    expect((await stanRezerwacji(z, reservationId)).cialo.pointsUsed).toBe(1000);
    expect(operacje(konto, "zmiana@example.com", `wydanie:${reservationId}`)).toHaveLength(1);
    expect(konto.karty.get("zmiana@example.com")?.saldo).toBe(2000);
    // Bez points (albo z tymi, które zeszły) płatność jest na cenę po odjęciu 1000 pkt.
    expect((await checkout(z, reservationId)).status).toBe(200);
    expect(bramka.sesje.get(`checkout:${reservationId}:1000`)?.parametry.amount).toBe(2200);
  });

  it("założenie karty bez odpowiedzi: następna próba uznaje znalezioną kartę za naszą i daje powitalne raz", async () => {
    const { z, konto } = srodowisko();
    // Stan po przerwanej próbie: notatka przed założeniem jest, mapowania na kartę jeszcze nie.
    konto.karty.set("przerwa@example.com", { memberId: "KARTA-P", saldo: 0, operacje: [] });
    await env.DB.prepare(`INSERT INTO loyalty_accounts (email, cardRequestedAt, createdAt) VALUES ('przerwa@example.com', 1, 1)`).run();
    const { reservationId } = (await zarezerwuj(z, { seatId: "B8", email: "przerwa@example.com" })).cialo;

    expect((await checkout(z, reservationId, { points: 1000 })).status).toBe(200);
    expect(operacje(konto, "przerwa@example.com").map((o) => [o.sourceId, o.punkty])).toEqual([
      ["powitanie:przerwa@example.com", 1000],
      [`wydanie:${reservationId}`, -1000],
    ]);
  });

  it("powitalne już weszły, ale odpowiedź nie dotarła: historia karty mówi „były” i nie ma drugich", async () => {
    const { z, konto } = srodowisko();
    konto.karty.set("raz@example.com", { memberId: "KARTA-R", saldo: 1000, operacje: [{ sourceId: "powitanie:raz@example.com", punkty: 1000 }] });
    await env.DB.prepare(`INSERT INTO loyalty_accounts (email, memberId, cardRequestedAt, createdAt) VALUES ('raz@example.com', 'KARTA-R', 1, 1)`).run();
    const { reservationId } = (await zarezerwuj(z, { seatId: "B9", email: "raz@example.com" })).cialo;

    expect((await checkout(z, reservationId, { points: 1000 })).status).toBe(200);
    expect(operacje(konto, "raz@example.com", "powitanie:raz@example.com")).toHaveLength(1);
    expect(konto.karty.get("raz@example.com")?.saldo).toBe(0);
  });

  it("kasa wydała punkty, a pamięć mówi więcej: obcięte odjęcie wraca korektą, 422, a ponowienie z tym, co jest, działa", async () => {
    const { z, konto, bramka } = srodowisko();
    await znanyKlient(konto, "kasa@example.com", 1000);
    expect((await saldo(z, "kasa@example.com")).cialo.points).toBe(1000); // saldo trafia do pamięci na 30 s
    konto.karty.get("kasa@example.com")!.saldo = 400; // w tym czasie kasa w kinie wydała 600 pkt
    const { reservationId } = (await zarezerwuj(z, { seatId: "E1", email: "kasa@example.com" })).cialo;

    const odmowa = await checkout(z, reservationId, { points: 1000 });
    expect(odmowa.status).toBe(422);
    expect(odmowa.cialo.error).toBe("not_enough_points");
    expect(odmowa.cialo.message).toContain("Masz 400 pkt");
    expect(operacje(konto, "kasa@example.com").map((o) => [o.sourceId, o.punkty])).toEqual([
      [`wydanie:${reservationId}`, -400],
      [`korekta:wydanie:${reservationId}`, 400],
    ]);
    expect(konto.karty.get("kasa@example.com")?.saldo).toBe(400);
    expect((await stanRezerwacji(z, reservationId)).cialo.pointsUsed).toBe(0);
    expect(bramka.wywolaniaUtworz).toBe(0);
    expect((await saga(reservationId))?.results).toMatchObject({ wydanieNiepewne: false });

    // Druga próba ma własny source_id, więc historia karty zostaje jednoznaczna.
    expect((await checkout(z, reservationId, { points: 400 })).status).toBe(200);
    expect(operacje(konto, "kasa@example.com", `wydanie:${reservationId}:2`).map((o) => o.punkty)).toEqual([-400]);
    expect((await stanRezerwacji(z, reservationId)).cialo.pointsUsed).toBe(400);
    expect(bramka.sesje.get(`checkout:${reservationId}:400`)?.parametry.amount).toBe(2800);
  });

  it("obcięte odjęcie i zgubiona odpowiedź: ponowienie liczy z historii, oddaje to, co zeszło, i 422", async () => {
    const { z, konto } = srodowisko();
    await znanyKlient(konto, "obciete@example.com", 1000);
    await saldo(z, "obciete@example.com");
    konto.karty.get("obciete@example.com")!.saldo = 300;
    const { reservationId } = (await zarezerwuj(z, { seatId: "E2", email: "obciete@example.com" })).cialo;
    konto.zgubOdpowiedz = true;
    expect((await checkout(z, reservationId, { points: 1000 })).status).toBe(503);

    const ponowienie = await checkout(z, reservationId, { points: 1000 });
    expect(ponowienie.status).toBe(422);
    expect(ponowienie.cialo.message).toContain("Masz 300 pkt");
    expect(konto.karty.get("obciete@example.com")?.saldo).toBe(300);
    expect(operacje(konto, "obciete@example.com", `korekta:wydanie:${reservationId}`).map((o) => o.punkty)).toEqual([300]);
    expect((await stanRezerwacji(z, reservationId)).cialo.pointsUsed).toBe(0);
  });

  it("korekta obciętego wydania nie wyszła: strażnik po końcu rezerwacji oddaje dokładnie to, co zeszło", async () => {
    const { z, konto, zegar, outbox } = srodowisko();
    await znanyKlient(konto, "korekta@example.com", 1000);
    await saldo(z, "korekta@example.com");
    konto.karty.get("korekta@example.com")!.saldo = 250;
    const { reservationId, expiresAt } = (await zarezerwuj(z, { seatId: "E3", email: "korekta@example.com" })).cialo;
    konto.odmowaDodania = new BladPunktow("Voucherify 503", "przejsciowy", { status: 503 });

    expect((await checkout(z, reservationId, { points: 1000 })).status).toBe(422);
    expect(konto.karty.get("korekta@example.com")?.saldo).toBe(0);
    expect((await saga(reservationId))?.results).toMatchObject({ wydanieNiepewne: true, wydanieId: `wydanie:${reservationId}` });

    konto.odmowaDodania = null;
    zegar.ustaw(expiresAt + 1000);
    await outbox(); // strażnik: rezerwacja wygasła bez sesji, więc kompensacja i oddanie punktów
    expect(konto.karty.get("korekta@example.com")?.saldo).toBe(250);
    expect(operacje(konto, "korekta@example.com", `zwrot:${reservationId}`).map((o) => o.punkty)).toEqual([250]);
    expect((await saga(reservationId))?.status).toBe("compensated");
  });

  it("Stripe padł po zdjęciu punktów: ponowienie nie zdejmuje ich drugi raz", async () => {
    const { z, konto, bramka } = srodowisko();
    await znanyKlient(konto, "s@example.com", 3000);
    const { reservationId } = (await zarezerwuj(z, { seatId: "B6", email: "s@example.com" })).cialo;
    bramka.awaria = new Error("Stripe nie odpowiada");
    expect((await checkout(z, reservationId, { points: 1000 })).status).toBe(503);

    bramka.awaria = null;
    expect((await checkout(z, reservationId, { points: 1000 })).status).toBe(200);
    expect(operacje(konto, "s@example.com", `wydanie:${reservationId}`)).toHaveLength(1);
  });
});

describe("bilet i kroki sagi po nim", () => {
  it("zapłata 22 zł po 1000 pkt: bilet, 220 punktów za zakup, w outboksie naliczenie i mail", async () => {
    const { z } = srodowisko();
    const { reservationId } = (await zarezerwuj(z, { seatId: "C1", email: "c1@example.com" })).cialo;
    await checkout(z, reservationId, { points: 1000 });
    expect((await zaplac(z, reservationId, { amount: 2200 })).status).toBe(200);

    expect((await stanRezerwacji(z, reservationId)).cialo).toMatchObject({
      status: "paid",
      pointsUsed: 1000,
      pointsEarned: 220,
      pointsStatus: "pending",
      emailStatus: "pending",
    });
    expect(await job(`punkty-naliczenie:${reservationId}`)).toMatchObject({ completedAt: null });
    expect(await job(`mail-bilet:${reservationId}`)).toMatchObject({ completedAt: null });
    expect((await saga(reservationId))?.completed).toEqual(["punkty", "platnosc", "bilet"]);
  });

  it("outbox: punkty za zakup na kartę, mail z podsumowaniem, saga zakończona", async () => {
    const { z, konto, mailer, outbox } = srodowisko();
    const { reservationId } = (await zarezerwuj(z, { seatId: "C2", name: "Jan <b>", email: "c2@example.com" })).cialo;
    await checkout(z, reservationId, { points: 1000 });
    await zaplac(z, reservationId, { amount: 2200 });

    await outbox();
    expect(konto.karty.get("c2@example.com")?.saldo).toBe(220); // 1000 powitalne − 1000 + 220
    expect(mailer.wyslane).toHaveLength(1);
    const { mail, klucz } = mailer.wyslane[0]!;
    expect(klucz).toBe(`bilet/${reservationId}`);
    expect(mail.do).toBe("c2@example.com");
    const kod = (await wierszMiejsca("C2"))?.code as string;
    expect(mail.tekst).toContain(`Kod biletu: ${kod}`);
    expect(mail.tekst).toContain("Zapłacono kartą: 22 zł");
    expect(mail.tekst).toContain("Zapłacono punktami: 1000 pkt (10 zł)");
    expect(mail.tekst).toContain("Zebrane punkty: +220 pkt");
    expect(mail.html).toContain("Jan &lt;b&gt;");
    expect(mail.html).not.toContain("<b>");
    expect((await stanRezerwacji(z, reservationId)).cialo).toMatchObject({ pointsStatus: "done", emailStatus: "sent" });
    // Naliczenie i mail to kroki tylko do przodu, niezależne od siebie: kolejność między nimi jest dowolna.
    const zakonczona = await saga(reservationId);
    expect(zakonczona?.status).toBe("completed");
    expect(zakonczona?.completed.slice(0, 3)).toEqual(["punkty", "platnosc", "bilet"]);
    expect([...(zakonczona?.completed ?? [])].sort()).toEqual(["bilet", "mail", "naliczenie", "platnosc", "punkty"]);

    // Kolejny przebieg Crona niczego nie powtarza.
    await outbox();
    expect(mailer.wyslane).toHaveLength(1);
    expect(konto.karty.get("c2@example.com")?.saldo).toBe(220);
  });

  it("nowy klient bez punktów: kartę zakłada dopiero naliczenie, z punktami powitalnymi", async () => {
    const { z, konto, outbox } = srodowisko();
    const { reservationId } = (await zarezerwuj(z, { seatId: "C3", email: "c3@example.com" })).cialo;
    await checkout(z, reservationId);
    await zaplac(z, reservationId);
    expect((await stanRezerwacji(z, reservationId)).cialo).toMatchObject({ pointsUsed: 0, pointsEarned: 320 });

    await outbox();
    expect(konto.karty.get("c3@example.com")?.saldo).toBe(1320);
    expect((await saldo(z, "c3@example.com")).cialo.points).toBe(1320);
  });

  it("zła kwota (32 zł zamiast 22 zł): bez biletu, zwrot na kartę i punkty wracają", async () => {
    const { z, konto, bramka, outbox } = srodowisko();
    await znanyKlient(konto, "zla@example.com", 1000);
    const { reservationId } = (await zarezerwuj(z, { seatId: "C4", email: "zla@example.com" })).cialo;
    await checkout(z, reservationId, { points: 1000 });
    await zaplac(z, reservationId, { amount: 3200, paymentIntent: "pi_zla_kwota" });
    expect((await wierszMiejsca("C4"))?.status).toBe("reserved");

    await outbox();
    expect(bramka.zwroty.map((zw) => zw.paymentIntentId)).toEqual(["pi_zla_kwota"]);
    expect(konto.karty.get("zla@example.com")?.saldo).toBe(1000);
  });

  it("naliczenie: zgubiona odpowiedź, ponowienie sprawdza historię i punkty wchodzą raz", async () => {
    const { z, konto, outbox, zegar } = srodowisko();
    await znanyKlient(konto, "n@example.com", 0);
    const { reservationId } = (await zarezerwuj(z, { seatId: "C5", email: "n@example.com" })).cialo;
    await checkout(z, reservationId);
    await zaplac(z, reservationId);
    konto.zgubOdpowiedz = true;

    await outbox();
    expect((await job(`punkty-naliczenie:${reservationId}`))?.completedAt).toBeNull();
    zegar.przewin(10 * 60_000);
    await outbox();
    expect(operacje(konto, "n@example.com", `naliczenie:${reservationId}`)).toHaveLength(1);
    expect(konto.karty.get("n@example.com")?.saldo).toBe(320);
    expect((await stanRezerwacji(z, reservationId)).cialo.pointsStatus).toBe("done");
  });

  it("mail odrzucony na stałe (adres spoza sandboksa Resend): bilet zostaje, emailStatus failed, bez DLQ", async () => {
    const { z, mailer, outbox } = srodowisko();
    const { reservationId } = (await zarezerwuj(z, { seatId: "C6", email: "obcy@example.com" })).cialo;
    await checkout(z, reservationId);
    await zaplac(z, reservationId);
    mailer.awaria = new BladMaila("Resend 403 validation_error: You can only send testing emails to your own email address", "trwaly");

    await outbox();
    const mail = await job(`mail-bilet:${reservationId}`);
    expect(mail?.completedAt).not.toBeNull();
    expect(mail?.hasError).toBe(0);
    expect((await stanRezerwacji(z, reservationId)).cialo).toMatchObject({ status: "paid", emailStatus: "failed" });
  });

  it("budżet Voucherify wyczerpany: job czeka bez liczenia porażki, a potem przechodzi", async () => {
    let wolne = false;
    const budzet: BudzetWywolan = { zgoda: async () => (wolne ? { ok: true } : { ok: false, ponowZaS: 120 }) };
    const { z, konto, outbox, zegar } = srodowisko({ budzet });
    const { reservationId } = (await zarezerwuj(z, { seatId: "C7", email: "c7@example.com" })).cialo;
    await checkout(z, reservationId);
    await zaplac(z, reservationId);

    await outbox();
    const czeka = await job(`punkty-naliczenie:${reservationId}`);
    expect(czeka).toMatchObject({ completedAt: null, totalTried: 0, hasError: 0 });
    expect(czeka!.visibleAt).toBe(zegar.teraz() + 120_000);
    expect(konto.wywolania).toEqual([]);

    wolne = true;
    zegar.przewin(120_000);
    await outbox();
    expect(konto.karty.get("c7@example.com")?.saldo).toBe(1320);
  });
});

describe("kompensacja: punkty wracają, gdy biletu nie będzie", () => {
  it("płatność po czasie z punktami: zwrot na kartę, 1000 punktów wraca, saga compensated", async () => {
    const { z, konto, bramka, outbox, zegar } = srodowisko();
    await znanyKlient(konto, "p@example.com", 1000);
    const { reservationId, expiresAt } = (await zarezerwuj(z, { seatId: "D1", email: "p@example.com" })).cialo;
    await checkout(z, reservationId, { points: 1000 });
    zegar.ustaw(expiresAt + 1000);
    await zaplac(z, reservationId, { amount: 2200, paymentIntent: "pi_po_czasie" });

    expect((await stanRezerwacji(z, reservationId)).cialo).toMatchObject({ status: "expired", refund: "pending", pointsUsed: 1000, pointsStatus: "pending" });
    expect((await saga(reservationId))?.status).toBe("compensating");

    await outbox();
    expect(bramka.zwroty.map((zw) => zw.paymentIntentId)).toEqual(["pi_po_czasie"]);
    expect(konto.karty.get("p@example.com")?.saldo).toBe(1000);
    expect(operacje(konto, "p@example.com", `zwrot:${reservationId}`)).toHaveLength(1);
    expect((await stanRezerwacji(z, reservationId)).cialo).toMatchObject({ refund: "done", pointsStatus: "done" });
    expect((await saga(reservationId))?.status).toBe("compensated");
  });

  it("rezerwacja wygasła bez płatności: strażnik wygasza sesję i oddaje punkty", async () => {
    const { z, konto, bramka, outbox, zegar } = srodowisko();
    await znanyKlient(konto, "w@example.com", 1500);
    const { reservationId, expiresAt } = (await zarezerwuj(z, { seatId: "D2", email: "w@example.com" })).cialo;
    await checkout(z, reservationId, { points: 1200 });
    expect(konto.karty.get("w@example.com")?.saldo).toBe(300);

    zegar.ustaw(expiresAt + 1000);
    await outbox();
    expect(bramka.wygaszone).toHaveLength(1);
    expect(konto.karty.get("w@example.com")?.saldo).toBe(1500);
    expect((await saga(reservationId))?.status).toBe("compensated");
    expect((await stanRezerwacji(z, reservationId)).cialo).toMatchObject({ status: "expired", pointsStatus: "done" });
  });

  it("sesja nie powstała (Stripe padł), rezerwacja wygasła: strażnik oddaje punkty", async () => {
    const { z, konto, bramka, outbox, zegar } = srodowisko();
    await znanyKlient(konto, "x@example.com", 1000);
    const { reservationId, expiresAt } = (await zarezerwuj(z, { seatId: "D3", email: "x@example.com" })).cialo;
    bramka.awaria = new Error("Stripe nie odpowiada");
    expect((await checkout(z, reservationId, { points: 1000 })).status).toBe(503);
    expect(konto.karty.get("x@example.com")?.saldo).toBe(0);

    zegar.ustaw(expiresAt + 1000);
    await outbox();
    expect(konto.karty.get("x@example.com")?.saldo).toBe(1000);
  });

  it("niepewne wydanie bez ponowienia: strażnik sprawdza historię i oddaje tylko to, co zeszło", async () => {
    const { z, konto, outbox, zegar } = srodowisko();
    await znanyKlient(konto, "q@example.com", 1000);
    const { reservationId, expiresAt } = (await zarezerwuj(z, { seatId: "D4", email: "q@example.com" })).cialo;
    konto.zgubOdpowiedz = true;
    expect((await checkout(z, reservationId, { points: 1000 })).status).toBe(503);
    expect(konto.karty.get("q@example.com")?.saldo).toBe(0); // zeszło, choć odpowiedź nie dotarła

    zegar.ustaw(expiresAt + 1000);
    await outbox();
    expect(konto.karty.get("q@example.com")?.saldo).toBe(1000);
    expect((await saga(reservationId))?.status).toBe("compensated");
  });
});

describe("webhook Resend (Svix)", () => {
  const SEKRET = `whsec_${btoa("sekret-testowy-resend-0123456789")}`;

  async function podpisz(id: string, ts: number, cialo: string): Promise<string> {
    const surowe = atob(SEKRET.slice("whsec_".length));
    const klucz = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(surowe, (z) => z.charCodeAt(0)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const podpis = new Uint8Array(await crypto.subtle.sign("HMAC", klucz, new TextEncoder().encode(`${id}.${ts}.${cialo}`)));
    return `v1,${btoa(String.fromCharCode(...podpis))}`;
  }

  it("doręczony i odrzucony zmieniają emailStatus; zły podpis 400; duplikat 200 bez zmian", async () => {
    const zegar = utworzZegarTestowy();
    const bramka = sztucznaBramka(zegar.teraz);
    const mailer = sztucznyMailer();
    const z = zaleznosci({ zegar, platnosci: bramka, sekretWebhookaResend: SEKRET });
    const { reservationId } = (await zarezerwuj(z, { seatId: "E1", email: "bounced@resend.dev" })).cialo;
    await checkout(z, reservationId);
    await zaplac(z, reservationId);
    await przetworzOutbox(env.DB, { platnosci: bramka, maile: mailer }, { zegar });
    const emailId = mailer.wyslane[0]!.id;

    const wyslij = async (id: string, typ: string, podpis?: string) => {
      const ts = Math.floor(zegar.teraz() / 1000);
      const cialo = JSON.stringify({ type: typ, created_at: "2026-11-06T12:00:00Z", data: { email_id: emailId } });
      const zadanie = new Request("https://kasa.test/api/webhooks/resend", {
        method: "POST",
        headers: { "svix-id": id, "svix-timestamp": String(ts), "svix-signature": podpis ?? (await podpisz(id, ts, cialo)) },
        body: cialo,
      });
      return obsluzWebhookResend(zadanie, () => z);
    };

    expect((await wyslij("msg_1", "email.bounced", "v1,zly")).status).toBe(400);
    expect((await stanRezerwacji(z, reservationId)).cialo.emailStatus).toBe("sent");

    expect((await wyslij("msg_2", "email.bounced")).status).toBe(200);
    expect((await stanRezerwacji(z, reservationId)).cialo.emailStatus).toBe("bounced");
    // Odrzucony nie wraca do „doręczony”, a powtórka tego samego zdarzenia nic nie zmienia.
    expect((await wyslij("msg_3", "email.delivered")).status).toBe(200);
    expect((await wyslij("msg_2", "email.bounced")).status).toBe(200);
    expect((await stanRezerwacji(z, reservationId)).cialo.emailStatus).toBe("bounced");
  });
});
