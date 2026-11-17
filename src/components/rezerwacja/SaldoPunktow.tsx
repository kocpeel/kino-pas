"use client";

// Karta A etapu III w formularzu rezerwacji: po wpisaniu e-maila klient widzi saldo swoich punktów.
// Pytamy dopiero o poprawny adres i z opóźnieniem, nie przy każdym klawiszu: budżet wywołań Voucherify jest mały.

import { useEffect, useState } from "react";
import { normalizujEmail } from "@/lib/domain/dane-klienta";
import { formatujCene } from "@/lib/format";
import { czyPrzerwane, pobierzSaldo } from "@/lib/klient/api";

const OPOZNIENIE_MS = 600;

type Saldo = { email: string; punkty: number } | { email: string; blad: true };

export function SaldoPunktow({ email }: { email: string }) {
  const adres = normalizujEmail(email);
  const [saldo, ustawSaldo] = useState<Saldo | null>(null);

  useEffect(() => {
    if (!adres) return;
    const kontroler = new AbortController();
    const timer = setTimeout(() => {
      pobierzSaldo(adres, { sygnal: kontroler.signal, proby: 1 })
        .then((odpowiedz) => ustawSaldo({ email: adres, punkty: odpowiedz.points }))
        .catch((blad: unknown) => {
          if (!czyPrzerwane(blad)) ustawSaldo({ email: adres, blad: true });
        });
    }, OPOZNIENIE_MS);
    return () => {
      clearTimeout(timer);
      kontroler.abort();
    };
  }, [adres]);

  // Saldo innego adresu (klient dalej pisze) nie jest już prawdą.
  if (!adres || saldo?.email !== adres) return null;
  return (
    <p className="punkty-saldo" aria-live="polite">
      {"blad" in saldo ? (
        "Nie udało się teraz sprawdzić Twoich punktów. Możesz rezerwować dalej."
      ) : (
        <>
          Masz <strong className="cyfry">{saldo.punkty} pkt</strong> ({formatujCene(saldo.punkty)}). Punktami zapłacisz do
          połowy ceny biletu.
        </>
      )}
    </p>
  );
}
