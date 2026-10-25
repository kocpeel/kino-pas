"use client";

// Formularz B: imię + e-mail → POST /api/reservations z kluczem idempotencji.
// Walidacja inline (po opuszczeniu pola i przy wysłaniu) tymi samymi regułami co serwer.
// Słucha kanału na żywo sali: gdy ktoś inny zarezerwuje ten fotel, od razu to pokazuje i blokuje
// wysyłkę (a gdy fotel znów się zwolni, odblokowuje). Ostatnie słowo i tak ma serwer (409).

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useNaZywo } from "@/hooks/useNaZywo";
import { Baner } from "@/components/ui/Baner";
import { LinkPrzycisk, Przycisk } from "@/components/ui/Przycisk";
import { Pole } from "@/components/ui/Pole";
import { KOMUNIKATY_POL, normalizujEmail, normalizujImie } from "@/lib/domain/dane-klienta";
import { BladApi, czyPrzerwane, nowyKluczIdempotencji, utworzRezerwacje } from "@/lib/klient/api";
import { opiszBlad, type OpisBleduUi } from "@/lib/klient/komunikaty";
import { kluczFormularza, usunKluczFormularza, zapiszRezerwacje } from "@/lib/klient/sesja";
import { czyWiadomoscStanu, sciezkaNaZywo } from "@/lib/push/protokol";

type NazwaPola = "name" | "email";
type BledyPol = Partial<Record<NazwaPola, string>>;

function walidujPole(pole: NazwaPola, wartosc: string): string | undefined {
  if (pole === "name") return normalizujImie(wartosc) ? undefined : KOMUNIKATY_POL.name;
  return normalizujEmail(wartosc) ? undefined : KOMUNIKATY_POL.email;
}

interface Props {
  eventId: string;
  seatId: string;
  /** Adres kanału na żywo sali (jak w MapaSali); null = bez kanału. */
  adresKanalu?: string | null;
}

