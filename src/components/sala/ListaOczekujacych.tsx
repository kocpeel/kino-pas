"use client";

// Karta A etapu IV: lista oczekujących na wyprzedanym wydarzeniu. Najpierw „Powiadom mnie” (imię i e-mail), potem
// miejsce w kolejce i „Wypisz mnie”; gdy zwolni się miejsce (karta B), link do zapłaty i godzina, do której czeka.
// Zapis pamiętamy w tej przeglądarce, więc po odświeżeniu strony panel wraca ze stanem z serwera. Ta sama część
// „stan zapisu” służy stronie /lista/<id>, na którą prowadzi link z maila.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Baner } from "@/components/ui/Baner";
import { Pole } from "@/components/ui/Pole";
import { LinkPrzycisk, Przycisk } from "@/components/ui/Przycisk";
import { usePolling } from "@/hooks/usePolling";
import { KOMUNIKATY_POL, normalizujEmail, normalizujImie } from "@/lib/domain/dane-klienta";
import type { StanZapisuNaListe } from "@/lib/domain/typy";
import { opisMiejsca } from "@/lib/domain/uklad-sali";
import { formatujGodzineZSekundami } from "@/lib/format";
import { BladApi, pobierzRezerwacje, pobierzZapisNaListe, wypiszZListy, zapiszNaListe } from "@/lib/klient/api";
import { odczytajRezerwacje, zapiszRezerwacje } from "@/lib/klient/sesja";

const INTERWAL_MS = 5000;

function kluczZapisu(eventId: string): string {
  return `lista:${eventId}`;
}

function odczytajZapis(eventId: string): string | null {
  try {
    return localStorage.getItem(kluczZapisu(eventId));
  } catch {
    return null;
  }
}

/** E-mail i imię z „Powiadom mnie”: strona płatności oferty potrzebuje e-maila do pola punktów. */
function kluczDanych(waitlistId: string): string {
  return `lista-dane:${waitlistId}`;
}

function zapamietajDane(waitlistId: string, dane: { email: string; customerName: string }): void {
  try {
    localStorage.setItem(kluczDanych(waitlistId), JSON.stringify(dane));
  } catch {
    // jw.
  }
}

function odczytajDane(waitlistId: string): { email: string; customerName: string } | null {
  try {
    const dane = JSON.parse(localStorage.getItem(kluczDanych(waitlistId)) ?? "null") as { email?: unknown; customerName?: unknown } | null;
    return typeof dane?.email === "string" && typeof dane.customerName === "string" ? { email: dane.email, customerName: dane.customerName } : null;
  } catch {
    return null;
  }
}

function zapamietajZapis(eventId: string, waitlistId: string | null): void {
  try {
    if (waitlistId) {
      localStorage.setItem(kluczZapisu(eventId), waitlistId);
      return;
    }
    const stary = localStorage.getItem(kluczZapisu(eventId));
    if (stary) localStorage.removeItem(kluczDanych(stary));
    localStorage.removeItem(kluczZapisu(eventId));
  } catch {
    // Prywatne okno albo zablokowana pamięć: zapis działa, tylko po odświeżeniu panel zacznie od formularza.
  }
}

interface Props {
  eventId: string;
  /** Każde miejsce kupione albo z ważną rezerwacją (soldOut z mapy, odświeżane na żywo). */
  wyprzedane: boolean;
}

export function ListaOczekujacych({ eventId, wyprzedane }: Props) {
  const [waitlistId, ustawWaitlistId] = useState<string | null>(null);
  const [wczytano, ustawWczytano] = useState(false);
  useEffect(() => {
    ustawWaitlistId(odczytajZapis(eventId));
    ustawWczytano(true);
  }, [eventId]);
  const zmien = useCallback(
    (id: string | null) => {
      zapamietajZapis(eventId, id);
      ustawWaitlistId(id);
    },
    [eventId],
  );

  if (!wczytano) return null;
  if (waitlistId) return <StanZapisu eventId={eventId} waitlistId={waitlistId} onZapomnij={() => zmien(null)} />;
  if (!wyprzedane) return null;
  return <FormularzListy eventId={eventId} onZapisano={zmien} />;
}

