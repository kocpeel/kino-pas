// Pełne przejście na stronę płatności Stripe'a. Osobny moduł, bo w testach komponentów (jsdom)
// `window.location` nie da się podmienić, a ten moduł tak.

export function przejdzDoPlatnosci(url: string): void {
  window.location.assign(url);
}
