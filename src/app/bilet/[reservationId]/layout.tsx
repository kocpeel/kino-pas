// Niepoprawny identyfikator rezerwacji → prawdziwy kod 404 (sprawdzenie przed strumieniowaniem).

import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { czyPoprawneIdRezerwacji } from "@/lib/domain/dane-klienta";

interface Props {
  children: ReactNode;
  params: Promise<{ reservationId: string }>;
}

export default async function UkladBiletu({ children, params }: Props) {
  const { reservationId } = await params;
  if (!czyPoprawneIdRezerwacji(reservationId)) notFound();
  return children;
}
