// B. Formularz rezerwacji dla wybranego fotela.

import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { FormularzRezerwacji } from "@/components/rezerwacja/FormularzRezerwacji";
import { Baner } from "@/components/ui/Baner";
import { IkonaWstecz } from "@/components/ui/Ikony";
import { Karta } from "@/components/ui/Karta";
import { LinkPrzycisk } from "@/components/ui/Przycisk";
import { Kroki } from "@/components/uklad/Kroki";
import { opisMiejsca, parsujMiejsce } from "@/lib/domain/uklad-sali";
import { formatujDatePelna, formatujGodzine } from "@/lib/format";
import { adresKanaluNaZywo } from "@/lib/push/tryb-dev";
import { wczytajSeans } from "@/lib/strony";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Rezerwacja fotela" };

interface Props {
  params: Promise<{ eventId: string; seatId: string }>;
}

export default async function StronaFormularza({ params }: Props) {
  const { eventId, seatId } = await params;
  const stan = await wczytajSeans(eventId);
  if (stan.rodzaj === "brak") notFound();

  const adresMapy = `/seans/${encodeURIComponent(eventId)}`;

  if (stan.rodzaj === "niedostepne") {
    return (
      <>
        <Kroki aktywny={3} />
        <Baner
          rodzaj="blad"
          tytul="Rezerwacje są chwilowo niedostępne"
          akcje={
            <LinkPrzycisk href={`${adresMapy}/miejsce/${encodeURIComponent(seatId)}`} wariant="drugi">
              Spróbuj ponownie
            </LinkPrzycisk>
          }
        >
          System sprzedaży nie odpowiada. Twój wybór niczego jeszcze nie zarezerwował, więc nic nie tracisz.
        </Baner>
      </>
    );
  }

  const { event, takenSeats } = stan.dane;
  if (!parsujMiejsce(seatId, { rzedy: event.rowsCount, miejscaWRzedzie: event.seatsPerRow })) notFound();
  // Mapa mogła być nieaktualna: od razu wracamy z informacją, że fotel jest zajęty.
  if (takenSeats.includes(seatId)) redirect(`${adresMapy}?zajete=${seatId}`);

  return (
    <>
      <Kroki aktywny={3} />
      <Link href={adresMapy} className="powrot">
        <IkonaWstecz rozmiar={16} /> Mapa sali
      </Link>
      <Karta waska>
        <h1 className="karta__tytul">{opisMiejsca(seatId)}</h1>
        <p className="karta__opis">
          {event.movie} · {event.hall} ·{" "}
          <time dateTime={event.startsAt}>
            {formatujDatePelna(event.startsAt)}, {formatujGodzine(event.startsAt)}
          </time>
        </p>
        <div style={{ height: "var(--odstep-5)" }} />
        <FormularzRezerwacji eventId={event.id} seatId={seatId} adresKanalu={adresKanaluNaZywo(event.id)} />
      </Karta>
    </>
  );
}
