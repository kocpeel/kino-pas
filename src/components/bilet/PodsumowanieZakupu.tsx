// Karta C etapu III: podsumowanie zakupu na stronie biletu, to samo co w mailu: ile kartą, ile punktami
// i ile punktów klient zebrał. Kroki sagi po bilecie (naliczenie punktów, mail) trwają chwilę, więc stan
// pośredni nazywamy wprost zamiast udawać, że wszystko stało się od razu (E08).

import type { StanRezerwacji } from "@/lib/domain/typy";
import { formatujCene } from "@/lib/format";

function opisNaliczenia(status: StanRezerwacji["pointsStatus"]): string | null {
  if (status === "pending") return "dopisujemy je do Twojego konta…";
  if (status === "failed") return "nie udało się ich dopisać, zajmie się tym obsługa";
  return null;
}

export function opisMaila(status: StanRezerwacji["emailStatus"]): string | null {
  switch (status) {
    case "pending":
      return "Wysyłamy bilet na Twój e-mail…";
    case "sent":
      return "Bilet wysłaliśmy na Twój e-mail.";
    case "delivered":
      return "Mail z biletem doszedł do Twojej skrzynki.";
    case "bounced":
      return "Mail z biletem nie doszedł: skrzynka odrzuciła wiadomość. Bilet masz tutaj.";
    case "failed":
      return "Nie udało się wysłać maila z biletem. Bilet masz tutaj.";
    default:
      return null;
  }
}

export function PodsumowanieZakupu({ stan }: { stan: StanRezerwacji }) {
  const naliczenie = opisNaliczenia(stan.pointsStatus);
  const mail = opisMaila(stan.emailStatus);
  return (
    <section className="podsumowanie-zakupu" aria-label="Podsumowanie zakupu">
      <dl className="podsumowanie">
        <dt>Zapłacono kartą</dt>
        <dd>{formatujCene(stan.amount - stan.pointsUsed)}</dd>
        <dt>Zapłacono punktami</dt>
        <dd>{stan.pointsUsed > 0 ? `${stan.pointsUsed} pkt (${formatujCene(stan.pointsUsed)})` : "nie użyto"}</dd>
        {stan.pointsEarned !== undefined ? (
          <>
            <dt>Zebrane punkty</dt>
            <dd>
              +{stan.pointsEarned} pkt
              {naliczenie ? <span className="podsumowanie-zakupu__stan">: {naliczenie}</span> : null}
            </dd>
          </>
        ) : null}
      </dl>
      {mail ? (
        <p className="notka" aria-live="polite">
          {mail}
        </p>
      ) : null}
    </section>
  );
}
