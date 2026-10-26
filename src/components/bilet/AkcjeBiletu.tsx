"use client";

// Bilet C po stronie klienta: kod z sessionStorage albo, po odświeżeniu w nowej karcie,
// odtworzony idempotentnym POST zakupu (serwer zwraca zapisany kod). Plus kopiuj / drukuj.

import { useCallback, useEffect, useRef, useState } from "react";
import { Baner } from "@/components/ui/Baner";
import { LinkPrzycisk, Przycisk } from "@/components/ui/Przycisk";
import { Szkielet } from "@/components/ui/Szkielet";
import { BladApi, czyPrzerwane, kupBilet } from "@/lib/klient/api";
import { opiszBlad, type OpisBleduUi } from "@/lib/klient/komunikaty";
import { odczytajKodBiletu, zapiszKodBiletu } from "@/lib/klient/sesja";
import { Bilet, type DaneBiletu } from "./Bilet";

const CZAS_TOASTU_MS = 2500;

interface Props {
  reservationId: string;
  dane: DaneBiletu;
}

export function AkcjeBiletu({ reservationId, dane }: Props) {
  const [kod, ustawKod] = useState<string | null>(null);
  const [blad, ustawBlad] = useState<OpisBleduUi | null>(null);
  const [nieZnaleziono, ustawNieZnaleziono] = useState(false);
  const [proba, ustawProbe] = useState(0);
  const [toast, ustawToast] = useState<string | null>(null);
  const timerToastu = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const zapisany = odczytajKodBiletu(reservationId);
    if (zapisany) {
      ustawKod(zapisany);
      return;
    }
    const kontroler = new AbortController();
    kupBilet(reservationId, { sygnal: kontroler.signal })
      .then(({ code }) => {
        zapiszKodBiletu(reservationId, code);
        ustawKod(code);
      })
      .catch((bladZadania: unknown) => {
        if (czyPrzerwane(bladZadania)) return;
        if (bladZadania instanceof BladApi && (bladZadania.status === 410 || bladZadania.status === 400)) {
          ustawNieZnaleziono(true);
        } else {
          ustawBlad(opiszBlad(bladZadania));
        }
      });
    return () => kontroler.abort();
  }, [reservationId, proba]);

  useEffect(() => () => clearTimeout(timerToastu.current), []);

  // Jeden toast naraz: nowy zastępuje poprzedni i znika sam.
  const pokazToast = useCallback((tresc: string) => {
    clearTimeout(timerToastu.current);
    ustawToast(tresc);
    timerToastu.current = setTimeout(() => ustawToast(null), CZAS_TOASTU_MS);
  }, []);

  const kopiuj = async () => {
    if (!kod) return;
    try {
      await navigator.clipboard.writeText(kod);
      pokazToast("Skopiowano kod biletu");
    } catch {
      pokazToast("Nie udało się skopiować. Zaznacz kod i skopiuj go ręcznie.");
    }
  };

  if (nieZnaleziono) {
    return (
      <div className="komunikat-strony">
        <h1 className="tytul-strony">Nie znaleźliśmy tego biletu</h1>
        <p className="podtytul">Rezerwacja wygasła albo nie istnieje, więc bilet nie został kupiony.</p>
        <LinkPrzycisk href="/">Wróć do repertuaru</LinkPrzycisk>
      </div>
    );
  }

  return (
    <>
      <Bilet
        dane={dane}
        kod={
          kod ? (
            <strong className="bilet__kod" aria-label={`Kod biletu: ${kod.split("").join(" ")}`}>
              {kod}
            </strong>
          ) : (
            <span style={{ display: "inline-block", marginTop: "var(--odstep-2)" }}>
              <Szkielet szerokosc="12rem" wysokosc="2.5rem" />
              <span className="sr-only">Pobieranie kodu biletu…</span>
            </span>
          )
        }
      />

      <div className="bilet__akcje">
        {blad ? (
          <Baner
            rodzaj="blad"
            rola="alert"
            tytul={blad.tytul}
            akcje={
              <Przycisk wariant="drugi" onClick={() => (ustawBlad(null), ustawProbe((p) => p + 1))}>
                Spróbuj ponownie
              </Przycisk>
            }
          >
            {blad.tresc}
          </Baner>
        ) : null}
        <div className="przyciski">
          <Przycisk onClick={() => void kopiuj()} disabled={!kod}>
            Kopiuj kod
          </Przycisk>
          <Przycisk wariant="drugi" onClick={() => window.print()} disabled={!kod}>
            Drukuj
          </Przycisk>
          <LinkPrzycisk href="/" wariant="drugi">
            Wróć do repertuaru
          </LinkPrzycisk>
        </div>
        <p className="notka">Płatność online dojdzie w kolejnym etapie. Pokaż ten kod przy wejściu na salę.</p>
      </div>

      <div className="sr-only" aria-live="polite">
        {toast ?? ""}
      </div>
      {toast ? (
        <div className="toast" aria-hidden="true">
          {toast}
        </div>
      ) : null}
    </>
  );
}
