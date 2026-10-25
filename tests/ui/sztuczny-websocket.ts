// Atrapa WebSocket dla testów komponentów: nic nie wysyła w sieć, test sam steruje zdarzeniami.

export class SztucznyWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instancje: SztucznyWebSocket[] = [];

  readonly url: string;
  readyState = SztucznyWebSocket.CONNECTING;
  wyslane: string[] = [];
  zamknietoKodem: number | null = null;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    SztucznyWebSocket.instancje.push(this);
  }

  static ostatni(): SztucznyWebSocket {
    const ws = SztucznyWebSocket.instancje.at(-1);
    if (!ws) throw new Error("Nie utworzono żadnego WebSocketu");
    return ws;
  }

  send(dane: string): void {
    this.wyslane.push(dane);
  }

  close(kod = 1000): void {
    this.zamknietoKodem = kod;
    this.readyState = SztucznyWebSocket.CLOSED;
    this.onclose?.({ code: kod });
  }

  // ——— sterowanie z testu ———
  otworz(): void {
    this.readyState = SztucznyWebSocket.OPEN;
    this.onopen?.({});
  }

  odbierz(dane: unknown): void {
    this.onmessage?.({ data: typeof dane === "string" ? dane : JSON.stringify(dane) });
  }

  zerwij(kod = 1006): void {
    this.readyState = SztucznyWebSocket.CLOSED;
    this.onclose?.({ code: kod });
  }
}
