interface PropsSzkieletu {
  szerokosc?: string;
  wysokosc?: string;
  className?: string;
}

/** Zastępnik o docelowych wymiarach: treść nie „skacze" po załadowaniu. */
export function Szkielet({ szerokosc = "100%", wysokosc = "1rem", className }: PropsSzkieletu) {
  return (
    <span
      className={["szkielet", className ?? ""].filter(Boolean).join(" ")}
      style={{ width: szerokosc, height: wysokosc }}
      aria-hidden="true"
    />
  );
}
