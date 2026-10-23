"use client";

// Granica błędu: komunikat po ludzku i ponowienie (retry ponownie pobiera dane segmentu).

import { useEffect } from "react";
import { LinkPrzycisk, Przycisk } from "@/components/ui/Przycisk";

export default function GranicaBledu({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="komunikat-strony" role="alert">
      <h1 className="tytul-strony">Coś poszło nie tak</h1>
      <p className="podtytul">Nie udało się wyświetlić tej strony. Spróbuj ponownie za chwilę.</p>
      <div className="przyciski">
        <Przycisk onClick={() => retry()}>Spróbuj ponownie</Przycisk>
        <LinkPrzycisk href="/" wariant="drugi">
          Wróć do repertuaru
        </LinkPrzycisk>
      </div>
    </div>
  );
}
