"use client";

// Karta rezerwacji: „Trzymamy Twój fotel jeszcze mm:ss”, podsumowanie, cena i „Zapłać 32 zł”.
// Tu wraca też klient, który przerwał płatność. Stan bierzemy z serwera, bo to on decyduje,
// a sessionStorage to tylko imię i e-mail do podsumowania oraz dane na czas pierwszego odczytu.
// Po zerze (albo po 410 z serwera) przełącza się na stan „wygasła”.

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatujPozostalo, useCountdown } from "@/hooks/useCountdown";
import { Baner } from "@/components/ui/Baner";
import { IkonaZegar } from "@/components/ui/Ikony";
import { LinkPrzycisk, Przycisk } from "@/components/ui/Przycisk";
import { Szkielet } from "@/components/ui/Szkielet";
import type { StanRezerwacji } from "@/lib/domain/typy";
import { opisMiejsca } from "@/lib/domain/uklad-sali";
import { formatujCene } from "@/lib/format";
import { BladApi, czyPrzerwane, pobierzRezerwacje, utworzPlatnosc } from "@/lib/klient/api";
import { opiszBlad, type OpisBleduUi } from "@/lib/klient/komunikaty";
import { przejdzDoPlatnosci } from "@/lib/klient/przekierowanie";
import { odczytajRezerwacje, type ZapisRezerwacji } from "@/lib/klient/sesja";

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
  /** Klient wrócił ze Stripe'a, przerywając płatność. */
  przerwano?: boolean;
}

interface OdczytSerwera {
  stan: StanRezerwacji;
  przesuniecieZegara: number;
}

