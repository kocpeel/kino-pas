// Kanał „na żywo": Durable Object sali + WebSocket z hibernacją, na prawdziwym D1 w workerd.

import { runDurableObjectAlarm } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { zegarSystemowy } from "../../src/lib/czas";
import { zaleznosciZBindingow, type Bindingi } from "../../src/lib/db/polaczenie";
import { obsluzRezerwacje } from "../../src/lib/http/trasy";
import { StraznikPrzeciazenia } from "../../src/lib/resilience/przeciazenie";
import { polaczZSala } from "../../src/lib/push/polaczenie-na-zywo";
import type { WiadomoscStanu } from "../../src/lib/push/protokol";
import { MAX_POLACZEN_Z_IP } from "../../src/lib/push/sala-seansu";
import { INNY_SEANS, SEANS, wolneZapisy, zadanieRezerwacji, zasiej } from "./pomocnicze";

beforeEach(() => zasiej());

let numerIp = 0;
const unikalneIp = () => `10.20.${Math.floor(numerIp / 250)}.${(numerIp++ % 250) + 1}`;

// Każde połączenie z innego IP (limit połączeń w konfiguracji testowej: 3 na minutę na IP).
function zadanieKanalu(eventId = SEANS, naglowki: Record<string, string> = {}) {
  return new Request(`https://kasa.test/api/events/${eventId}/live`, {
    headers: { Upgrade: "websocket", Origin: "https://kasa.test", "cf-connecting-ip": unikalneIp(), ...naglowki },
  });
}

interface Klient {
  ws: WebSocket;
  nastepna(timeoutMs?: number): Promise<WiadomoscStanu | "pong">;
}

async function polacz(eventId = SEANS): Promise<Klient> {
  const odp = await exports.default.fetch(zadanieKanalu(eventId));
  expect(odp.status).toBe(101);
  const ws = odp.webSocket!;
  ws.accept();
  const kolejka: (WiadomoscStanu | "pong")[] = [];
  const czekajacy: ((w: WiadomoscStanu | "pong") => void)[] = [];
  ws.addEventListener("message", (e) => {
    const w = e.data === "pong" ? "pong" : (JSON.parse(e.data as string) as WiadomoscStanu);
    const odbiorca = czekajacy.shift();
    if (odbiorca) odbiorca(w);
    else kolejka.push(w);
  });
  return {
    ws,
    nastepna(timeoutMs = 3000) {
      const gotowa = kolejka.shift();
      if (gotowa) return Promise.resolve(gotowa);
      return new Promise((rozwiaz, odrzuc) => {
        const t = setTimeout(() => odrzuc(new Error("Brak wiadomości z kanału")), timeoutMs);
        czekajacy.push((w) => (clearTimeout(t), rozwiaz(w)));
      });
    },
  };
}

async function stanZ(klient: Klient): Promise<WiadomoscStanu> {
  const w = await klient.nastepna();
  if (w === "pong") throw new Error("Oczekiwano stanu, przyszło pong");
  return w;
}

const zarezerwujPrzezWorker = (seatId: string, eventId = SEANS) =>
  exports.default.fetch(zadanieRezerwacji({ seatId, eventId, email: `${seatId}-${eventId}@example.com` }, { ip: unikalneIp() }));

