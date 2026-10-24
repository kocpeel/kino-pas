// Durable Object „sala seansu": jeden egzemplarz na seans, a w nim wszystkie połączenia
// WebSocket osób oglądających mapę tej sali. Gdy coś się zmieni, obiekt czyta stan z D1
// (jedyne źródło prawdy) i rozsyła go wszystkim podłączonym.
//
// Skąd wie, że coś się zmieniło:
// - rezerwacja: API woła `zmiana()` (RPC) po udanym zapisie,
// - wygaśnięcie: rezerwacja wygasa „leniwie", bez żadnego zdarzenia, więc obiekt nastawia alarm
//   na najbliższe `expiresAt` z bazy i wtedy rozsyła nowy stan.
// Hibernacja WebSocketów: gdy nic się nie dzieje, obiekt jest usypiany, a Cloudflare trzyma połączenia.
// „ping" od klientów obsługuje automatyczna odpowiedź, bez budzenia obiektu.

import { DurableObject } from "cloudflare:workers";
import { zegarSystemowy } from "../czas";
import { najblizszeWygasniecie, szczegolySeansu } from "../db/zapytania-seanse";
import type { SzczegolySeansu } from "../domain/typy";
import { slabyEtag } from "../http/odpowiedzi";
import { zTimeoutem } from "../resilience/timeout";
import { PING, PONG, type WiadomoscStanu } from "./protokol";

export interface SrodowiskoSali {
  DB: D1Database;
}

const KLUCZ_SEANSU = "eventId";
const TIMEOUT_BAZY_MS = 3000;
/** Alarm odrobinę po `expiresAt`, żeby w chwili odczytu rezerwacja była już wygasła (expiresAt <= teraz). */
const ZAPAS_ALARMU_MS = 25;

export class SalaSeansu extends DurableObject<SrodowiskoSali> {
  private rozsylanie: Promise<void> | null = null;
  private ponownie = false;

  constructor(ctx: DurableObjectState, env: SrodowiskoSali) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  /** Nowe połączenie WebSocket (trasę i walidację robi `polaczZSala`). */
  async fetch(zadanie: Request): Promise<Response> {
    const eventId = zadanie.headers.get("x-event-id");
    if (!eventId || zadanie.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Oczekiwano połączenia WebSocket.", { status: 426 });
    }
    const stan = await this.stanSali(eventId);
    if (!stan) return new Response("Nie ma takiego seansu.", { status: 404 });
    await this.ctx.storage.put(KLUCZ_SEANSU, eventId);

    const [klient, serwer] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(serwer);
    serwer.send(JSON.stringify(stan));
    await this.zaplanujAlarm(eventId);
    return new Response(null, { status: 101, webSocket: klient });
  }

  /** RPC z API: stan sali właśnie się zmienił (np. nowa rezerwacja). */
  async zmiana(eventId: string): Promise<void> {
    // Nikt nie ogląda tej sali: nie ma komu wysyłać i nie trzeba czytać bazy.
    if (this.ctx.getWebSockets().length === 0) return;
    await this.ctx.storage.put(KLUCZ_SEANSU, eventId);
    await this.rozeslij(eventId);
  }

  async alarm(): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) return;
    const eventId = await this.ctx.storage.get<string>(KLUCZ_SEANSU);
    if (eventId) await this.rozeslij(eventId);
  }

  async webSocketClose(ws: WebSocket, kod: number): Promise<void> {
    try {
      // 1005/1006/1015 to kody zastrzeżone: nie wolno ich wysłać, więc odpowiadamy zwykłym 1000.
      ws.close([1005, 1006, 1015].includes(kod) ? 1000 : kod, "Zamknięto");
    } catch {
      // Runtime mógł już odpowiedzieć zamknięciem sam.
    }
    if (this.ctx.getWebSockets().length === 0) await this.ctx.storage.deleteAlarm();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011);
  }

  // Seria zmian w krótkim czasie = jeden odczyt bazy w toku + najwyżej jeden kolejny.
  private async rozeslij(eventId: string): Promise<void> {
    if (this.rozsylanie) {
      this.ponownie = true;
      return this.rozsylanie;
    }
    this.rozsylanie = (async () => {
      try {
        do {
          this.ponownie = false;
          const stan = await this.stanSali(eventId);
          if (!stan) return;
          const wiadomosc = JSON.stringify(stan);
          for (const ws of this.ctx.getWebSockets()) {
            try {
              ws.send(wiadomosc);
            } catch {
              // Połączenie właśnie się zamyka; obsłuży je webSocketClose.
            }
          }
        } while (this.ponownie);
        await this.zaplanujAlarm(eventId);
      } finally {
        this.rozsylanie = null;
      }
    })();
    return this.rozsylanie;
  }

  private async stanSali(eventId: string): Promise<WiadomoscStanu | null> {
    const dane: SzczegolySeansu | null = await zTimeoutem(
      szczegolySeansu(this.env.DB, eventId, zegarSystemowy.teraz()),
      TIMEOUT_BAZY_MS,
    );
    if (!dane) return null;
    // Ten sam ETag co w GET /api/events/:id, więc klient może płynnie wrócić do odpytywania.
    return { typ: "stan", dane, etag: slabyEtag(JSON.stringify(dane)) };
  }

  private async zaplanujAlarm(eventId: string): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const kiedy = await najblizszeWygasniecie(this.env.DB, eventId, zegarSystemowy.teraz());
    if (kiedy === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(kiedy + ZAPAS_ALARMU_MS);
  }
}
