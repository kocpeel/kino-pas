import type { InputHTMLAttributes, Ref } from "react";

interface PropsPola extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  id: string;
  etykieta: string;
  podpowiedz?: string;
  blad?: string | undefined;
  ref?: Ref<HTMLInputElement>;
}

/** Pole z etykietą, podpowiedzią i błędem powiązanymi przez aria-describedby. */
export function Pole({ id, etykieta, podpowiedz, blad, ref, ...wejscie }: PropsPola) {
  const opisy = [podpowiedz ? `${id}-podpowiedz` : "", blad ? `${id}-blad` : ""].filter(Boolean).join(" ");
  return (
    <div className="pole">
      <label className="pole__etykieta" htmlFor={id}>
        {etykieta}
      </label>
      <input
        {...wejscie}
        ref={ref}
        id={id}
        className="pole__wejscie"
        aria-invalid={blad ? true : undefined}
        aria-describedby={opisy || undefined}
      />
      {podpowiedz ? (
        <p id={`${id}-podpowiedz`} className="pole__podpowiedz">
          {podpowiedz}
        </p>
      ) : null}
      {blad ? (
        <p id={`${id}-blad`} className="pole__blad">
          {blad}
        </p>
      ) : null}
    </div>
  );
}
