// Sprawdzenie istnienia seansu PRZED strumieniowaniem (loading.tsx niżej w drzewie), dzięki czemu
// nieznany seans dostaje prawdziwy kod HTTP 404, a nie 200 z komunikatem. Bez zapytania do bazy:
// lista seansów jest w cache. Gdy baza nie odpowiada, decyzję zostawiamy stronie (baner awarii).

import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { czyPoprawneIdSeansu } from "@/lib/domain/dane-klienta";
import { seansZListy } from "@/lib/strony";

interface Props {
  children: ReactNode;
  params: Promise<{ eventId: string }>;
}

export default async function UkladSeansu({ children, params }: Props) {
  const { eventId } = await params;
  if (!czyPoprawneIdSeansu(eventId) || (await seansZListy(eventId)) === null) notFound();
  return children;
}
