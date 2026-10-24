"use client";

// Mapa sali: siatka foteli z nawigacją strzałkami (roving tabindex).
// Zmiany przychodzą „na żywo" przez WebSocket (serwer sam je wysyła). Gdy kanał nie działa
// (blokada w sieci, awaria), mapa wraca do adaptacyjnego odpytywania serwera.
// Kliknięcie wolnego fotela tylko przenosi do formularza: samo w sobie niczego nie rezerwuje.

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useNaZywo } from "@/hooks/useNaZywo";
import { usePolling } from "@/hooks/usePolling";
import { czyPrzywroconyRender } from "@/hooks/usePrzywroconyRender";
import { Baner } from "@/components/ui/Baner";
import { Przycisk } from "@/components/ui/Przycisk";
import { rzedySali } from "@/lib/domain/uklad-sali";
import { pobierzSzczegolySeansu, type Wersja } from "@/lib/klient/api";
import type { SzczegolySeansu } from "@/lib/domain/typy";
import { czyWiadomoscStanu, sciezkaNaZywo } from "@/lib/push/protokol";
import { CzasOdswiezenia } from "./CzasOdswiezenia";
import { Fotel } from "./Fotel";
import { Legenda } from "./Legenda";

/** Odpytywanie zapasowe (gdy kanał na żywo nie działa), gdy na sali coś się dzieje. */
export const INTERWAL_ODSWIEZANIA_MS = 5000;
/** Najrzadsze odświeżanie, gdy kolejne odpowiedzi nic nie zmieniają (304). */
export const MAX_INTERWAL_ODSWIEZANIA_MS = 30_000;

interface Props {
  eventId: string;
  rzedy: number;
  miejscaWRzedzie: number;
  poczatkoweZajete: string[];
  /** Fotel, który przy próbie rezerwacji okazał się zajęty (powrót po 409). */
  swiezoZajety?: string | null;
  /** Znacznik renderu serwera: ten sam przy ponownym montażu = dane z pamięci routera („Wstecz"). */
  wyrenderowano?: number;
  /** false = bez kanału na żywo (np. `next dev`, który nie uruchamia worker.ts); zostaje odpytywanie. */
  kanalNaZywo?: boolean;
}