describe("połączenie", () => {
  it("po połączeniu od razu wysyła stan sali z tym samym ETagiem co GET /api/events/:id", async () => {
    await zarezerwujPrzezWorker("A1");
    const klient = await polacz();
    const stan = await stanZ(klient);
    expect(stan.typ).toBe("stan");
    expect(stan.dane.takenSeats).toEqual(["A1"]);
    const get = await exports.default.fetch(new Request(`https://kasa.test/api/events/${SEANS}`));
    expect(stan.etag).toBe(get.headers.get("etag"));
    expect(stan.dane).toEqual(await get.json());
    klient.ws.close(1000);
  });

  it("odpowiada pong na ping (automatycznie, bez budzenia obiektu)", async () => {
    const klient = await polacz();
    await stanZ(klient);
    klient.ws.send("ping");
    expect(await klient.nastepna()).toBe("pong");
    klient.ws.close(1000);
  });

  it.each([
    ["bez nagłówka Upgrade", new Request(`https://kasa.test/api/events/${SEANS}/live`), 426],
    ["nieistniejący seans", zadanieKanalu("nie-ma-takiego"), 404],
    ["niepoprawny identyfikator", zadanieKanalu("..%2F..%2Fetc"), 404],
    ["obca strona (Origin)", zadanieKanalu(SEANS, { Origin: "https://zla-strona.example" }), 403],
  ])("%s → %i", async (_opis, zadanie, status) => {
    const odp = await exports.default.fetch(zadanie);
    expect(odp.status).toBe(status);
    expect(odp.webSocket).toBeNull();
  });
});

describe("dozwolone źródła (npm run dev: strona na innym porcie niż Worker sali)", () => {
  const zDev = (zrodlo: string, dozwolone: string[]) =>
    polaczZSala(
      new Request(`http://localhost:8789/api/events/${SEANS}/live`, { headers: { Upgrade: "websocket", Origin: zrodlo } }),
      env.SALE,
      SEANS,
      { dozwoloneZrodla: dozwolone },
    );

  it("strona z listy dozwolonych może się połączyć", async () => {
    const odp = await zDev("http://localhost:3000", ["http://localhost:3000"]);
    expect(odp.status).toBe(101);
    odp.webSocket!.accept();
    odp.webSocket!.close(1000);
  });

  it("inny port lub host spoza listy → 403", async () => {
    expect((await zDev("http://localhost:4000", ["http://localhost:3000"])).status).toBe(403);
    expect((await zDev("http://localhost:3000", [])).status).toBe(403);
  });
});

describe("rozsyłanie zmian", () => {
  it("rezerwacja trafia natychmiast do wszystkich oglądających tę salę", async () => {
    const [a, b] = await Promise.all([polacz(), polacz()]);
    await Promise.all([stanZ(a), stanZ(b)]);

    expect((await zarezerwujPrzezWorker("F7")).status).toBe(201);
    const [stanA, stanB] = await Promise.all([stanZ(a), stanZ(b)]);
    expect(stanA.dane.takenSeats).toEqual(["F7"]);
    expect(stanB.etag).toBe(stanA.etag);
    a.ws.close(1000);
    b.ws.close(1000);
  });

  it("zmiana na innym seansie nie trafia do tej sali", async () => {
    const klient = await polacz(SEANS);
    await stanZ(klient);
    await zarezerwujPrzezWorker("B2", INNY_SEANS);
    await expect(klient.nastepna(300)).rejects.toThrow("Brak wiadomości");
    klient.ws.close(1000);
  });

  it("powtórka idempotentna (nic się nie zmieniło) nie rozsyła stanu", async () => {
    const klient = await polacz();
    await stanZ(klient);
    const zadanie = () =>
      zadanieRezerwacji({ seatId: "C3", email: "idem-na-zywo@example.com" }, { klucz: "na-zywo-klucz-0001", ip: unikalneIp() });
    await exports.default.fetch(zadanie());
    await stanZ(klient);
    await exports.default.fetch(zadanie());
    await expect(klient.nastepna(300)).rejects.toThrow("Brak wiadomości");
    klient.ws.close(1000);
  });
});

