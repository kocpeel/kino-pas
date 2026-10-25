export function Legenda() {
  return (
    <ul className="legenda" id="legenda-sali" aria-label="Legenda">
      <li className="legenda__pozycja">
        <span className="fotel legenda__probka" aria-hidden="true" />
        wolny
      </li>
      <li className="legenda__pozycja">
        <span className="fotel fotel--zajety legenda__probka" aria-hidden="true" />
        zajęty
      </li>
      <li className="legenda__pozycja">
        <span className="fotel fotel--wybrany legenda__probka" aria-hidden="true" />
        wybrany
      </li>
    </ul>
  );
}
