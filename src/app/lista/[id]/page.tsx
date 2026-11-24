// Etap IV: stan zapisu na liście oczekujących pod stałym adresem (link „Wypisz mnie” z maila z ofertą).

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { StanZapisu } from "@/components/sala/ListaOczekujacych";
import { IkonaWstecz } from "@/components/ui/Ikony";
import { Karta } from "@/components/ui/Karta";
import { czyPoprawneIdRezerwacji } from "@/lib/domain/dane-klienta";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Lista oczekujących" };

interface Props {
  params: Promise<{ id: string }>;
}

export default async function StronaZapisuNaListe({ params }: Props) {
  const { id } = await params;
  if (!czyPoprawneIdRezerwacji(id)) notFound();
  return (
    <>
      <Link href="/" className="powrot">
        <IkonaWstecz rozmiar={16} /> Repertuar
      </Link>
      <h1 className="tytul-strony">Lista oczekujących</h1>
      <Karta waska>
        <StanZapisu eventId={null} waitlistId={id} />
      </Karta>
    </>
  );
}