describe("wygasanie", () => {
  it("alarm ogłasza, że wygasła rezerwacja wróciła do puli", async () => {
    const klient = await polacz();
    await stanZ(klient);

    // Rezerwacja wygasająca za chwilę (prosto w bazie), potem zmiana, która ustawia alarm.
    const wygasa = zegarSystemowy.teraz() + 150;
    await env.DB.prepare(
      `UPDATE seats SET status = 'reserved', reservationId = 'alarm-test', expiresAt = ?1, email = 'a@example.com'
        WHERE eventId = ?2 AND seatId = 'G1'`,
    )
      .bind(wygasa, SEANS)
      .run();
    const sala = env.SALE!.get(env.SALE!.idFromName(SEANS));
    await sala.zmiana(SEANS);
    expect((await stanZ(klient)).dane.takenSeats).toEqual(["G1"]);

    // Alarm odpala sam, tuż po expiresAt: nikt nie odpytuje, a klient dostaje nowy stan.
    const start = Date.now();
    expect((await stanZ(klient)).dane.takenSeats).toEqual([]);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(await runDurableObjectAlarm(sala)).toBe(false); // nic więcej nie jest zaplanowane
    klient.ws.close(1000);
  });

  it("bez oglądających zmiana niczego nie robi i nie zostawia alarmu", async () => {
    const sala = env.SALE!.get(env.SALE!.idFromName(INNY_SEANS));
    await sala.zmiana(INNY_SEANS);
    expect(await runDurableObjectAlarm(sala)).toBe(false);
  });
});

describe("odporność", () => {
  it("awaria kanału na żywo nie psuje rezerwacji", async () => {
    const zepsuteSale = {
      idFromName() {
        throw new Error("Durable Objects niedostępne");
      },
    };
    const z = zaleznosciZBindingow({ ...(env as unknown as Bindingi), SALE: zepsuteSale as never });
    const odp = await obsluzRezerwacje(zadanieRezerwacji({ seatId: "H4", email: "h4@example.com" }), () => z);
    expect(odp.status).toBe(201);
  });
});

describe("zgubione powiadomienia (słaby punkt 1)", () => {
  it("timeout zapisu (503), który jednak zapisał rezerwację: sala i tak rozsyła nowy stan", async () => {
    const klient = await polacz();
    await stanZ(klient);
    // Baza zapisuje, ale odpowiada po 200 ms, a serwer czeka tylko 50 ms: klient dostaje 503.
    const z = zaleznosciZBindingow({ ...(env as unknown as Bindingi), DB: wolneZapisy(env.DB, 200), DB_TIMEOUT_MS: "50" });
    const odp = await obsluzRezerwacje(zadanieRezerwacji({ seatId: "E5", email: "timeout-kanal@example.com" }), () => z);
    expect(odp.status).toBe(503);
    expect((await stanZ(klient)).dane.takenSeats).toEqual(["E5"]);
    klient.ws.close(1000);
  });

  it("powtórka z tym samym kluczem powiadamia salę, ale bez zmiany stanu nikt nic nie dostaje", async () => {
    const klient = await polacz();
    await stanZ(klient);
    const zadanie = () =>
      zadanieRezerwacji({ seatId: "E6", email: "powtorka-kanal@example.com" }, { klucz: "powtorka-kanal-0001", ip: unikalneIp() });
    await exports.default.fetch(zadanie());
    expect((await stanZ(klient)).dane.takenSeats).toEqual(["E6"]);
    expect((await exports.default.fetch(zadanie())).headers.get("idempotent-replayed")).toBe("true");
    await expect(klient.nastepna(300)).rejects.toThrow("Brak wiadomości");
    klient.ws.close(1000);
  });

  it("zmiana() zawsze czyta świeży stan z bazy (nie z pamięci dla nowych połączeń)", async () => {
    const klient = await polacz();
    await stanZ(klient);
    // Zmiana z pominięciem API (jak zapis, o którym sala nie wiedziała), potem powiadomienie.
    await env.DB.prepare(
      `UPDATE seats SET status = 'reserved', reservationId = 'bez-powiadomienia', expiresAt = ?1, email = 'x@example.com'
        WHERE eventId = ?2 AND seatId = 'E7'`,
    )
      .bind(zegarSystemowy.teraz() + 60_000, SEANS)
      .run();
    await env.SALE!.get(env.SALE!.idFromName(SEANS)).zmiana(SEANS);
    expect((await stanZ(klient)).dane.takenSeats).toEqual(["E7"]);
    klient.ws.close(1000);
  });
});