export function MapaSali({
  eventId,
  rzedy,
  miejscaWRzedzie,
  poczatkoweZajete,
  swiezoZajety = null,
  wyrenderowano,
  kanalNaZywo = true,
}: Props) {
  const router = useRouter();
  const literyRzedow = useMemo(() => rzedySali({ rzedy, miejscaWRzedzie }), [rzedy, miejscaWRzedzie]);
  const numery = useMemo(() => Array.from({ length: miejscaWRzedzie }, (_, i) => i + 1), [miejscaWRzedzie]);

  // Po „Wstecz" stan z pamięci routera może być stary: pierwsze sprawdzenie od razu.
  const [pierwszeZaMs, ustawPierwszeZaMs] = useState(INTERWAL_ODSWIEZANIA_MS);
  useEffect(() => {
    if (wyrenderowano !== undefined && czyPrzywroconyRender(`mapa:${eventId}`, wyrenderowano)) ustawPierwszeZaMs(0);
  }, [eventId, wyrenderowano]);

  // Kanał na żywo: serwer przysyła pełny stan sali po każdej zmianie.
  const [zKanalu, ustawZKanalu] = useState<{ wersja: Wersja<SzczegolySeansu>; kiedy: number } | null>(null);
  const naWiadomosc = useCallback((wiadomosc: unknown) => {
    if (czyWiadomoscStanu(wiadomosc)) {
      ustawZKanalu({ wersja: { dane: wiadomosc.dane, etag: wiadomosc.etag }, kiedy: Date.now() });
    }
  }, []);
  const naZywo = useNaZywo(kanalNaZywo ? sciezkaNaZywo(eventId) : null, naWiadomosc);
  const kanalDziala = naZywo.stan === "na-zywo";

  const pobierz = useCallback(
    (sygnal: AbortSignal, poprzednia: Wersja<SzczegolySeansu> | undefined) =>
      pobierzSzczegolySeansu(eventId, { sygnal, proby: 1, poprzednia }),
    [eventId],
  );
  const polling = usePolling(pobierz, {
    // Odpytujemy tylko, gdy kanał na żywo nie działa; po jego zerwaniu od razu.
    wlaczony: !kanalDziala,
    interwalMs: INTERWAL_ODSWIEZANIA_MS,
    maxInterwalMs: MAX_INTERWAL_ODSWIEZANIA_MS,
    pierwszeZaMs: naZywo.bylPolaczony ? 0 : pierwszeZaMs,
    maxPorazek: 4,
    // 304 zwraca ten sam obiekt, więc „bez zmian" = ta sama referencja.
    czyZmiana: (poprzednia, nowa) => poprzednia !== nowa,
  });

  // Najnowszy stan z dwóch źródeł (kanał albo odpytywanie).
  const aktualne = useMemo(() => {
    const zPollingu =
      polling.dane && polling.ostatniaAktualizacja !== null
        ? { wersja: polling.dane, kiedy: polling.ostatniaAktualizacja }
        : null;
    if (!zKanalu || !zPollingu) return zKanalu ?? zPollingu;
    return zKanalu.kiedy >= zPollingu.kiedy ? zKanalu : zPollingu;
  }, [zKanalu, polling.dane, polling.ostatniaAktualizacja]);

  // Zestaw jest podmieniany przy każdej odpowiedzi, nigdy rozszerzany.
  const zajete = useMemo(() => {
    const zestaw = new Set(aktualne?.wersja.dane.takenSeats ?? poczatkoweZajete);
    if (swiezoZajety && !aktualne) zestaw.add(swiezoZajety);
    return zestaw;
  }, [aktualne, poczatkoweZajete, swiezoZajety]);

  const [wybrany, ustawWybrany] = useState<string | null>(null);
  const [aktywny, ustawAktywny] = useState<string>(() => {
    const wolny = literyRzedow.flatMap((r) => numery.map((n) => `${r}${n}`)).find((s) => !poczatkoweZajete.includes(s));
    return wolny ?? `${literyRzedow[0]}1`;
  });

  const przyciski = useRef(new Map<string, HTMLButtonElement>());
  const zarejestruj = useCallback((seatId: string, element: HTMLButtonElement | null) => {
    if (element) przyciski.current.set(seatId, element);
    else przyciski.current.delete(seatId);
  }, []);

  const onWybierz = useCallback(
    (seatId: string) => {
      ustawWybrany(seatId);
      router.push(`/seans/${encodeURIComponent(eventId)}/miejsce/${seatId}`);
    },
    [eventId, router],
  );

  const onFokus = useCallback((seatId: string) => ustawAktywny(seatId), []);

  const naKlawisz = (zdarzenie: KeyboardEvent<HTMLDivElement>) => {
    const r = literyRzedow.indexOf(aktywny.charAt(0));
    const n = Number(aktywny.slice(1));
    if (r < 0 || !Number.isFinite(n)) return;
    let nowyR = r;
    let nowyN = n;
    switch (zdarzenie.key) {
      case "ArrowRight":
        nowyN = Math.min(miejscaWRzedzie, n + 1);
        break;
      case "ArrowLeft":
        nowyN = Math.max(1, n - 1);
        break;
      case "ArrowDown":
        nowyR = Math.min(literyRzedow.length - 1, r + 1);
        break;
      case "ArrowUp":
        nowyR = Math.max(0, r - 1);
        break;
      case "Home":
        nowyN = 1;
        if (zdarzenie.ctrlKey) nowyR = 0;
        break;
      case "End":
        nowyN = miejscaWRzedzie;
        if (zdarzenie.ctrlKey) nowyR = literyRzedow.length - 1;
        break;
      default:
        return;
    }
    zdarzenie.preventDefault();
    const cel = `${literyRzedow[nowyR]}${nowyN}`;
    ustawAktywny(cel);
    przyciski.current.get(cel)?.focus();
  };

  const styl = { "--kolumny": miejscaWRzedzie } as CSSProperties;
  const { przyspiesz } = polling;

  return (
    // Użytkownik patrzy na mapę albo nią steruje: odświeżamy z bazową częstotliwością.
    <div className="sala" style={styl} onPointerEnter={przyspiesz} onFocusCapture={przyspiesz}>
      {swiezoZajety ? (
        <div className="banery">
          <Baner rodzaj="ostrzezenie" tytul="Ten fotel został właśnie zajęty" rola="alert">
            Ktoś był szybszy. Wybierz inne miejsce z mapy poniżej.
          </Baner>
        </div>
      ) : null}

      <div className="sala__ekran" aria-hidden="true">
        Ekran
      </div>

      <div
        role="grid"
        aria-label={`Mapa sali: rzędy ${literyRzedow[0]}–${literyRzedow.at(-1)}, miejsca 1–${miejscaWRzedzie}. Strzałki przenoszą między fotelami.`}
        aria-describedby="legenda-sali"
        className="sala__siatka"
        onKeyDown={naKlawisz}
      >
        <div className="sala__wiersz" aria-hidden="true">
          <span />
          {numery.map((n) => (
            <span key={n} className="sala__etykieta cyfry">
              {n}
            </span>
          ))}
          <span />
        </div>
        {literyRzedow.map((rzad) => (
          <div role="row" className="sala__wiersz" key={rzad}>
            <span className="sala__etykieta" aria-hidden="true">
              {rzad}
            </span>
            {numery.map((numer) => {
              const seatId = `${rzad}${numer}`;
              return (
                <div role="gridcell" key={seatId}>
                  <Fotel
                    seatId={seatId}
                    rzad={rzad}
                    numer={numer}
                    zajety={zajete.has(seatId)}
                    wybrany={wybrany === seatId}
                    swiezoZajety={swiezoZajety === seatId}
                    wKolejnosciTab={aktywny === seatId}
                    onWybierz={onWybierz}
                    onFokus={onFokus}
                    zarejestruj={zarejestruj}
                  />
                </div>
              );
            })}
            <span className="sala__etykieta" aria-hidden="true">
              {rzad}
            </span>
          </div>
        ))}
      </div>

      <Legenda />

      <div className="sala__stopka" aria-live="off">
        {kanalDziala ? (
          <span className="na-zywo">
            <span className="na-zywo__kropka" aria-hidden="true" />
            Na żywo
          </span>
        ) : (
          <CzasOdswiezenia kiedy={aktualne?.kiedy ?? null} />
        )}
        <span aria-hidden="true">·</span>
        <span className="cyfry">wolne {numery.length * literyRzedow.length - zajete.size}</span>
      </div>

      {polling.blad && !kanalDziala ? (
        <div className="banery" style={{ marginTop: "var(--odstep-4)" }}>
          <Baner
            rodzaj={polling.zatrzymany ? "blad" : "info"}
            tytul={polling.zatrzymany ? "Nie udało się odświeżyć mapy" : "Problem z odświeżeniem mapy"}
            akcje={
              polling.zatrzymany ? (
                <Przycisk wariant="drugi" onClick={polling.odswiez}>
                  Odśwież
                </Przycisk>
              ) : null
            }
          >
            {polling.zatrzymany
              ? "Pokazujemy ostatni znany stan sali. Ostateczne słowo i tak należy do serwera przy rezerwacji."
              : "Spróbujemy ponownie za chwilę."}
          </Baner>
        </div>
      ) : null}
    </div>
  );
}
