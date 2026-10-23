// Jedyne źródło „teraz". Handler pobiera czas raz na żądanie i przekazuje go dalej
// jako liczbę, więc w testach wystarczy podmienić zegar, żeby „przewinąć" czas.

export interface Zegar {
  teraz(): number;
}

export const zegarSystemowy: Zegar = {
  teraz: () => Date.now(),
};

export interface ZegarTestowy extends Zegar {
  ustaw(ms: number): void;
  przewin(ms: number): void;
}

export function utworzZegarTestowy(startMs = Date.UTC(2026, 10, 6, 12, 0, 0)): ZegarTestowy {
  let biezacy = startMs;
  return {
    teraz: () => biezacy,
    ustaw: (ms) => {
      biezacy = ms;
    },
    przewin: (ms) => {
      biezacy += ms;
    },
  };
}
