import type { ReactNode } from "react";

interface PropsKarty {
  children: ReactNode;
  waska?: boolean;
  className?: string;
  /** Nadaje karcie rolę regionu z nazwą (dla czytników ekranu). */
  etykieta?: string;
}

export function Karta({ children, waska, className, etykieta }: PropsKarty) {
  const klasy = ["karta", waska ? "karta--waska" : "", className ?? ""].filter(Boolean).join(" ");
  return etykieta ? (
    <section className={klasy} aria-label={etykieta}>
      {children}
    </section>
  ) : (
    <div className={klasy}>{children}</div>
  );
}
