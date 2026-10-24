"use client";

// Stałe połączenie WebSocket z kanałem „na żywo": serwer sam wysyła zmiany.
// - ponawia połączenie z backoffem i jitterem, a po kilku nieudanych próbach odpuszcza
//   (wtedy mapa odpytuje serwer po staremu) i próbuje znów po powrocie na kartę,
// - co 40 s wysyła "ping", żeby pośrednicy nie zamknęli bezczynnego połączenia
//   (serwer odpowiada automatycznie, bez budzenia obiektu),
// - przy odmontowaniu zamyka połączenie i sprząta wszystkie timery.

import { useEffect, useRef, useState } from "react";
import { PING, PONG } from "@/lib/push/protokol";

export type StanPolaczenia = "laczenie" | "na-zywo" | "rozlaczony";

export const CO_ILE_PING_MS = 40_000;
const BAZA_PONOWIENIA_MS = 1000;
const MAX_PONOWIENIE_MS = 30_000;

export interface OpcjeNaZywo {
  /** Ile nieudanych prób z rzędu, zanim przestaniemy próbować (do powrotu na kartę). */
  maxProb?: number;
}

export interface StanNaZywo {
  stan: StanPolaczenia;
  /** Czy połączenie choć raz działało (po zerwaniu warto od razu odpytać serwer). */
  bylPolaczony: boolean;
}

function adresWebSocket(sciezka: string): string {
  const url = new URL(sciezka, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function useNaZywo(sciezka: string | null, naWiadomosc: (dane: unknown) => void, opcje: OpcjeNaZywo = {}): StanNaZywo {
  const { maxProb = 6 } = opcje;
  const [stan, ustawStan] = useState<StanPolaczenia>("laczenie");
  const [bylPolaczony, ustawBylPolaczony] = useState(false);
  const naWiadomoscRef = useRef(naWiadomosc);

  useEffect(() => {
    naWiadomoscRef.current = naWiadomosc;
  });

  useEffect(() => {
    if (!sciezka || typeof WebSocket === "undefined") {
      ustawStan("rozlaczony");
      return;
    }
    let aktywny = true;
    let gniazdo: WebSocket | null = null;
    let proby = 0;
    let timerPonowienia: ReturnType<typeof setTimeout> | undefined;
    let timerPing: ReturnType<typeof setInterval> | undefined;

    const polacz = () => {
      if (!aktywny) return;
      ustawStan("laczenie");
      let ws: WebSocket;
      try {
        ws = new WebSocket(adresWebSocket(sciezka));
      } catch {
        zaplanujPonowienie();
        return;
      }
      gniazdo = ws;
      ws.onopen = () => {
        if (!aktywny) return;
        proby = 0;
        ustawStan("na-zywo");
        ustawBylPolaczony(true);
        clearInterval(timerPing);
        timerPing = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(PING);
        }, CO_ILE_PING_MS);
      };
      ws.onmessage = (zdarzenie: MessageEvent) => {
        if (typeof zdarzenie.data !== "string" || zdarzenie.data === PONG) return;
        try {
          naWiadomoscRef.current(JSON.parse(zdarzenie.data));
        } catch {
          // Nieczytelna wiadomość: pomijamy, następna przyniesie pełny stan.
        }
      };
      ws.onclose = () => {
        clearInterval(timerPing);
        if (gniazdo === ws) gniazdo = null;
        if (!aktywny) return;
        ustawStan("rozlaczony");
        zaplanujPonowienie();
      };
    };

    function zaplanujPonowienie() {
      proby++;
      if (proby > maxProb) return; // odpuszczamy; spróbujemy znów po powrocie na kartę
      const opoznienie = Math.min(MAX_PONOWIENIE_MS, BAZA_PONOWIENIA_MS * 2 ** (proby - 1));
      clearTimeout(timerPonowienia);
      // Jitter: losowo z [½·opóźnienie, opóźnienie], żeby po awarii klienci nie wracali wszyscy naraz.
      timerPonowienia = setTimeout(polacz, Math.round(opoznienie * (0.5 + Math.random() / 2)));
    }

    const naZmianeWidocznosci = () => {
      if (document.visibilityState !== "visible" || gniazdo) return;
      proby = 0;
      clearTimeout(timerPonowienia);
      polacz();
    };

    polacz();
    document.addEventListener("visibilitychange", naZmianeWidocznosci);

    return () => {
      aktywny = false;
      clearTimeout(timerPonowienia);
      clearInterval(timerPing);
      document.removeEventListener("visibilitychange", naZmianeWidocznosci);
      const ws = gniazdo;
      gniazdo = null;
      if (ws) {
        ws.onopen = ws.onmessage = ws.onclose = null;
        if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close(1000);
      }
    };
  }, [sciezka, maxProb]);

  return { stan, bylPolaczony };
}
