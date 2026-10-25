// Licznik + „Kupuję bilet". Kontrakt nie ma GET rezerwacji, więc seans i fotel przychodzą
// w adresie, a czas ważności z sessionStorage. Ostatnie słowo i tak ma serwer przy zakupie.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Licznik, type OpisSeansu } from "@/components/rezerwacja/Licznik";
import { Karta } from "@/components/ui/Karta";
import { Kroki } from "@/components/uklad/Kroki";
import { czyPoprawneIdRezerwacji, czyPoprawneIdSeansu } from "@/lib/domain/dane-klienta";
import { czyPoprawneMiejsce } from "@/lib/domain/uklad-sali";
import { formatujTermin } from "@/lib/format";
import { parametr, wczytajSeans } from "@/lib/strony";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Twoja rezerwacja" };

interface Props {
  params: Promise<{ reservationId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function StronaRezerwacji({ params, searchParams }: Props) {
  const { reservationId } = await params;
  if (!czyPoprawneIdRezerwacji(reservationId)) notFound();
  const zapytanie = await searchParams;
  const eventIdZAdresu = parametr(zapytanie.seans);
  const seatIdZAdresu = parametr(zapytanie.miejsce);
  const eventId = czyPoprawneIdSeansu(eventIdZAdresu) ? eventIdZAdresu : null;
  const seatId = czyPoprawneMiejsce(seatIdZAdresu) ? seatIdZAdresu : null;

  let seans: OpisSeansu | null = null;
  if (eventId) {
    const stan = await wczytajSeans(eventId);
    if (stan.rodzaj === "ok") {
      const { event } = stan.dane;
      seans = { movie: event.movie, hall: event.hall, termin: formatujTermin(event.startsAt) };
    }
  }

  return (
    <>
      <Kroki aktywny={3} />
      <Karta waska>
        <Licznik reservationId={reservationId} eventId={eventId} seatId={seatId} seans={seans} />
      </Karta>
    </>
  );
}
