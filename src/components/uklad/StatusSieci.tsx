"use client";

// Baner „offline". Słucha zdarzeń online/offline i sprząta nasłuchy.

import { useEffect, useState } from "react";
import { Baner } from "@/components/ui/Baner";

export function StatusSieci() {
  const [offline, ustawOffline] = useState(false);

  useEffect(() => {
    const aktualizuj = () => ustawOffline(!navigator.onLine);
    aktualizuj();
    window.addEventListener("online", aktualizuj);
    window.addEventListener("offline", aktualizuj);
    return () => {
      window.removeEventListener("online", aktualizuj);
      window.removeEventListener("offline", aktualizuj);
    };
  }, []);

  if (!offline) return null;
  return (
    <Baner rodzaj="ostrzezenie" tytul="Jesteś offline">
      Sprawdź połączenie z internetem. Rezerwacja i zakup wymagają połączenia z serwerem.
    </Baner>
  );
}