export function FormularzRezerwacji({ eventId, seatId, adresKanalu }: Props) {
  const router = useRouter();
  const [wartosci, ustawWartosci] = useState<Record<NazwaPola, string>>({ name: "", email: "" });
  const [dotkniete, ustawDotkniete] = useState<Record<NazwaPola, boolean>>({ name: false, email: false });
  const [bledyPol, ustawBledyPol] = useState<BledyPol>({});
  const [wysylanie, ustawWysylanie] = useState(false);
  const [blad, ustawBlad] = useState<OpisBleduUi | null>(null);

  // Synchroniczna blokada: dwa szybkie kliknięcia = jedno żądanie, zanim React zdąży przerysować.
  const wTrakcieRef = useRef(false);
  const kontrolerRef = useRef<AbortController | null>(null);
  const poleImieniaRef = useRef<HTMLInputElement>(null);
  const poleEmailaRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => kontrolerRef.current?.abort(), []);

  // Zajęcie fotela może być NASZE: serwer rozsyła zmianę czasem zanim dotrze odpowiedź na naszą rezerwację,
  // a po timeoucie nie wiemy, czy rezerwacja powstała. Wtedy nie mówimy „zajął ktoś inny".
  const mozeNaszeRef = useRef(false);
  const [zajetyPrzezInnego, ustawZajetyPrzezInnego] = useState(false);
  const naWiadomosc = useCallback(
    (wiadomosc: unknown) => {
      if (!czyWiadomoscStanu(wiadomosc)) return;
      const zajety = wiadomosc.dane.takenSeats.includes(seatId);
      if (zajety && (wTrakcieRef.current || mozeNaszeRef.current)) return;
      ustawZajetyPrzezInnego(zajety);
    },
    [seatId],
  );
  useNaZywo(adresKanalu === undefined ? sciezkaNaZywo(eventId) : adresKanalu, naWiadomosc);

  const zmien = (pole: NazwaPola, wartosc: string) => {
    ustawWartosci((w) => ({ ...w, [pole]: wartosc }));
    if (dotkniete[pole]) ustawBledyPol((b) => ({ ...b, [pole]: walidujPole(pole, wartosc) }));
  };

  const opusc = (pole: NazwaPola) => {
    ustawDotkniete((d) => ({ ...d, [pole]: true }));
    ustawBledyPol((b) => ({ ...b, [pole]: walidujPole(pole, wartosci[pole]) }));
  };

  async function wyslij(zdarzenie?: FormEvent) {
    zdarzenie?.preventDefault();
    if (wTrakcieRef.current || zajetyPrzezInnego) return;

    const bledy: BledyPol = { name: walidujPole("name", wartosci.name), email: walidujPole("email", wartosci.email) };
    ustawBledyPol(bledy);
    ustawDotkniete({ name: true, email: true });
    if (bledy.name) return poleImieniaRef.current?.focus();
    if (bledy.email) return poleEmailaRef.current?.focus();

    wTrakcieRef.current = true;
    ustawWysylanie(true);
    ustawBlad(null);
    const klucz = kluczFormularza(eventId, seatId, nowyKluczIdempotencji);
    const kontroler = new AbortController();
    kontrolerRef.current = kontroler;

    try {
      const name = normalizujImie(wartosci.name) as string;
      const email = normalizujEmail(wartosci.email) as string;
      const { dane, przesuniecieZegara } = await utworzRezerwacje({ eventId, seatId, name, email }, klucz, {
        sygnal: kontroler.signal,
      });
      zapiszRezerwacje({
        reservationId: dane.reservationId,
        eventId,
        seatId,
        expiresAt: dane.expiresAt,
        utworzono: Math.min(Date.now() + przesuniecieZegara, dane.expiresAt),
        przesuniecieZegara,
        name,
        email,
      });
      usunKluczFormularza(eventId, seatId);
      // Przycisk zostaje zablokowany do końca nawigacji.
      router.push(`/rezerwacja/${dane.reservationId}?seans=${encodeURIComponent(eventId)}&miejsce=${seatId}`);
    } catch (bladZadania) {
      if (czyPrzerwane(bladZadania)) return;
      if (bladZadania instanceof BladApi) {
        // Rezerwacja na pewno nie powstała: następna próba dostaje nowy klucz.
        const rozstrzygniete = [400, 404, 409, 422, 429].includes(bladZadania.status);
        if (rozstrzygniete) usunKluczFormularza(eventId, seatId);
        // Timeout / 503: zapis mógł się udać, więc zajęcie fotela może być nasze.
        mozeNaszeRef.current = !rozstrzygniete;
        if (bladZadania.status === 400 && bladZadania.szczegoly) {
          const zSerwera = bladZadania.szczegoly;
          ustawBledyPol({ name: zSerwera.name, email: zSerwera.email });
        }
      }
      ustawBlad(opiszBlad(bladZadania));
      wTrakcieRef.current = false;
      ustawWysylanie(false);
    }
  }

  const adresMapy = `/seans/${encodeURIComponent(eventId)}?zajete=${seatId}`;

  return (
    <form onSubmit={wyslij} noValidate aria-describedby="pomoc-formularza">
      <Pole
        ref={poleImieniaRef}
        id="imie"
        name="name"
        etykieta="Imię"
        autoComplete="given-name"
        required
        maxLength={80}
        value={wartosci.name}
        onChange={(e) => zmien("name", e.target.value)}
        onBlur={() => opusc("name")}
        blad={bledyPol.name}
      />
      <Pole
        ref={poleEmailaRef}
        id="email"
        name="email"
        type="email"
        inputMode="email"
        etykieta="E-mail"
        autoComplete="email"
        autoCapitalize="none"
        spellCheck={false}
        required
        maxLength={254}
        value={wartosci.email}
        onChange={(e) => zmien("email", e.target.value)}
        onBlur={() => opusc("email")}
        blad={bledyPol.email}
        podpowiedz="Na ten adres w kolejnym etapie wyślemy potwierdzenie."
      />

      <p id="pomoc-formularza" className="pole__podpowiedz" style={{ marginBottom: "var(--odstep-4)" }}>
        Po rezerwacji fotel będzie czekał na Ciebie przez ograniczony czas. Licznik pokaże, ile go zostało.
      </p>

      {zajetyPrzezInnego ? (
        <div className="banery">
          <Baner
            rodzaj="ostrzezenie"
            rola="alert"
            tytul="Ten fotel właśnie zajął ktoś inny"
            akcje={
              <LinkPrzycisk href={adresMapy} wariant="drugi">
                Wróć do mapy
              </LinkPrzycisk>
            }
          >
            Wybierz inne miejsce na mapie sali. Jeśli tamta rezerwacja wygaśnie, ten formularz sam się odblokuje.
          </Baner>
        </div>
      ) : blad ? (
        <div className="banery">
          <Baner
            rodzaj="blad"
            rola="alert"
            tytul={blad.tytul}
            akcje={
              blad.akcja === "mapa" ? (
                <LinkPrzycisk href={adresMapy} wariant="drugi">
                  Wróć do mapy
                </LinkPrzycisk>
              ) : blad.akcja === "ponow" ? (
                <Przycisk wariant="drugi" onClick={() => void wyslij()} laduje={wysylanie}>
                  Spróbuj ponownie
                </Przycisk>
              ) : null
            }
          >
            {blad.tresc}
          </Baner>
        </div>
      ) : null}

      <Przycisk type="submit" szeroki laduje={wysylanie} disabled={zajetyPrzezInnego}>
        {wysylanie ? "Rezerwuję…" : "Zarezerwuj fotel"}
      </Przycisk>
    </form>
  );
}
