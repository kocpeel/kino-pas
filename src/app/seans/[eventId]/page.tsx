// A2. Sala i mapa foteli. Stan początkowy renderuje serwer, dalej mapę odświeża klient.

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MapaSali } from "@/components/sala/MapaSali";
import { Baner } from "@/components/ui/Baner";
import { IkonaWstecz } from "@/components/ui/Ikony";
import { Karta } from "@/components/ui/Karta";
import { LinkPrzycisk } from "@/components/ui/Przycisk";
import { Kroki } from "@/components/uklad/Kroki";
import { zegarSystemowy } from "@/lib/czas";
import { czyPoprawneMiejsce } from "@/lib/domain/uklad-sali";
import { formatujTermin } from "@/lib/format";
import { parametr, wczytajSeans } from "@/lib/strony";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Wybór miejsca" };

interface Props {
  params: Promise<{ eventId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function StronaSali({ params, searchParams }: Props) {
  const { eventId } = await params;
  const zajeteZAdresu = parametr((await searchParams).zajete);
  const swiezoZajety = czyPoprawneMiejsce(zajeteZAdresu) ? zajeteZAdresu : null;

  const stan = await wczytajSeans(eventId);
  if (stan.rodzaj === "brak") notFound();

  return (
    <>
      <Kroki aktywny={2} />
      <Link href="/" className="powrot">
        <IkonaWstecz rozmiar={16} /> Repertuar
      </Link>

      {stan.rodzaj === "niedostepne" ? (
        <Baner
          rodzaj="blad"
          tytul="Mapa sali jest chwilowo niedostępna"
          akcje={
            <LinkPrzycisk href={`/seans/${encodeURIComponent(eventId)}`} wariant="drugi">
              Spróbuj ponownie
            </LinkPrzycisk>
          }
        >
          Rezerwowanie jest wstrzymane do czasu, aż system sprzedaży odpowie. Spróbuj za chwilę.
        </Baner>
      ) : (
        <>
          <h1 className="tytul-strony">{stan.dane.event.movie}</h1>
          <p className="podtytul">
            <time dateTime={stan.dane.event.startsAt}>{formatujTermin(stan.dane.event.startsAt)}</time> ·{" "}
            {stan.dane.event.hall}
          </p>
          {stan.nieaktualne ? (
            <div className="banery">
              <Baner rodzaj="ostrzezenie" tytul="Pokazujemy stan sali sprzed chwili">
                Odświeżymy mapę, gdy system sprzedaży odpowie.
              </Baner>
            </div>
          ) : null}
          <Karta className="karta--sala" etykieta="Sala">
            <MapaSali
              eventId={stan.dane.event.id}
              rzedy={stan.dane.event.rowsCount}
              miejscaWRzedzie={stan.dane.event.seatsPerRow}
              poczatkoweZajete={stan.dane.takenSeats}
              swiezoZajety={swiezoZajety}
              wyrenderowano={zegarSystemowy.teraz()}
            />
          </Karta>
        </>
      )}
    </>
  );
}
