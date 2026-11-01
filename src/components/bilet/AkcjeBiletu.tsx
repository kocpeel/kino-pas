"use client";

// Strona powrotu po płatności. Czyta tylko status rezerwacji: „płatność w toku…” sama zamienia się
// w bilet z kodem, gdy serwer dostanie webhook od Stripe'a. Odświeżenie i nowa karta działają tak samo,
// bo kod przychodzi z serwera. Plus kopiuj / drukuj.

import { useCallback, useEffect, useRef, useState } from "react";
import { usePolling } from "@/hooks/usePolling";
import { Baner } from "@/components/ui/Baner";
import { LinkPrzycisk, Przycisk } from "@/components/ui/Przycisk";
import { Szkielet } from "@/components/ui/Szkielet";
import type { StanRezerwacji } from "@/lib/domain/typy";
import { formatujCene } from "@/lib/format";
import { BladApi, pobierzRezerwacje } from "@/lib/klient/api";
import { opiszBlad } from "@/lib/klient/komunikaty";
import { odczytajKodBiletu, zapiszKodBiletu } from "@/lib/klient/sesja";
import { Bilet, type DaneBiletu } from "./Bilet";

const CZAS_TOASTU_MS = 2500;
const INTERWAL_MS = 1500;
const MAX_INTERWAL_MS = 5000;
/** Webhook zwykle dociera w kilka sekund. Dłużej: mówimy, co się dzieje, i dajemy drogę z powrotem. */
const DLUGIE_CZEKANIE_MS = 20_000;

interface Props {
  reservationId: string;
  dane: DaneBiletu;
  /** session_id z przekierowania Stripe'a: klient wraca z płatności. */
  sesjaStripe?: string | null;
  /** Strona rezerwacji, gdyby klient jednak nie zapłacił. */
  adresRezerwacji?: string;
}

function czyBrak(blad: unknown): boolean {
  return blad instanceof BladApi && (blad.status === 404 || blad.status === 400);
}

function tekstZwrotu(stan: StanRezerwacji): string {
  if (stan.refund === "failed") {
    return "Płatność dotarła po czasie, a automatyczny zwrot się nie udał. Obsługa zwróci pieniądze ręcznie.";
  }
  if (stan.refund) return "Płatność dotarła po czasie, więc bilet nie powstał. Pieniądze wracają na Twoją kartę.";
  return "Rezerwacja wygasła, zanim dotarła płatność, a fotel wrócił do puli.";
}

export function AkcjeBiletu({ reservationId, dane, sesjaStripe = null, adresRezerwacji }: Props) {
  const [zapisanyKod, ustawZapisanyKod] = useState<string | null>(null);
  const [odpytywanie, ustawOdpytywanie] = useState(true);
  // Bez session_id nikt nie wraca z płatności, więc nie ma na co czekać.
  const [dlugoCzekamy, ustawDlugoCzekamy] = useState(!sesjaStripe);
  const [toast, ustawToast] = useState<string | null>(null);
  const timerToastu = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    ustawZapisanyKod(odczytajKodBiletu(reservationId));
  }, [reservationId]);

  const pobierz = useCallback(
    (sygnal: AbortSignal) =>
      pobierzRezerwacje(reservationId, { sygnal, proby: 1 }).then((odpowiedz) => odpowiedz.dane),
    [reservationId],
  );
  const {
    dane: stan,
    blad,
    zatrzymany,
    odswiez,
  } = usePolling<StanRezerwacji>(pobierz, {
    interwalMs: INTERWAL_MS,
    maxInterwalMs: MAX_INTERWAL_MS,
    pierwszeZaMs: 0,
    maxPorazek: 6,
    wlaczony: odpytywanie,
    czyZmiana: (poprzedni, nowy) => poprzedni?.status !== nowy.status,
  });

  useEffect(() => {
    if ((stan && stan.status !== "held") || czyBrak(blad)) ustawOdpytywanie(false);
    if (stan?.code) zapiszKodBiletu(reservationId, stan.code);
  }, [stan, blad, reservationId]);

  useEffect(() => {
    if (dlugoCzekamy || !odpytywanie) return;
    const timer = setTimeout(() => ustawDlugoCzekamy(true), DLUGIE_CZEKANIE_MS);
    return () => clearTimeout(timer);
  }, [dlugoCzekamy, odpytywanie]);

  useEffect(() => () => clearTimeout(timerToastu.current), []);

  const kod = stan?.code ?? zapisanyKod;

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

  if (!kod && czyBrak(blad)) {
    return (
      <div className="komunikat-strony">
        <h1 className="tytul-strony">Nie znaleźliśmy tego biletu</h1>
        <p className="podtytul">Nie ma takiej rezerwacji. Sprawdź adres albo wybierz seans z repertuaru.</p>
        <LinkPrzycisk href="/">Wróć do repertuaru</LinkPrzycisk>
      </div>
    );
  }

  if (!kod && stan?.status === "expired") {
    return (
      <div className="komunikat-strony">
        <h1 className="tytul-strony">Ta rezerwacja wygasła</h1>
        <p className="podtytul">{tekstZwrotu(stan)}</p>
        <LinkPrzycisk href="/">Wróć do repertuaru</LinkPrzycisk>
      </div>
    );
  }

  return (
    <>
      {!kod ? (
        zatrzymany ? (
          <div className="banery">
            <Baner
              rodzaj="blad"
              rola="alert"
              tytul={blad ? opiszBlad(blad).tytul : "Nie udało się sprawdzić płatności"}
              akcje={
                <Przycisk wariant="drugi" onClick={odswiez}>
                  Spróbuj ponownie
                </Przycisk>
              }
            >
              Jeśli płatność się udała, bilet na Ciebie czeka. Sprawdzimy ponownie po kliknięciu.
            </Baner>
          </div>
        ) : (
          <div className="banery">
            <Baner
              rodzaj="info"
              tytul="Płatność w toku…"
              akcje={
                dlugoCzekamy && adresRezerwacji ? (
                  <LinkPrzycisk href={adresRezerwacji} wariant="drugi">
                    Wróć do rezerwacji
                  </LinkPrzycisk>
                ) : undefined
              }
            >
              {dlugoCzekamy
                ? "Nie widzimy jeszcze potwierdzenia płatności. Jeśli zapłacono, bilet pojawi się tutaj sam."
                : "Czekamy na potwierdzenie ze Stripe'a. Bilet pojawi się tutaj sam, nie zamykaj tej strony."}
            </Baner>
          </div>
        )
      ) : null}

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
              <span className="sr-only">Czekamy na kod biletu…</span>
            </span>
          )
        }
      />

      <div className="bilet__akcje">
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
        {kod ? (
          <p className="notka">
            {stan ? `Zapłacono ${formatujCene(stan.amount)}. ` : ""}Pokaż ten kod przy wejściu na salę.
          </p>
        ) : null}
      </div>

      <div className="sr-only" aria-live="polite">
        {kod ? "Płatność przyjęta, bilet jest gotowy." : ""}
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
