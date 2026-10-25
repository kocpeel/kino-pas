// Nieistniejący fotel → prawdziwy kod 404 (sprawdzenie przed strumieniowaniem, bez zapytania do bazy).

import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { parsujMiejsce } from "@/lib/domain/uklad-sali";
import { seansZListy } from "@/lib/strony";

interface Props {
  children: ReactNode;
  params: Promise<{ eventId: string; seatId: string }>;
}

export default async function UkladMiejsca({ children, params }: Props) {
  const { eventId, seatId } = await params;
  const seans = await seansZListy(eventId);
  const uklad = seans ? { rzedy: seans.rowsCount, miejscaWRzedzie: seans.seatsPerRow } : undefined;
  if (!parsujMiejsce(seatId, uklad)) notFound();
  return children;
}
