"use client";

// Stałe połączenie WebSocket z kanałem „na żywo": serwer sam wysyła zmiany.
// - ponawia połączenie z backoffem i jitterem, a po kilku nieudanych próbach odpuszcza
//   (wtedy mapa odpytuje serwer po staremu) i próbuje znów po powrocie na kartę,
// - połączenie, które nie otworzy się w 10 s, jest traktowane jak nieudane (zamiast wisieć),
// - po minucie na ukrytej karcie usypia kanał (zamyka połączenie), a po powrocie łączy się
//   od nowa i od razu dostaje świeży stan; krótkie przełączenie karty niczego nie zrywa,
// - co 40 s wysyła "ping", żeby pośrednicy nie zamknęli bezczynnego połączenia
//   (serwer odpowiada automatycznie, bez budzenia obiektu),
// - przy odmontowaniu zamyka połączenie i sprząta wszystkie timery.

import { useEffect, useRef, useState } from "react";
import { PING, PONG } from "@/lib/push/protokol";

/** "uspiony" = kanał świadomie zamknięty, bo karta jest od dłuższego czasu ukryta. */
export type StanPolaczenia = "laczenie" | "na-zywo" | "rozlaczony" | "uspiony";

export const CO_ILE_PING_MS = 40_000;
export const TIMEOUT_OTWARCIA_MS = 10_000;
export const USPIENIE_W_TLE_MS = 60_000;
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
  /**
   * Kanał nie działa i nie wiadomo, kiedy wróci (zerwany albo ponawiany po błędzie):
   * mapa powinna odpytywać serwer jak bez kanału. Nie dotyczy pierwszego łączenia ani uśpienia.
   */
  trybZapasowy: boolean;
}

function adresWebSocket(sciezka: string): string {
  const url = new URL(sciezka, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function useNaZywo(sciezka: string | null, naWiadomosc: (dane: unknown) => void, opcje: OpcjeNaZywo = {}): StanNaZywo {
  const { maxProb = 6 } = opcje;
  const [stan, ustawStan] = useState<StanPolaczenia>("laczenie");
  const [ponawianie, ustawPonawianie] = useState(false);
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
    let uspiony = false;
    let gniazdo: WebSocket | null = null;
    let proby = 0;
    let timerPonowienia: ReturnType<typeof setTimeout> | undefined;
    let timerOtwarcia: ReturnType<typeof setTimeout> | undefined;
    let timerUspienia: ReturnType<typeof setTimeout> | undefined;
    let timerPing: ReturnType<typeof setInterval> | undefined;

    const zamknijGniazdo = () => {
      const ws = gniazdo;
      gniazdo = null;
      clearTimeout(timerOtwarcia);
      clearInterval(timerPing);
      if (!ws) return;
      ws.onopen = ws.onmessage = ws.onclose = null;
      if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close(1000);
    };

    const polacz = () => {
      if (!aktywny || uspiony) return;
      ustawStan("laczenie");
      ustawPonawianie(proby > 0);
      let ws: WebSocket;
      try {
        ws = new WebSocket(adresWebSocket(sciezka));
      } catch {
        zaplanujPonowienie();
        return;
      }
      gniazdo = ws;
      // Połączenie, które ani się nie otwiera, ani nie kończy błędem, nie może wisieć w nieskończoność.
      clearTimeout(timerOtwarcia);
      timerOtwarcia = setTimeout(() => {
        if (gniazdo === ws && ws.readyState === WebSocket.CONNECTING) ws.close();
      }, TIMEOUT_OTWARCIA_MS);
      ws.onopen = () => {
        if (!aktywny) return;
        clearTimeout(timerOtwarcia);
        proby = 0;
        ustawStan("na-zywo");
        ustawPonawianie(false);
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
        clearTimeout(timerOtwarcia);
        clearInterval(timerPing);
        if (gniazdo === ws) gniazdo = null;
        if (!aktywny || uspiony) return;
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

    const usnij = () => {
      uspiony = true;
      clearTimeout(timerPonowienia);
      zamknijGniazdo();
      ustawStan("uspiony");
      ustawPonawianie(false);
    };

    const naZmianeWidocznosci = () => {
      if (document.visibilityState === "hidden") {
        clearTimeout(timerUspienia);
        timerUspienia = setTimeout(usnij, USPIENIE_W_TLE_MS);
        return;
      }
      clearTimeout(timerUspienia);
      if (!uspiony && gniazdo) return; // krótko w tle: połączenie nadal działa
      uspiony = false;
      proby = 0;
      clearTimeout(timerPonowienia);
      polacz(); // nowe połączenie od razu przynosi świeży stan sali
    };

    polacz();
    document.addEventListener("visibilitychange", naZmianeWidocznosci);

    return () => {
      aktywny = false;
      clearTimeout(timerPonowienia);
      clearTimeout(timerUspienia);
      document.removeEventListener("visibilitychange", naZmianeWidocznosci);
      zamknijGniazdo();
    };
  }, [sciezka, maxProb]);

  return {
    stan,
    bylPolaczony,
    trybZapasowy: stan === "rozlaczony" || (stan === "laczenie" && ponawianie),
  };
}
