// C. Bilet. Dane seansu renderuje serwer, kod dostarcza klient (sessionStorage albo
// idempotentny POST zakupu, który zwraca zapisany kod).

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AkcjeBiletu } from "@/components/bilet/AkcjeBiletu";
import type { DaneBiletu } from "@/components/bilet/Bilet";
import { Kroki } from "@/components/uklad/Kroki";
import { czyPoprawneIdRezerwacji, czyPoprawneIdSeansu } from "@/lib/domain/dane-klienta";
import { parsujMiejsce } from "@/lib/domain/uklad-sali";
import { formatujTermin } from "@/lib/format";
import { parametr, wczytajSeans } from "@/lib/strony";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Bilet" };

interface Props {
  params: Promise<{ reservationId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function StronaBiletu({ params, searchParams }: Props) {
  const { reservationId } = await params;
  if (!czyPoprawneIdRezerwacji(reservationId)) notFound();
  const zapytanie = await searchParams;
  const eventId = parametr(zapytanie.seans);
  const miejsce = parsujMiejsce(parametr(zapytanie.miejsce));

  const dane: DaneBiletu = {
    movie: null,
    hall: null,
    termin: null,
    rzad: miejsce?.rzad ?? null,
    numer: miejsce?.numer ?? null,
  };
  if (czyPoprawneIdSeansu(eventId)) {
    const stan = await wczytajSeans(eventId);
    if (stan.rodzaj === "ok") {
      dane.movie = stan.dane.event.movie;
      dane.hall = stan.dane.event.hall;
      dane.termin = formatujTermin(stan.dane.event.startsAt);
    }
  }

  return (
    <>
      <Kroki aktywny={4} />
      <AkcjeBiletu reservationId={reservationId} dane={dane} />
    </>
  );
}
