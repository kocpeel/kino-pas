import type { ReactNode } from "react";
import { IkonaBlad, IkonaInfo, IkonaOstrzezenie, IkonaSukces } from "./Ikony";

type Rodzaj = "info" | "ostrzezenie" | "blad" | "sukces";

const IKONY = { info: IkonaInfo, ostrzezenie: IkonaOstrzezenie, blad: IkonaBlad, sukces: IkonaSukces };

interface PropsBanera {
  rodzaj?: Rodzaj;
  tytul: string;
  children?: ReactNode;
  akcje?: ReactNode;
  /** "alert" dla błędów, które trzeba ogłosić od razu; domyślnie "status". */
  rola?: "status" | "alert";
}

export function Baner({ rodzaj = "info", tytul, children, akcje, rola = "status" }: PropsBanera) {
  const Ikona = IKONY[rodzaj];
  return (
    <div className={`baner baner--${rodzaj}`} role={rola}>
      <Ikona className="baner__ikona" />
      <div className="baner__tresc">
        <p className="baner__tytul">{tytul}</p>
        {children ? <div>{children}</div> : null}
        {akcje ? <div className="baner__akcje przyciski">{akcje}</div> : null}
      </div>
    </div>
  );
}
