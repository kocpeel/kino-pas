import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Wariant = "glowny" | "drugi";

function klasy(wariant: Wariant, szeroki?: boolean, dodatkowe?: string): string {
  return ["przycisk", `przycisk--${wariant}`, szeroki ? "przycisk--szeroki" : "", dodatkowe ?? ""]
    .filter(Boolean)
    .join(" ");
}

interface PropsPrzycisku extends ButtonHTMLAttributes<HTMLButtonElement> {
  wariant?: Wariant;
  szeroki?: boolean;
  /** Blokuje przycisk i pokazuje spinner (ochrona przed podwójnym kliknięciem). */
  laduje?: boolean;
}

export function Przycisk({
  wariant = "glowny",
  szeroki,
  laduje,
  disabled,
  className,
  children,
  ...reszta
}: PropsPrzycisku) {
  return (
    <button
      type="button"
      {...reszta}
      className={klasy(wariant, szeroki, className)}
      disabled={disabled || laduje}
      aria-busy={laduje || undefined}
    >
      {laduje ? <span className="spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

interface PropsLinku {
  href: string;
  wariant?: Wariant;
  szeroki?: boolean;
  children: ReactNode;
  className?: string;
}

export function LinkPrzycisk({ href, wariant = "glowny", szeroki, children, className }: PropsLinku) {
  return (
    <Link href={href} className={klasy(wariant, szeroki, className)}>
      {children}
    </Link>
  );
}