describe("limit i load shedding nowych połączeń (słaby punkt 3)", () => {
  it("za dużo połączeń z jednego IP → 429 z Retry-After, inne IP dalej się łączą", async () => {
    const zJednegoIp = () => exports.default.fetch(zadanieKanalu(SEANS, { "cf-connecting-ip": "10.99.0.1" }));
    const statusy: number[] = [];
    for (let i = 0; i < 4; i++) {
      const odp = await zJednegoIp();
      statusy.push(odp.status);
      if (odp.webSocket) {
        odp.webSocket.accept();
        odp.webSocket.close(1000);
      }
    }
    expect(statusy).toEqual([101, 101, 101, 429]);
    const odrzucone = await zJednegoIp();
    expect(odrzucone.headers.get("retry-after")).toBe("60");
    const inne = await exports.default.fetch(zadanieKanalu());
    expect(inne.status).toBe(101);
    inne.webSocket!.accept();
    inne.webSocket!.close(1000);
  });

  it("sala dokładnie pilnuje limitu równoczesnych połączeń z jednego IP (niezależnie od przybliżonego bindingu)", async () => {
    const zIp = (ip: string) =>
      polaczZSala(zadanieKanalu(INNY_SEANS, { "cf-connecting-ip": ip }), env.SALE, INNY_SEANS); // bez bindingu
    const otwarte: WebSocket[] = [];
    for (let i = 0; i < MAX_POLACZEN_Z_IP; i++) {
      const odp = await zIp("10.88.0.1");
      expect(odp.status).toBe(101);
      odp.webSocket!.accept();
      otwarte.push(odp.webSocket!);
    }
    const nadmiarowe = await zIp("10.88.0.1");
    expect(nadmiarowe.status).toBe(429);
    expect(nadmiarowe.headers.get("retry-after")).toBe("30");

    const zInnegoIp = await zIp("10.88.0.2");
    expect(zInnegoIp.status).toBe(101);
    zInnegoIp.webSocket!.accept();

    otwarte.pop()!.close(1000);
    await new Promise((r) => setTimeout(r, 100));
    const poZamknieciu = await zIp("10.88.0.1");
    expect(poZamknieciu.status).toBe(101);
    poZamknieciu.webSocket!.accept();
    [...otwarte, zInnegoIp.webSocket!, poZamknieciu.webSocket!].forEach((ws) => ws.close(1000));
  });

  it("przy przeciążeniu nowe połączenia odpadają pierwsze (503), zanim odpadnie lista czy zakupy", async () => {
    const straznik = new StraznikPrzeciazenia({ maxOdczytow: 4, maxZapisow: 4 });
    const zajete = [straznik.wejdz("szczegoly"), straznik.wejdz("szczegoly")]; // 50% puli odczytów
    expect(straznik.czyPrzyjac("lista")).toBe(true);
    expect(straznik.czyPrzyjac("zakup")).toBe(true);
    const odp = await polaczZSala(zadanieKanalu(), env.SALE, SEANS, { straznik });
    expect(odp.status).toBe(503);
    expect(odp.headers.get("retry-after")).toBe("5");
    zajete.forEach((zwolnij) => zwolnij());
    const poZwolnieniu = await polaczZSala(zadanieKanalu(), env.SALE, SEANS, { straznik });
    expect(poZwolnieniu.status).toBe(101);
    poZwolnieniu.webSocket!.accept();
    poZwolnieniu.webSocket!.close(1000);
    expect(straznik.stan()).toEqual({ odczytyWToku: 0, zapisyWToku: 0 });
  });
});