export function Licznik({ reservationId, eventId, seatId, seans, przerwano = false }: Props) {
  const router = useRouter();
  // undefined = jeszcze nie odczytano sessionStorage (pierwszy render, także na serwerze).
  const [zapis, ustawZapis] = useState<ZapisRezerwacji | null | undefined>(undefined);
  const [serwer, ustawSerwer] = useState<OdczytSerwera | null>(null);
  const [odczytano, ustawOdczytano] = useState(false);
  const [brakRezerwacji, ustawBrakRezerwacji] = useState(false);
  const [wygaslaNaSerwerze, ustawWygaslaNaSerwerze] = useState(false);
  const [placenie, ustawPlacenie] = useState(false);
  const [blad, ustawBlad] = useState<OpisBleduUi | null>(null);
  const [ogloszenie, ustawOgloszenie] = useState("");
  const wTrakcieRef = useRef(false);
  const kontrolerRef = useRef<AbortController | null>(null);
  const ogloszoneRef = useRef({ minuta: false, koniec: false });

  const zapytanie = `seans=${encodeURIComponent(eventId ?? "")}&miejsce=${encodeURIComponent(seatId ?? "")}`;
  const adresBiletu = `/bilet/${reservationId}?${zapytanie}`;

  const sprawdzStan = useCallback(
    async (sygnal?: AbortSignal) => {
      try {
        const { dane, przesuniecieZegara } = await pobierzRezerwacje(reservationId, sygnal ? { sygnal } : {});
        ustawSerwer({ stan: dane, przesuniecieZegara });
        if (dane.status === "paid") router.replace(adresBiletu);
        if (dane.status === "expired") ustawWygaslaNaSerwerze(true);
        ustawOdczytano(true);
      } catch (bladZadania) {
        if (czyPrzerwane(bladZadania)) return;
        if (bladZadania instanceof BladApi && bladZadania.status === 404) ustawBrakRezerwacji(true);
        // Inny błąd: zostają dane z sessionStorage. Ostatnie słowo i tak ma serwer przy płatności.
        ustawOdczytano(true);
      }
    },
    [reservationId, router, adresBiletu],
  );

  useEffect(() => {
    ustawZapis(odczytajRezerwacje(reservationId));
    const kontroler = new AbortController();
    void sprawdzStan(kontroler.signal);
    return () => kontroler.abort();
  }, [reservationId, sprawdzStan]);

  useEffect(() => () => kontrolerRef.current?.abort(), []);

  // Wstecz ze strony Stripe'a przywraca stronę z pamięci przeglądarki, z zablokowanym przyciskiem.
  useEffect(() => {
    const naPowrot = (zdarzenie: PageTransitionEvent) => {
      if (!zdarzenie.persisted) return;
      wTrakcieRef.current = false;
      ustawPlacenie(false);
      void sprawdzStan();
    };
    window.addEventListener("pageshow", naPowrot);
    return () => window.removeEventListener("pageshow", naPowrot);
  }, [sprawdzStan]);

  const expiresAt = serwer?.stan.expiresAt ?? zapis?.expiresAt ?? null;
  const amount = serwer?.stan.amount ?? zapis?.amount ?? null;
  const przesuniecie = serwer?.przesuniecieZegara ?? zapis?.przesuniecieZegara ?? 0;

  const { pozostaloMs, wygasla: wygaslaLokalnie } = useCountdown(expiresAt, przesuniecie);
  const wygasla = wygaslaLokalnie || wygaslaNaSerwerze;

  // Czytnik ekranu słyszy tylko progi, nie każdą sekundę.
  useEffect(() => {
    if (pozostaloMs === null) return;
    if (pozostaloMs > 0 && pozostaloMs <= PROG_OSTRZEZENIA_MS && !ogloszoneRef.current.minuta) {
      ogloszoneRef.current.minuta = true;
      ustawOgloszenie("Została mniej niż minuta na płatność.");
    }
  }, [pozostaloMs]);

  useEffect(() => {
    if (wygasla && !ogloszoneRef.current.koniec) {
      ogloszoneRef.current.koniec = true;
      kontrolerRef.current?.abort();
      ustawOgloszenie("Rezerwacja wygasła, fotel wrócił do puli.");
    }
  }, [wygasla]);

  const cena = amount !== null ? formatujCene(amount) : null;
  const etykietaZaplac = cena ? `Zapłać ${cena}` : "Zapłać";

  async function zaplac() {
    if (wTrakcieRef.current || wygasla) return;
    wTrakcieRef.current = true;
    ustawPlacenie(true);
    ustawBlad(null);
    const kontroler = new AbortController();
    kontrolerRef.current = kontroler;
    try {
      const { url } = await utworzPlatnosc(reservationId, { sygnal: kontroler.signal });
      // Przycisk zostaje zablokowany do końca nawigacji.
      przejdzDoPlatnosci(url);
    } catch (bladZadania) {
      if (czyPrzerwane(bladZadania)) return;
      if (bladZadania instanceof BladApi && bladZadania.status === 410) {
        ustawWygaslaNaSerwerze(true);
      } else if (bladZadania instanceof BladApi && bladZadania.kod === "reservation_already_paid") {
        router.replace(adresBiletu);
        return;
      } else {
        ustawBlad(opiszBlad(bladZadania));
      }
      wTrakcieRef.current = false;
      ustawPlacenie(false);
    }
  }

  if (brakRezerwacji) {
    return (
      <div className="wygasla">
        <IkonaZegar rozmiar={48} className="wygasla__ikona" />
        <h1 className="karta__tytul">Nie znaleźliśmy tej rezerwacji</h1>
        <p className="karta__opis">Sprawdź adres albo wybierz seans z repertuaru.</p>
        <LinkPrzycisk href="/">Wróć do repertuaru</LinkPrzycisk>
      </div>
    );
  }

  if (wygasla) {
    return (
      <div className="wygasla">
        <IkonaZegar rozmiar={48} className="wygasla__ikona" />
        <h1 className="karta__tytul">Rezerwacja wygasła, fotel wrócił do puli</h1>
        <p className="karta__opis">
          {serwer?.stan.refund
            ? "Płatność dotarła po czasie, więc bilet nie powstał. Pieniądze wracają na Twoją kartę."
            : "Możesz wybrać ten sam fotel ponownie, jeśli nikt go jeszcze nie zajął."}
        </p>
        <LinkPrzycisk href={eventId ? `/seans/${encodeURIComponent(eventId)}` : "/"}>Wybierz inny fotel</LinkPrzycisk>
        <div className="sr-only" aria-live="polite">
          {ogloszenie}
        </div>
      </div>
    );
  }

  const utworzono = zapis?.utworzono ?? null;
  const calosc = expiresAt !== null && utworzono !== null ? Math.max(1, expiresAt - utworzono) : null;
  const ostrzezenie = pozostaloMs !== null && pozostaloMs <= PROG_OSTRZEZENIA_MS;
  const czekamyNaDane = expiresAt === null && (zapis === undefined || !odczytano);

  return (
    <div>
      {czekamyNaDane ? (
        <div aria-hidden="true">
          <Szkielet wysokosc="2.75rem" szerokosc="70%" />
          <Szkielet wysokosc="6px" className="licznik__pasek" />
        </div>
      ) : expiresAt === null ? (
        <Baner rodzaj="info" tytul="Nie widzimy czasu ważności tej rezerwacji">
          Nie udało się teraz odczytać rezerwacji. Jeśli jest nadal ważna, możesz zapłacić: serwer to sprawdzi.
        </Baner>
      ) : (
        <>
          <h1 className={`licznik${ostrzezenie ? " licznik--ostrzezenie" : ""}`}>
            Trzymamy Twój fotel jeszcze{" "}
            <span className="licznik__czas" role="timer" aria-live="off">
              {pozostaloMs === null ? "--:--" : formatujPozostalo(pozostaloMs)}
            </span>
          </h1>
          {calosc !== null ? (
            <div className="pasek licznik__pasek" aria-hidden="true">
              <div
                className={`pasek__wypelnienie${ostrzezenie ? " pasek__wypelnienie--ostrzezenie" : ""}`}
                style={{ width: `${Math.round(Math.min(1, (pozostaloMs ?? calosc) / calosc) * 1000) / 10}%` }}
              />
            </div>
          ) : null}
        </>
      )}

      {przerwano && !blad ? (
        <div className="banery licznik__pasek">
          <Baner rodzaj="info" tytul="Płatność przerwana">
            Nic nie pobraliśmy. Fotel czeka, dopóki licznik się nie skończy, więc możesz spróbować jeszcze raz.
          </Baner>
        </div>
      ) : null}

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
        {cena ? (
          <>
            <dt>Do zapłaty</dt>
            <dd className="seans__cena">{cena}</dd>
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

      <Przycisk szeroki laduje={placenie} onClick={() => void zaplac()}>
        {placenie ? "Przechodzę do płatności…" : blad?.akcja === "ponow" ? `Spróbuj ponownie: ${etykietaZaplac}` : etykietaZaplac}
      </Przycisk>
      <p className="notka">
        Płatność kartą na stronie Stripe, w trybie testowym: pieniądze nie są pobierane. Zapłać, zanim licznik dojdzie do
        zera, bo płatność po czasie wraca na kartę.
      </p>

      <div className="sr-only" aria-live="polite">
        {ogloszenie}
      </div>
    </div>
  );
}