function FormularzListy({ eventId, onZapisano }: { eventId: string; onZapisano: (id: string) => void }) {
  const [imie, ustawImie] = useState("");
  const [email, ustawEmail] = useState("");
  const [bledy, ustawBledy] = useState<{ imie?: string | undefined; email?: string | undefined }>({});
  const [wysylanie, ustawWysylanie] = useState(false);
  const [blad, ustawBlad] = useState<string | null>(null);

  async function wyslij(zdarzenie: FormEvent) {
    zdarzenie.preventDefault();
    if (wysylanie) return;
    const customerName = normalizujImie(imie);
    const adres = normalizujEmail(email);
    ustawBledy({ imie: customerName ? undefined : KOMUNIKATY_POL.name, email: adres ? undefined : KOMUNIKATY_POL.email });
    if (!customerName || !adres) return;
    ustawWysylanie(true);
    ustawBlad(null);
    try {
      const { waitlistId } = await zapiszNaListe(eventId, { email: adres, customerName });
      zapamietajDane(waitlistId, { email: adres, customerName });
      onZapisano(waitlistId);
    } catch (b) {
      if (b instanceof BladApi && b.status === 400 && b.szczegoly) {
        ustawBledy({ imie: b.szczegoly.customerName, email: b.szczegoly.email });
      } else if (b instanceof BladApi && b.kod === "not_sold_out") {
        ustawBlad("Właśnie zwolniło się miejsce: wybierz je na mapie powyżej.");
      } else {
        ustawBlad(b instanceof BladApi ? b.message : "Nie udało się zapisać na listę. Spróbuj ponownie.");
      }
    } finally {
      ustawWysylanie(false);
    }
  }

  return (
    <section className="lista-oczekujacych" aria-labelledby="lista-tytul">
      <h2 id="lista-tytul" className="lista-oczekujacych__tytul">
        Wyprzedane
      </h2>
      <p className="lista-oczekujacych__opis">
        Wszystkie miejsca są zajęte. Zapisz się na listę oczekujących: gdy ktoś nie zapłaci za rezerwację, miejsce dostanie
        pierwsza osoba z kolejki, a my wyślemy jej mail z linkiem do zapłaty.
      </p>
      <form onSubmit={wyslij} noValidate>
        <Pole
          id="lista-imie"
          etykieta="Imię"
          value={imie}
          onChange={(e) => ustawImie(e.target.value)}
          blad={bledy.imie}
          autoComplete="given-name"
        />
        <Pole
          id="lista-email"
          etykieta="E-mail"
          type="email"
          inputMode="email"
          value={email}
          onChange={(e) => ustawEmail(e.target.value)}
          blad={bledy.email}
          podpowiedz="Na ten adres wyślemy link do zapłaty, gdy zwolni się miejsce."
          autoComplete="email"
        />
        {blad ? (
          <div className="banery">
            <Baner rodzaj="blad" tytul="Nie udało się zapisać" rola="alert">
              {blad}
            </Baner>
          </div>
        ) : null}
        <Przycisk type="submit" laduje={wysylanie}>
          Powiadom mnie
        </Przycisk>
      </form>
    </section>
  );
}

function linkRezerwacji(sciezka: "rezerwacja" | "bilet", eventId: string | null, stan: StanZapisuNaListe): string {
  const parametry = new URLSearchParams();
  if (eventId) parametry.set("seans", eventId);
  if (stan.seatId) parametry.set("miejsce", stan.seatId);
  const zapytanie = parametry.toString();
  return `/${sciezka}/${encodeURIComponent(stan.reservationId ?? "")}${zapytanie ? `?${zapytanie}` : ""}`;
}

interface PropsStanu {
  /** null = nie wiemy (strona /lista/<id>): link do zapłaty i tak działa po samym identyfikatorze rezerwacji. */
  eventId: string | null;
  waitlistId: string;
  /** Zapis się skończył albo go nie ma: panel wraca do formularza. */
  onZapomnij?: () => void;
}

