import { expect, type APIRequestContext, type Page } from "@playwright/test";

export interface Seans {
  id: string;
  movie: string;
  hall: string;
}

export async function seanse(request: APIRequestContext): Promise<Seans[]> {
  return (await (await request.get("/api/events")).json()) as Seans[];
}

/** Losowy wolny fotel (testy nie zależą od stanu po poprzednich uruchomieniach). */
export async function wolnyFotel(request: APIRequestContext, eventId: string): Promise<string> {
  const { takenSeats } = (await (await request.get(`/api/events/${eventId}`)).json()) as { takenSeats: string[] };
  const zajete = new Set(takenSeats);
  const wolne = "ABCDEFGH".split("").flatMap((r) => Array.from({ length: 10 }, (_, i) => `${r}${i + 1}`)).filter((s) => !zajete.has(s));
  expect(wolne.length).toBeGreaterThan(0);
  return wolne[Math.floor(Math.random() * wolne.length)]!;
}

let licznik = 0;
export function unikalnyEmail(): string {
  return `e2e-${Date.now()}-${licznik++}@example.com`;
}

export async function wypelnijIRezerwuj(page: Page, imie = "Tester E2E", email = unikalnyEmail()): Promise<void> {
  await page.getByLabel("Imię").fill(imie);
  await page.getByLabel("E-mail").fill(email);
  await page.getByRole("button", { name: "Zarezerwuj fotel" }).click();
}

export const fotel = (page: Page, seatId: string) => page.locator(`[data-seat="${seatId}"]`);

const PORT_STRIPE = process.env.SZTUCZNY_STRIPE_PORT || "8792";

/** Klik „Zapłać” u nas i przejście na stronę sztucznego Stripe'a. */
export async function przejdzDoStripe(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Zapłać/ }).click();
  await page.waitForURL(/\/pay\//);
}

/** Cała płatność: strona Stripe'a, „Zapłać kartą” i powrót do sklepu. `tryb` steruje webhookiem. */
export async function zaplacNaStripe(page: Page, tryb = ""): Promise<void> {
  await przejdzDoStripe(page);
  await page.goto(`${page.url()}/oplac${tryb}`);
}

export async function stanStripe(
  request: APIRequestContext,
): Promise<{ webhooki: { id: string; status: number }[]; zwroty: unknown[] }> {
  return (await request.get(`http://localhost:${PORT_STRIPE}/__stan`)).json();
}
