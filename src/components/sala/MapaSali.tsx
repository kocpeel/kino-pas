"use client";

// Mapa sali: siatka foteli z nawigacją strzałkami (roving tabindex) i odświeżaniem pollingiem.
// Kliknięcie wolnego fotela tylko przenosi do formularza: samo w sobie niczego nie rezerwuje.

import { useRouter } from "next/navigation";
import { useCallback, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { usePolling } from "@/hooks/usePolling";
import { Baner } from "@/components/ui/Baner";
import { Przycisk } from "@/components/ui/Przycisk";
import { rzedySali } from "@/lib/domain/uklad-sali";
import { pobierzSzczegolySeansu } from "@/lib/klient/api";
import { CzasOdswiezenia } from "./CzasOdswiezenia";
import { Fotel } from "./Fotel";
import { Legenda } from "./Legenda";

export const INTERWAL_ODSWIEZANIA_MS = 5000;

interface Props {
  eventId: string;
  rzedy: number;
  miejscaWRzedzie: number;
  poczatkoweZajete: string[];
  /** Fotel, który przy próbie rezerwacji okazał się zajęty (powrót po 409). */
  swiezoZajety?: string | null;
}

export function MapaSali({ eventId, rzedy, miejscaWRzedzie, poczatkoweZajete, swiezoZajety = null }: Props) {
  const router = useRouter();
  const literyRzedow = useMemo(() => rzedySali({ rzedy, miejscaWRzedzie }), [rzedy, miejscaWRzedzie]);
  const numery = useMemo(() => Array.from({ length: miejscaWRzedzie }, (_, i) => i + 1), [miejscaWRzedzie]);

  const pobierz = useCallback(
    (sygnal: AbortSignal) => pobierzSzczegolySeansu(eventId, { sygnal, proby: 1 }),
    [eventId],
  );
  const polling = usePolling(pobierz, { interwalMs: INTERWAL_ODSWIEZANIA_MS, maxPorazek: 4 });

  // Zestaw jest podmieniany przy każdej odpowiedzi, nigdy rozszerzany.
  const zajete = useMemo(() => {
    const zestaw = new Set(polling.dane?.takenSeats ?? poczatkoweZajete);
    if (swiezoZajety && !polling.dane) zestaw.add(swiezoZajety);
    return zestaw;
  }, [polling.dane, poczatkoweZajete, swiezoZajety]);

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

  return (
    <div className="sala" style={styl}>
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
        <CzasOdswiezenia kiedy={polling.ostatniaAktualizacja} />
        <span aria-hidden="true">·</span>
        <span className="cyfry">wolne {numery.length * literyRzedow.length - zajete.size}</span>
      </div>

      {polling.blad ? (
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
