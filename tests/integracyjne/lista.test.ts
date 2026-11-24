// Etap IV: lista oczekujących. Karta A (zapis, miejsce w kolejce, wypisanie), karta B (zwolnione miejsce jako
// zwykła rezerwacja dla pierwszej osoby, potem następna) i karta C (mail z ofertą; odbity mail przesuwa kolejkę).
// Prawdziwa baza D1 i podpisy webhooków; Stripe, Voucherify i Resend bez sieci.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { utworzZegarTestowy } from "../../src/lib/czas";
import { przetworzOutbox } from "../../src/lib/domain/outbox";
import { obsluzStanZapisu, obsluzWebhookResend, obsluzWypisanie, obsluzZapisNaListe } from "../../src/lib/http/trasy";
import { BladMaila } from "../../src/lib/maile/resend";
import {
  checkout,
  saldo,
  stanRezerwacji,
  sztucznaBramka,
  sztuczneKonto,
  sztucznyMailer,
  TTL_MS,
  uslugaPunktow,
  wierszMiejsca,
  zaplac,
  zarezerwuj,
  zasiej,
  zaleznosci,
  type Wynik,
} from "./pomocnicze";

const EV = "waitlist-test";
const SEKRET_RESEND = `whsec_${btoa("sekret-resend-lista-testy-32bajty")}`;

beforeEach(async () => {
  await zasiej();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

function srodowisko() {
  const zegar = utworzZegarTestowy();
  const bramka = sztucznaBramka(zegar.teraz);
  const konto = sztuczneKonto();
  const mailer = sztucznyMailer();
  const punkty = uslugaPunktow(konto);
  const z = zaleznosci({ zegar, platnosci: bramka, punkty, maile: mailer, sekretWebhookaResend: SEKRET_RESEND });
  const outbox = () => przetworzOutbox(env.DB, { platnosci: bramka, punkty, maile: mailer }, { zegar });
  return { zegar, bramka, konto, mailer, z, outbox };
}

type Zal = ReturnType<typeof srodowisko>["z"];
type Stan = { status: string; position: number; reservationId?: string; offerExpiresAt?: number; seatId?: string; error?: string };

async function odczytaj<T>(odp: Response): Promise<Wynik<T>> {
  return { status: odp.status, cialo: (await odp.json()) as T, naglowki: odp.headers };
}

async function zapisz(z: Zal, email: string, cialo: Record<string, unknown> = {}, eventId = EV) {
  const zadanie = new Request(`https://kasa.test/api/events/${eventId}/waitlist`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, customerName: "Ola Lista", ...cialo }),
  });
  return odczytaj<{ waitlistId: string; position: number; error?: string }>(await obsluzZapisNaListe(zadanie, () => z, eventId));
}

async function stan(z: Zal, id: string) {
  return odczytaj<Stan>(await obsluzStanZapisu(new Request(`https://kasa.test/api/waitlist/${id}`), () => z, id));
}

async function wypisz(z: Zal, id: string) {
  return odczytaj<Stan>(await obsluzWypisanie(new Request(`https://kasa.test/api/waitlist/${id}`, { method: "DELETE" }), () => z, id));
}

/** Oba miejsca waitlist-test mają ważne rezerwacje (zwykłych klientów). */
async function wyprzedaj(z: Zal): Promise<{ A1: string; A2: string; expiresAt: number }> {
  const a1 = (await zarezerwuj(z, { eventId: EV, seatId: "A1", email: "a1@example.com" })).cialo;
  const a2 = (await zarezerwuj(z, { eventId: EV, seatId: "A2", email: "a2@example.com" })).cialo;
  return { A1: a1.reservationId, A2: a2.reservationId, expiresAt: Math.max(a1.expiresAt, a2.expiresAt) };
}

