"use client";

// Karta B/C: „Trzymamy Twój fotel jeszcze mm:ss", podsumowanie i „Kupuję bilet".
// Po zerze (albo po 410 z serwera, bo to on decyduje) przełącza się na stan „wygasła".

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { formatujPozostalo, useCountdown } from "@/hooks/useCountdown";
import { Baner } from "@/components/ui/Baner";
import { IkonaZegar } from "@/components/ui/Ikony";
import { LinkPrzycisk, Przycisk } from "@/components/ui/Przycisk";
import { Szkielet } from "@/components/ui/Szkielet";
import { opisMiejsca } from "@/lib/domain/uklad-sali";
import { BladApi, czyPrzerwane, kupBilet } from "@/lib/klient/api";
import { opiszBlad, type OpisBleduUi } from "@/lib/klient/komunikaty";
import { odczytajRezerwacje, zapiszKodBiletu, type ZapisRezerwacji } from "@/lib/klient/sesja";

export const PROG_OSTRZEZENIA_MS = 60_000;

export interface OpisSeansu {
  movie: string;
  hall: string;
  termin: string;
}

interface Props {
  reservationId: string;
  eventId: string | null;
  seatId: string | null;
  seans: OpisSeansu | null;
}

export function Licznik({ reservationId, eventId, seatId, seans }: Props) {
  const router = useRouter();
  // undefined = jeszcze nie odczytano sessionStorage (pierwszy render, także na serwerze).
  const [zapis, ustawZapis] = useState<ZapisRezerwacji | null | undefined>(undefined);
  const [wygaslaNaSerwerze, ustawWygaslaNaSerwerze] = useState(false);
  const [kupowanie, ustawKupowanie] = useState(false);
  const [blad, ustawBlad] = useState<OpisBleduUi | null>(null);
  const [ogloszenie, ustawOgloszenie] = useState("");
  const wTrakcieRef = useRef(false);
  const kontrolerRef = useRef<AbortController | null>(null);
  const ogloszoneRef = useRef({ minuta: false, koniec: false });

  useEffect(() => {
    ustawZapis(odczytajRezerwacje(reservationId));
  }, [reservationId]);

  useEffect(() => () => kontrolerRef.current?.abort(), []);

  const { pozostaloMs, wygasla: wygaslaLokalnie } = useCountdown(zapis?.expiresAt ?? null, zapis?.przesuniecieZegara ?? 0);
  const wygasla = wygaslaLokalnie || wygaslaNaSerwerze;

  // Czytnik ekranu słyszy tylko progi, nie każdą sekundę.
  useEffect(() => {
    if (pozostaloMs === null) return;
    if (pozostaloMs > 0 && pozostaloMs <= PROG_OSTRZEZENIA_MS && !ogloszoneRef.current.minuta) {
      ogloszoneRef.current.minuta = true;
      ustawOgloszenie("Została mniej niż minuta na zakup biletu.");
    }
  }, [pozostaloMs]);

  useEffect(() => {
    if (wygasla && !ogloszoneRef.current.koniec) {
      ogloszoneRef.current.koniec = true;
      kontrolerRef.current?.abort();
      ustawOgloszenie("Rezerwacja wygasła, fotel wrócił do puli.");
    }
  }, [wygasla]);

  const zapytanie = `seans=${encodeURIComponent(eventId ?? "")}&miejsce=${encodeURIComponent(seatId ?? "")}`;

  async function kup() {
    if (wTrakcieRef.current || wygasla) return;
    wTrakcieRef.current = true;
    ustawKupowanie(true);
    ustawBlad(null);
    const kontroler = new AbortController();
    kontrolerRef.current = kontroler;
    try {
      const { code } = await kupBilet(reservationId, { sygnal: kontroler.signal });
      zapiszKodBiletu(reservationId, code);
      router.push(`/bilet/${reservationId}?${zapytanie}`);
    } catch (bladZadania) {
      if (czyPrzerwane(bladZadania)) return;
      if (bladZadania instanceof BladApi && bladZadania.status === 410) {
        ustawWygaslaNaSerwerze(true);
      } else {
        ustawBlad(opiszBlad(bladZadania));
      }
      wTrakcieRef.current = false;
      ustawKupowanie(false);
    }
  }

  if (wygasla) {
    return (
      <div className="wygasla">
        <IkonaZegar rozmiar={48} className="wygasla__ikona" />
        <h1 className="karta__tytul">Rezerwacja wygasła, fotel wrócił do puli</h1>
        <p className="karta__opis">Możesz wybrać ten sam fotel ponownie, jeśli nikt go jeszcze nie zajął.</p>
        <LinkPrzycisk href={eventId ? `/seans/${encodeURIComponent(eventId)}` : "/"}>Wybierz inny fotel</LinkPrzycisk>
        <div className="sr-only" aria-live="polite">
          {ogloszenie}
        </div>
      </div>
    );
  }

  const calosc = zapis ? Math.max(1, zapis.expiresAt - zapis.utworzono) : 1;
  const ulamek = pozostaloMs !== null ? Math.min(1, pozostaloMs / calosc) : 1;
  const ostrzezenie = pozostaloMs !== null && pozostaloMs <= PROG_OSTRZEZENIA_MS;

  return (
    <div>
      {zapis === undefined ? (
        <div aria-hidden="true">
          <Szkielet wysokosc="2.75rem" szerokosc="70%" />
          <Szkielet wysokosc="6px" className="licznik__pasek" />
        </div>
      ) : zapis === null ? (
        <Baner rodzaj="info" tytul="Nie widzimy czasu ważności tej rezerwacji">
          Ta karta przeglądarki nie zna szczegółów rezerwacji (np. otwarto ją w nowym oknie). Jeśli rezerwacja jest
          nadal ważna, możesz kupić bilet: serwer to sprawdzi.
        </Baner>
      ) : (
        <>
          <h1 className={`licznik${ostrzezenie ? " licznik--ostrzezenie" : ""}`}>
            Trzymamy Twój fotel jeszcze{" "}
            <span className="licznik__czas" role="timer" aria-live="off">
              {pozostaloMs === null ? "--:--" : formatujPozostalo(pozostaloMs)}
            </span>
          </h1>
          <div className="pasek licznik__pasek" aria-hidden="true">
            <div
              className={`pasek__wypelnienie${ostrzezenie ? " pasek__wypelnienie--ostrzezenie" : ""}`}
              style={{ width: `${Math.round(ulamek * 1000) / 10}%` }}
            />
          </div>
        </>
      )}

      <dl className="podsumowanie">
        {seans ? (
          <>
            <dt>Film</dt>
            <dd>{seans.movie}</dd>
            <dt>Termin</dt>
            <dd>{seans.termin}</dd>
            <dt>Sala</dt>
            <dd>{seans.hall}</dd>
          </>
        ) : null}
        {seatId ? (
          <>
            <dt>Miejsce</dt>
            <dd>{opisMiejsca(seatId)}</dd>
          </>
        ) : null}
        {zapis ? (
          <>
            <dt>Imię</dt>
            <dd>{zapis.name}</dd>
            <dt>E-mail</dt>
            <dd>{zapis.email}</dd>
          </>
        ) : null}
      </dl>

      {blad ? (
        <div className="banery">
          <Baner rodzaj="blad" rola="alert" tytul={blad.tytul}>
            {blad.tresc}
          </Baner>
        </div>
      ) : null}

      <Przycisk szeroki laduje={kupowanie} onClick={() => void kup()}>
        {kupowanie ? "Kupuję…" : blad?.akcja === "ponow" ? "Spróbuj ponownie: kupuję bilet" : "Kupuję bilet"}
      </Przycisk>

      <div className="sr-only" aria-live="polite">
        {ogloszenie}
      </div>
    </div>
  );
}