export function StanZapisu({ eventId, waitlistId, onZapomnij }: PropsStanu) {
  const pobierz = useCallback((sygnal: AbortSignal) => pobierzZapisNaListe(waitlistId, { sygnal }), [waitlistId]);
  const [aktywny, ustawAktywny] = useState(true);
  const polling = usePolling<StanZapisuNaListe>(pobierz, {
    interwalMs: INTERWAL_MS,
    pierwszeZaMs: 0,
    maxPorazek: 6,
    wlaczony: aktywny,
    czyZmiana: (poprzedni, nowy) =>
      poprzedni?.status !== nowy.status || poprzedni?.position !== nowy.position || poprzedni?.reservationId !== nowy.reservationId,
  });
  const [poWypisaniu, ustawPoWypisaniu] = useState<StanZapisuNaListe | null>(null);
  const [wypisywanie, ustawWypisywanie] = useState(false);
  const [blad, ustawBlad] = useState<string | null>(null);
  const stan = poWypisaniu ?? polling.dane;

  useEffect(() => {
    if (stan && stan.status !== "waiting" && stan.status !== "offered") ustawAktywny(false);
  }, [stan]);

  // Oferta to zwykła rezerwacja: zapisujemy ją w pamięci sesji jak formularz rezerwacji, więc strona płatności zna
  // e-mail (pole „Użyj punktów”) i imię. Kwota i termin z serwera.
  const oferta = stan?.status === "offered" ? stan.reservationId : undefined;
  const fotelOferty = stan?.seatId;
  useEffect(() => {
    const dane = odczytajDane(waitlistId);
    if (!oferta || !fotelOferty || !eventId || !dane || odczytajRezerwacje(oferta)) return;
    const kontroler = new AbortController();
    pobierzRezerwacje(oferta, { sygnal: kontroler.signal, proby: 1 })
      .then(({ dane: r, przesuniecieZegara }) =>
        zapiszRezerwacje({
          reservationId: oferta,
          eventId,
          seatId: fotelOferty,
          expiresAt: r.expiresAt,
          amount: r.amount,
          utworzono: Math.min(Date.now() + przesuniecieZegara, r.expiresAt),
          przesuniecieZegara,
          name: dane.customerName,
          email: dane.email,
        }),
      )
      .catch(() => {
        // Bez tego strona płatności zapyta o e-mail przy punktach.
      });
    return () => kontroler.abort();
  }, [oferta, fotelOferty, eventId, waitlistId]);
  useEffect(() => {
    // Zapisu nie ma (np. wyczyszczona baza testowa): zaczynamy od formularza.
    if (polling.blad instanceof BladApi && (polling.blad.status === 404 || polling.blad.status === 400)) onZapomnij?.();
  }, [polling.blad, onZapomnij]);

  async function wypisz() {
    if (wypisywanie) return;
    ustawWypisywanie(true);
    ustawBlad(null);
    try {
      ustawPoWypisaniu(await wypiszZListy(waitlistId));
    } catch (b) {
      ustawBlad(b instanceof BladApi ? b.message : "Nie udało się wypisać. Spróbuj ponownie.");
    } finally {
      ustawWypisywanie(false);
    }
  }

  const ponownie = onZapomnij ? (
    <Przycisk wariant="drugi" onClick={onZapomnij}>
      Zapisz się ponownie
    </Przycisk>
  ) : null;
  const przyciskWypisania = (
    <Przycisk wariant="drugi" onClick={wypisz} laduje={wypisywanie}>
      Wypisz mnie
    </Przycisk>
  );

  let tresc;
  if (!stan) {
    tresc = <p className="lista-oczekujacych__opis">Sprawdzamy Twoje miejsce w kolejce…</p>;
  } else if (stan.status === "waiting") {
    tresc = (
      <Baner rodzaj="info" tytul="Jesteś na liście oczekujących" akcje={przyciskWypisania}>
        Twoje miejsce w kolejce: <strong className="cyfry">{stan.position}</strong>. Gdy zwolni się miejsce, zarezerwujemy je dla
        Ciebie i wyślemy mail z linkiem do zapłaty.
      </Baner>
    );
  } else if (stan.status === "offered") {
    tresc = (
      <Baner
        rodzaj="sukces"
        tytul="Zwolniło się miejsce dla Ciebie"
        akcje={
          <>
            <LinkPrzycisk href={linkRezerwacji("rezerwacja", eventId, stan)}>Zapłać za miejsce</LinkPrzycisk>
            {przyciskWypisania}
          </>
        }
      >
        {stan.seatId ? `${opisMiejsca(stan.seatId)} czeka` : "Miejsce czeka"} na Ciebie do{" "}
        <strong className="cyfry">{formatujGodzineZSekundami(stan.offerExpiresAt ?? Date.now())}</strong>. Zapłać kartą albo
        częściowo punktami; potem miejsce dostanie następna osoba.
      </Baner>
    );
  } else if (stan.status === "done") {
    tresc = (
      <Baner rodzaj="sukces" tytul="Masz bilet z listy oczekujących" akcje={<LinkPrzycisk href={linkRezerwacji("bilet", eventId, stan)}>Pokaż bilet</LinkPrzycisk>}>
        Miejsce jest Twoje.
      </Baner>
    );
  } else if (stan.status === "missed") {
    tresc = (
      <Baner rodzaj="ostrzezenie" tytul="Miejsce przeszło na następną osobę" akcje={ponownie}>
        Nie udało się zapłacić na czas albo mail z ofertą nie doszedł. Możesz zapisać się na listę jeszcze raz.
      </Baner>
    );
  } else {
    tresc = (
      <Baner rodzaj="info" tytul="Wypisałeś się z listy oczekujących" akcje={ponownie}>
        Nie dostaniesz już powiadomienia o tym wydarzeniu.
      </Baner>
    );
  }

  return (
    <section className="lista-oczekujacych" aria-label="Lista oczekujących" aria-live="polite">
      <div className="banery">{tresc}</div>
      {blad ? (
        <div className="banery">
          <Baner rodzaj="blad" tytul="Nie udało się wypisać" rola="alert">
            {blad}
          </Baner>
        </div>
      ) : null}
    </section>
  );
}