async function podpisz(id: string, ts: number, cialo: string): Promise<string> {
  const surowy = Uint8Array.from(atob(SEKRET_RESEND.slice("whsec_".length)), (c) => c.charCodeAt(0));
  const klucz = await crypto.subtle.importKey("raw", surowy, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const podpis = new Uint8Array(await crypto.subtle.sign("HMAC", klucz, new TextEncoder().encode(`${id}.${ts}.${cialo}`)));
  return `v1,${btoa(String.fromCharCode(...podpis))}`;
}

async function webhookResend(z: Zal, zegar: { teraz: () => number }, typ: string, emailId: string, id: string) {
  const ts = Math.floor(zegar.teraz() / 1000);
  const cialo = JSON.stringify({ type: typ, created_at: "2026-11-06T12:00:00Z", data: { email_id: emailId } });
  const zadanie = new Request("https://kasa.test/api/webhooks/resend", {
    method: "POST",
    headers: { "svix-id": id, "svix-timestamp": String(ts), "svix-signature": await podpisz(id, ts, cialo) },
    body: cialo,
  });
  return obsluzWebhookResend(zadanie, () => z);
}

describe("karta A: zapis, miejsce w kolejce, wypisanie", () => {
  it("wydarzenie nie jest wyprzedane → 409 not_sold_out; nieznane → 404; złe dane → 400 z polami", async () => {
    const { z } = srodowisko();
    const nie = await zapisz(z, "ktos@example.com");
    expect(nie.status).toBe(409);
    expect(nie.cialo.error).toBe("not_sold_out");
    expect((await zapisz(z, "ktos@example.com", {}, "nie-ma-takiego")).status).toBe(404);
    await wyprzedaj(z);
    const zle = await zapisz(z, "to-nie-email", { customerName: "" });
    expect(zle.status).toBe(400);
    expect(Object.keys((zle.cialo as unknown as { details: object }).details).sort()).toEqual(["customerName", "email"]);
  });

  it("wyprzedane: kolejne osoby dostają pozycje 1, 2; ten sam e-mail drugi raz to ten sam zapis (200)", async () => {
    const { z } = srodowisko();
    await wyprzedaj(z);
    const ola = await zapisz(z, "Ola@Example.com");
    expect(ola.status).toBe(201);
    expect(ola.cialo).toEqual({ waitlistId: expect.stringMatching(/^[0-9a-f-]{36}$/), position: 1 });
    const jan = await zapisz(z, "jan@example.com");
    expect(jan.cialo.position).toBe(2);
    const znowu = await zapisz(z, "ola@example.com");
    expect(znowu.status).toBe(200);
    expect(znowu.naglowki.get("idempotent-replayed")).toBe("true");
    expect(znowu.cialo).toEqual(ola.cialo);
    expect((await stan(z, jan.cialo.waitlistId)).cialo).toEqual({ status: "waiting", position: 2 });
  });

  it("dwa równoległe zapisy tego samego klienta: jeden zapis", async () => {
    const { z } = srodowisko();
    await wyprzedaj(z);
    const wyniki = await Promise.all([zapisz(z, "rown@example.com"), zapisz(z, "rown@example.com"), zapisz(z, "rown@example.com")]);
    expect(new Set(wyniki.map((w) => w.cialo.waitlistId)).size).toBe(1);
    const { ile } = (await env.DB.prepare(`SELECT COUNT(*) AS ile FROM waitlist WHERE email = 'rown@example.com'`).first<{ ile: number }>())!;
    expect(ile).toBe(1);
  });

  it("wypisanie: status left, kolejka przesuwa się w górę; drugie wypisanie 200 bez zmian", async () => {
    const { z } = srodowisko();
    await wyprzedaj(z);
    const pierwsza = (await zapisz(z, "p@example.com")).cialo.waitlistId;
    const druga = (await zapisz(z, "d@example.com")).cialo.waitlistId;
    expect((await wypisz(z, pierwsza)).cialo).toEqual({ status: "left", position: 0 });
    expect((await wypisz(z, pierwsza)).status).toBe(200);
    expect((await stan(z, druga)).cialo).toEqual({ status: "waiting", position: 1 });
    // Po wypisaniu można zapisać się od nowa (na koniec kolejki).
    const znowu = await zapisz(z, "p@example.com");
    expect(znowu.status).toBe(201);
    expect(znowu.cialo.position).toBe(2);
  });

  it("zły identyfikator 400, nieznany 404", async () => {
    const { z } = srodowisko();
    expect((await stan(z, "abc")).status).toBe(400);
    expect((await wypisz(z, "abc")).status).toBe(400);
    expect((await stan(z, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });
});

describe("karta B: zwolnione miejsce dla pierwszej osoby", () => {
  it("po wygaśnięciu rezerwacji pierwsza osoba ma zwykłą rezerwację (offered), a mapa nadal jest wyprzedana", async () => {
    const { z, zegar } = srodowisko();
    const { expiresAt } = await wyprzedaj(z);
    const pierwsza = (await zapisz(z, "p@example.com")).cialo.waitlistId;
    const druga = (await zapisz(z, "d@example.com")).cialo.waitlistId;
    zegar.ustaw(expiresAt + 1);

    const s = (await stan(z, pierwsza)).cialo;
    expect(s).toMatchObject({ status: "offered", position: 0, offerExpiresAt: zegar.teraz() + TTL_MS });
    expect(s.reservationId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await stan(z, druga)).cialo).toMatchObject({ status: "offered" }); // drugie miejsce też się zwolniło
    // Zwykła rezerwacja z etapu I: GET /api/reservations/:id i fotel w bazie.
    expect((await stanRezerwacji(z, s.reservationId!)).cialo).toMatchObject({ status: "held", amount: 3200, expiresAt: s.offerExpiresAt });
    expect(await wierszMiejsca(s.seatId!, EV)).toMatchObject({ status: "reserved", reservationId: s.reservationId, email: "p@example.com" });
  });

  it("oferta minęła bez zapłaty → missed, a miejsce dostaje następna osoba", async () => {
    const { z, zegar } = srodowisko();
    const { expiresAt } = await wyprzedaj(z);
    // Oba miejsca wygasają: dwie pierwsze osoby dostają oferty, trzecia czeka.
    const pierwsza = (await zapisz(z, "p@example.com")).cialo.waitlistId;
    const druga = (await zapisz(z, "d@example.com")).cialo.waitlistId;
    const trzecia = (await zapisz(z, "t@example.com")).cialo.waitlistId;
    zegar.ustaw(expiresAt + 1);
    const a = (await stan(z, pierwsza)).cialo;
    const b = (await stan(z, druga)).cialo;
    expect([a.status, b.status]).toEqual(["offered", "offered"]);
    expect((await stan(z, trzecia)).cialo).toEqual({ status: "waiting", position: 1 });

    zegar.ustaw(a.offerExpiresAt! + 1);
    expect((await stan(z, pierwsza)).cialo).toMatchObject({ status: "missed", position: 0, reservationId: a.reservationId });
    const c = (await stan(z, trzecia)).cialo;
    expect(c).toMatchObject({ status: "offered" });
    expect([a.seatId, b.seatId]).toContain(c.seatId);
  });

  it("opłacona oferta (także punktami) → done; wypisanie po zakupie 409", async () => {
    const { z, zegar, konto } = srodowisko();
    const { expiresAt } = await wyprzedaj(z);
    const id = (await zapisz(z, "punkty@example.com")).cialo.waitlistId;
    zegar.ustaw(expiresAt + 1);
    const oferta = (await stan(z, id)).cialo;
    const odp = await checkout(z, oferta.reservationId!, { points: 1000 });
    expect(odp.status).toBe(200);
    expect(konto.karty.get("punkty@example.com")?.saldo).toBe(0);
    expect((await zaplac(z, oferta.reservationId!, { amount: 2200 })).status).toBe(200);
    expect((await stan(z, id)).cialo).toMatchObject({ status: "done", position: 0, reservationId: oferta.reservationId });
    expect((await stanRezerwacji(z, oferta.reservationId!)).cialo).toMatchObject({ status: "paid", pointsUsed: 1000 });
    const wypisanie = await wypisz(z, id);
    expect(wypisanie.status).toBe(409);
    expect(wypisanie.cialo.error).toBe("waitlist_done");
  });

  it("wypisanie z ofertą oddaje miejsce następnej osobie od razu", async () => {
    const { z, zegar } = srodowisko();
    const a = await wyprzedaj(z);
    const pierwsza = (await zapisz(z, "p@example.com")).cialo.waitlistId;
    // Kupujemy A2, więc do oddania zostaje tylko A1.
    await env.DB.prepare(`UPDATE seats SET status = 'purchased', code = 'TEST-0001', expiresAt = NULL WHERE eventId = ?1 AND seatId = 'A2'`).bind(EV).run();
    const druga = (await zapisz(z, "d@example.com")).cialo.waitlistId;
    zegar.ustaw(a.expiresAt + 1);
    expect((await stan(z, pierwsza)).cialo.status).toBe("offered");
    expect((await stan(z, druga)).cialo).toEqual({ status: "waiting", position: 1 });

    expect((await wypisz(z, pierwsza)).cialo).toEqual({ status: "left", position: 0 });
    const s = (await stan(z, druga)).cialo;
    expect(s).toMatchObject({ status: "offered", seatId: "A1" });
    expect(await wierszMiejsca("A1", EV)).toMatchObject({ reservationId: s.reservationId, email: "d@example.com" });
  });

  it("pierwszeństwo listy: zwolnione miejsce nie trafia do przypadkowego klienta, gdy ktoś czeka", async () => {
    const { z, zegar } = srodowisko();
    const { expiresAt } = await wyprzedaj(z);
    await zapisz(z, "czeka@example.com");
    zegar.ustaw(expiresAt + 1);
    const obcy = await zarezerwuj(z, { eventId: EV, seatId: "A1", email: "obcy@example.com" });
    expect(obcy.status).toBe(409);
    expect((await wierszMiejsca("A1", EV))?.email).toBe("czeka@example.com");
  });

  it("równoległe odczyty po wygaśnięciu: każde miejsce jedna oferta, każda osoba najwyżej jedno miejsce", async () => {
    const { z, zegar } = srodowisko();
    const { expiresAt } = await wyprzedaj(z);
    const ids: string[] = [];
    for (const email of ["r1@example.com", "r2@example.com", "r3@example.com"]) ids.push((await zapisz(z, email)).cialo.waitlistId);
    zegar.ustaw(expiresAt + 1);
    await Promise.all([...ids, ...ids].map((id) => stan(z, id)));
    const oferty = (await env.DB.prepare(`SELECT seatId, reservationId FROM waitlist WHERE status = 'offered'`).all<{ seatId: string }>()).results;
    expect(oferty.map((o) => o.seatId).sort()).toEqual(["A1", "A2"]);
    expect((await stan(z, ids[2]!)).cialo).toEqual({ status: "waiting", position: 1 });
  });

  it("bez odczytów kolejkę przesuwa job lista-kolejka o najbliższym wygaśnięciu (budzik albo Cron)", async () => {
    const { zegar, outbox, mailer, z } = srodowisko();
    const { expiresAt } = await wyprzedaj(z);
    await zapisz(z, "bez-odczytu@example.com");
    const job = await env.DB.prepare(`SELECT visibleAt FROM outbox WHERE id = 'lista-kolejka:waitlist-test'`).first<{ visibleAt: number }>();
    expect(job?.visibleAt).toBe(expiresAt);
    zegar.ustaw(expiresAt + 1);
    await outbox();
    expect(mailer.wyslane.map((w) => w.mail.do)).toEqual(["bez-odczytu@example.com"]);
  });
});

describe("karta C: mail z ofertą", () => {
  it("mail ma nazwę wydarzenia, miejsce, link do zapłaty i godzinę, do której miejsce czeka", async () => {
    const { z, zegar, outbox, mailer } = srodowisko();
    const { expiresAt } = await wyprzedaj(z);
    const id = (await zapisz(z, "mail@example.com", { customerName: "Ala <b>" })).cialo.waitlistId;
    zegar.ustaw(expiresAt + 1);
    const oferta = (await stan(z, id)).cialo;
    await outbox();
    expect(mailer.wyslane).toHaveLength(1);
    const { mail, klucz } = mailer.wyslane[0]!;
    expect(klucz).toBe(`oferta/${oferta.reservationId}`);
    expect(mail.do).toBe("mail@example.com");
    expect(mail.tekst).toContain("Lista oczekujących: seans testowy");
    expect(mail.tekst).toContain(`Rząd A, miejsce ${oferta.seatId!.slice(1)}`);
    expect(mail.tekst).toContain(`https://kasa.test/rezerwacja/${oferta.reservationId}?seans=waitlist-test&miejsce=${oferta.seatId}`);
    expect(mail.tekst).toMatch(/czeka na Ciebie do \d{2}:\d{2}:\d{2}/);
    expect(mail.html).toContain("Ala &lt;b&gt;");
    expect(mail.html).not.toContain("<b>");
    const wiersz = await env.DB.prepare(`SELECT emailId, emailStatus FROM waitlist WHERE id = ?1`).bind(id).first();
    expect(wiersz).toEqual({ emailId: "mail_1", emailStatus: "sent" });
    // Kolejny przebieg nie wysyła drugiego maila.
    await outbox();
    expect(mailer.wyslane).toHaveLength(1);
  });

  it("odbity mail (webhook Resend) → missed, a miejsce od razu dostaje następna osoba; duplikat bez zmian", async () => {
    const { z, zegar, outbox, mailer } = srodowisko();
    const a = await wyprzedaj(z);
    await env.DB.prepare(`UPDATE seats SET status = 'purchased', code = 'TEST-0002', expiresAt = NULL WHERE eventId = ?1 AND seatId = 'A2'`).bind(EV).run();
    const odbity = (await zapisz(z, "bounced@resend.dev")).cialo.waitlistId;
    const nastepna = (await zapisz(z, "delivered+nastepna@resend.dev")).cialo.waitlistId;
    zegar.ustaw(a.expiresAt + 1);
    const oferta = (await stan(z, odbity)).cialo;
    expect(oferta.status).toBe("offered");
    await outbox();
    const emailId = mailer.wyslane[0]!.id;

    expect((await webhookResend(z, zegar, "email.bounced", emailId, "msg_b1")).status).toBe(200);
    expect((await stan(z, odbity)).cialo).toMatchObject({ status: "missed" });
    const s = (await stan(z, nastepna)).cialo;
    expect(s).toMatchObject({ status: "offered", seatId: "A1" });
    expect(await wierszMiejsca("A1", EV)).toMatchObject({ email: "delivered+nastepna@resend.dev", reservationId: s.reservationId });
    // Duplikat zdarzenia: 200, nic się nie zmienia.
    expect((await webhookResend(z, zegar, "email.bounced", emailId, "msg_b1")).status).toBe(200);
    expect((await stan(z, nastepna)).cialo.reservationId).toBe(s.reservationId);
    await outbox();
    expect(mailer.wyslane.map((w) => w.mail.do)).toEqual(["bounced@resend.dev", "delivered+nastepna@resend.dev"]);
  });

  it("trwała odmowa Resend przy wysyłce (adres spoza sandboksa) też przesuwa kolejkę", async () => {
    const { z, zegar, outbox, mailer } = srodowisko();
    const a = await wyprzedaj(z);
    await env.DB.prepare(`UPDATE seats SET status = 'purchased', code = 'TEST-0003', expiresAt = NULL WHERE eventId = ?1 AND seatId = 'A2'`).bind(EV).run();
    const pierwsza = (await zapisz(z, "obcy@gmail.com")).cialo.waitlistId;
    const druga = (await zapisz(z, "delivered+druga@resend.dev")).cialo.waitlistId;
    zegar.ustaw(a.expiresAt + 1);
    await stan(z, pierwsza);
    // Resend w sandboksie odmawia adresom spoza właściciela konta i adresów testowych (403).
    const wyslij = mailer.wyslij.bind(mailer);
    mailer.wyslij = async (mail, klucz) => {
      if (mail.do === "obcy@gmail.com") throw new BladMaila("Resend 403 validation_error", "trwaly", undefined, "validation_error");
      return wyslij(mail, klucz);
    };
    // Jeden przebieg: odmowa → oferta odpada → kolejka → oferta dla następnej osoby → jej mail.
    await outbox();
    expect((await stan(z, pierwsza)).cialo.status).toBe("missed");
    expect((await stan(z, druga)).cialo).toMatchObject({ status: "offered", seatId: "A1" });
    expect(mailer.wyslane.map((w) => w.mail.do)).toEqual(["delivered+druga@resend.dev"]);
  });
});

describe("etap III dalej działa: punkty na miejscu z listy", () => {
  it("oferta opłacona punktami: saldo w GET /api/loyalty ma punkty za zakup od razu (bez Crona)", async () => {
    const { z, zegar } = srodowisko();
    const { expiresAt } = await wyprzedaj(z);
    const id = (await zapisz(z, "saldo@example.com")).cialo.waitlistId;
    zegar.ustaw(expiresAt + 1);
    const { reservationId } = (await stan(z, id)).cialo;
    await checkout(z, reservationId!, { points: 1000 });
    await zaplac(z, reservationId!, { amount: 2200 });
    // GET /api/loyalty dokańcza zaległe naliczenie: 1000 − 1000 + 220.
    expect((await saldo(z, "saldo@example.com")).cialo.points).toBe(220);
  });
});
