const KROKI = ["Seans", "Fotel", "Rezerwacja", "Bilet"] as const;

/** Pasek postępu „Seans → Fotel → Rezerwacja → Bilet". `aktywny` liczony od 1. */
export function Kroki({ aktywny }: { aktywny: 1 | 2 | 3 | 4 }) {
  return (
    <nav aria-label="Postęp zakupu">
      <ol className="kroki">
        {KROKI.map((nazwa, i) => {
          const numer = i + 1;
          const klasa = numer < aktywny ? "kroki__krok kroki__krok--zrobiony" : "kroki__krok";
          return (
            <li key={nazwa} className={klasa} aria-current={numer === aktywny ? "step" : undefined}>
              <span className="kroki__nazwa">{nazwa}</span>
              {numer < aktywny ? <span className="sr-only"> (zrobione)</span> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
