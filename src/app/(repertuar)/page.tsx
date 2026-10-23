// A1. Repertuar. Komponent serwerowy: dane z tego samego odczytu co GET /api/events
// (cache + fallback), więc przy awarii bazy pokazuje ostatnie znane dane.

import { KartaSeansu } from "@/components/repertuar/KartaSeansu";
import { Baner } from "@/components/ui/Baner";
import { LinkPrzycisk } from "@/components/ui/Przycisk";
import { OdswiezanieRepertuaru } from "@/components/repertuar/OdswiezanieRepertuaru";
import { Kroki } from "@/components/uklad/Kroki";
import { zegarSystemowy } from "@/lib/czas";
import { zaleznosciZadania } from "@/lib/db/kontekst";
import type { SeansNaLiscie } from "@/lib/domain/typy";
import { pobierzRepertuar } from "@/lib/http/odczyty";

export const dynamic = "force-dynamic";

async function wczytaj(): Promise<{ seanse: SeansNaLiscie[]; nieaktualne: boolean } | null> {
  try {
    const wynik = await pobierzRepertuar(zaleznosciZadania());
    return { seanse: wynik.dane, nieaktualne: wynik.nieaktualne };
  } catch (blad) {
    console.error("Repertuar niedostępny:", blad);
    return null;
  }
}

export default async function StronaRepertuaru() {
  const wynik = await wczytaj();

  return (
    <>
      <OdswiezanieRepertuaru wyrenderowano={zegarSystemowy.teraz()} />
      <Kroki aktywny={1} />
      <h1 className="tytul-strony">Repertuar</h1>
      <p className="podtytul">Wybierz seans, a potem miejsce na mapie sali.</p>

      {wynik === null ? (
        <Baner
          rodzaj="blad"
          tytul="Repertuar jest chwilowo niedostępny"
          akcje={
            <LinkPrzycisk href="/" wariant="drugi">
              Spróbuj ponownie
            </LinkPrzycisk>
          }
        >
          Nie udało się połączyć z systemem sprzedaży. Spróbuj za chwilę.
        </Baner>
      ) : (
        <>
          {wynik.nieaktualne ? (
            <div className="banery">
              <Baner rodzaj="ostrzezenie" tytul="Pokazujemy dane sprzed chwili">
                System sprzedaży ma chwilowe problemy, więc rezerwowanie jest wstrzymane. Spróbuj ponownie za moment.
              </Baner>
            </div>
          ) : null}
          <ul className="repertuar">
            {wynik.seanse.map((seans) => (
              <li key={seans.id}>
                <KartaSeansu seans={seans} rezerwacjeWylaczone={wynik.nieaktualne} />
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
