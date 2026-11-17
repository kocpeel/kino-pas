"use client";

// Karta B etapu III: pole „Użyj punktów” w koszyku. Podpowiada, ile najwięcej (połowa ceny, ale nie więcej,
// niż klient ma), a cena i przycisk w Liczniku zmieniają się od razu. Ostatnie słowo ma serwer (Voucherify).

import { useEffect, useState } from "react";
import { Przycisk } from "@/components/ui/Przycisk";
import { maksPunktow } from "@/lib/domain/punkty";
import { formatujCene } from "@/lib/format";
import { czyPrzerwane, pobierzSaldo } from "@/lib/klient/api";

interface Props {
  /** E-mail z tej karty przeglądarki; bez niego nie wiemy, czyje to punkty. */
  email: string | null;
  amount: number;
  punkty: number;
  onZmiana: (punkty: number) => void;
  /** Punkty ustalone przy pierwszej płatności (z serwera): pole już ich nie zmienia. */
  ustalone: number;
  wylaczone: boolean;
  /** Zmienia się po odmowie serwera (np. za mało punktów): wtedy saldo czytamy jeszcze raz. */
  odswiezenie?: number;
}

export function PolePunktow({ email, amount, punkty, onZmiana, ustalone, wylaczone, odswiezenie = 0 }: Props) {
  const [saldo, ustawSaldo] = useState<{ wersja: string; punkty: number | null } | null>(null);
  const wersja = `${email}|${odswiezenie}`;

  useEffect(() => {
    if (!email || ustalone > 0) return;
    const kontroler = new AbortController();
    pobierzSaldo(email, { sygnal: kontroler.signal })
      .then((odpowiedz) => ustawSaldo({ wersja: `${email}|${odswiezenie}`, punkty: odpowiedz.points }))
      .catch((blad: unknown) => {
        if (!czyPrzerwane(blad)) ustawSaldo({ wersja: `${email}|${odswiezenie}`, punkty: null });
      });
    return () => kontroler.abort();
  }, [email, ustalone, odswiezenie]);

  if (ustalone > 0) {
    return (
      <p className="punkty-saldo">
        Płacisz punktami: <strong className="cyfry">{ustalone} pkt</strong> ({formatujCene(ustalone)}). Tej liczby nie da się już
        zmienić w tej płatności.
      </p>
    );
  }
  if (!email) return null;

  const znane = saldo?.wersja === wersja ? saldo : null;
  const maks = Math.min(znane?.punkty ?? 0, maksPunktow(amount));
  const podpowiedz =
    znane === null
      ? "Sprawdzamy Twoje punkty…"
      : znane.punkty === null
        ? "Nie udało się sprawdzić punktów. Możesz zapłacić bez nich."
        : `Masz ${znane.punkty} pkt. Możesz wydać najwięcej ${maks} pkt (${formatujCene(maks)}): do połowy ceny, nie więcej, niż masz.`;

  return (
    <div className="punkty">
      <label htmlFor="punkty" className="pole__etykieta">
        Użyj punktów
      </label>
      <div className="punkty__wiersz">
        <input
          id="punkty"
          className="pole__wejscie punkty__wejscie"
          type="number"
          inputMode="numeric"
          min={0}
          max={maks}
          step={1}
          value={punkty}
          disabled={wylaczone || maks === 0}
          aria-describedby="punkty-podpowiedz"
          onChange={(e) => {
            const wartosc = Math.trunc(Number(e.target.value));
            onZmiana(Number.isFinite(wartosc) ? Math.min(maks, Math.max(0, wartosc)) : 0);
          }}
        />
        <Przycisk wariant="drugi" disabled={wylaczone || maks === 0} onClick={() => onZmiana(maks)}>
          Najwięcej
        </Przycisk>
      </div>
      <p id="punkty-podpowiedz" className="pole__podpowiedz">
        {podpowiedz}
      </p>
    </div>
  );
}
