// Durable Object „sala seansu": jeden egzemplarz na seans, a w nim wszystkie połączenia
// WebSocket osób oglądających mapę tej sali. Gdy coś się zmieni, obiekt czyta stan z D1
// (jedyne źródło prawdy) i rozsyła go wszystkim podłączonym.
//
// Skąd wie, że coś się zmieniło:
// - rezerwacja: API woła `zmiana()` (RPC) po zapisie, także po powtórce i po timeoucie
//   (wtedy zapis mógł się udać); gdy stan jest taki jak ostatnio rozesłany, nic nie wysyła,
// - wygaśnięcie: rezerwacja wygasa „leniwie", bez żadnego zdarzenia, więc obiekt nastawia alarm
//   na najbliższe `expiresAt` z bazy i wtedy rozsyła nowy stan.
// Każdy odczyt to jedna podróż do D1 (stan + najbliższe wygaśnięcie). Nowe połączenia w ciągu
// sekundy dostają stan z pamięci, więc fala ponownych połączeń (np. po wdrożeniu) to jeden odczyt.
// Hibernacja WebSocketów: gdy nic się nie dzieje, obiekt jest usypiany, a Cloudflare trzyma połączenia.
// „ping" od klientów obsługuje automatyczna odpowiedź, bez budzenia obiektu.

import { DurableObject } from "cloudflare:workers";
import { zegarSystemowy } from "../czas";
import { stanSali } from "../db/zapytania-seanse";
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
/** Jak długo nowe połączenia mogą dostać stan z pamięci zamiast z bazy. */
const WAZNOSC_PAMIECI_MS = 1000;
/**
 * Ile RÓWNOCZESNYCH połączeń z jednego IP przyjmuje sala. Liczone dokładnie (znaczniki połączeń
 * w tym obiekcie), w przeciwieństwie do bindingu Rate Limiting, który liczy w przybliżeniu.
 * 10 wystarcza na kilka kart i kilka osób za jednym NAT-em.
 */
export const MAX_POLACZEN_Z_IP = 10;

async function znacznikIp(ip: string): Promise<string> {
  const skrot = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip)));
  return `ip:${Array.from(skrot.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

interface OdczytSali {
  wiadomosc: WiadomoscStanu;
  najblizszeWygasniecie: number | null;
  odczytano: number;
}

export class SalaSeansu extends DurableObject<SrodowiskoSali> {
  private rozsylanie: Promise<void> | null = null;
  private ponownie = false;
  // Pola instancji (nie modułu): znikają, gdy obiekt zostanie uśpiony, i nie rosną.
  private pamiec: OdczytSali | null = null;
  private ostatnioRozeslanyEtag: string | null = null;

  constructor(ctx: DurableObjectState, env: SrodowiskoSali) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  /** Nowe połączenie WebSocket (trasę, walidację, limit i shedding robi `polaczZSala`). */
  async fetch(zadanie: Request): Promise<Response> {
    const eventId = zadanie.headers.get("x-event-id");
    if (!eventId || zadanie.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Oczekiwano połączenia WebSocket.", { status: 426 });
    }
    // Ścisły limit równoczesnych połączeń z jednego IP (znacznik = skrót IP, nie samo IP).
    const znacznik = await znacznikIp(zadanie.headers.get("x-klient-ip") ?? "nieznany");
    if (this.ctx.getWebSockets(znacznik).length >= MAX_POLACZEN_Z_IP) {
      return new Response("Za dużo otwartych połączeń z tej sieci.", { status: 429, headers: { "Retry-After": "30" } });
    }
    const odczyt = await this.odczytaj(eventId, { zPamieci: true });
    if (!odczyt) return new Response("Nie ma takiego seansu.", { status: 404 });
    await this.ctx.storage.put(KLUCZ_SEANSU, eventId);

    const [klient, serwer] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(serwer, [znacznik]);
    serwer.send(JSON.stringify(odczyt.wiadomosc));
    // Jedyny oglądający ma już ten stan, więc kolejna zmiana bez różnicy nie musi go powtarzać.
    // Przy kilku połączeniach inni mogą mieć starszy stan: wtedy „ostatnio rozesłany" zostaje bez zmian.
    if (this.ctx.getWebSockets().length === 1) this.ostatnioRozeslanyEtag = odczyt.wiadomosc.etag;
    await this.ustawAlarm(odczyt.najblizszeWygasniecie);
    return new Response(null, { status: 101, webSocket: klient });
  }

  /** RPC z API: stan sali mógł się zmienić (rezerwacja, jej powtórka albo zapis z niepewnym wynikiem). */
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
        let ostatni: OdczytSali | null = null;
        do {
          this.ponownie = false;
          ostatni = await this.odczytaj(eventId, { zPamieci: false });
          if (!ostatni) return;
          // Ten sam stan co ostatnio rozesłany (np. powtórka rezerwacji): nikomu nic nie wysyłamy.
          if (ostatni.wiadomosc.etag === this.ostatnioRozeslanyEtag) continue;
          this.ostatnioRozeslanyEtag = ostatni.wiadomosc.etag;
          const tekst = JSON.stringify(ostatni.wiadomosc);
          for (const ws of this.ctx.getWebSockets()) {
            try {
              ws.send(tekst);
            } catch {
              // Połączenie właśnie się zamyka; obsłuży je webSocketClose.
            }
          }
        } while (this.ponownie);
        if (ostatni) await this.ustawAlarm(ostatni.najblizszeWygasniecie);
      } finally {
        this.rozsylanie = null;
      }
    })();
    return this.rozsylanie;
  }

  /** Stan sali i najbliższe wygaśnięcie: jedna podróż do D1 albo (dla nowych połączeń) pamięć sprzed < 1 s. */
  private async odczytaj(eventId: string, { zPamieci }: { zPamieci: boolean }): Promise<OdczytSali | null> {
    const teraz = zegarSystemowy.teraz();
    if (zPamieci && this.pamiec && teraz - this.pamiec.odczytano < WAZNOSC_PAMIECI_MS) return this.pamiec;
    const stan = await zTimeoutem(stanSali(this.env.DB, eventId, teraz), TIMEOUT_BAZY_MS);
    if (!stan) return null;
    // Ten sam ETag co w GET /api/events/:id, więc klient może płynnie wrócić do odpytywania.
    const wiadomosc: WiadomoscStanu = { typ: "stan", dane: stan.dane, etag: slabyEtag(JSON.stringify(stan.dane)) };
    this.pamiec = { wiadomosc, najblizszeWygasniecie: stan.najblizszeWygasniecie, odczytano: teraz };
    return this.pamiec;
  }

  private async ustawAlarm(kiedy: number | null): Promise<void> {
    if (this.ctx.getWebSockets().length === 0 || kiedy === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(kiedy + ZAPAS_ALARMU_MS);
  }
}
