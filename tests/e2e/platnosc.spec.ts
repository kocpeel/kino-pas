// Etap II w przeglądarce, ze sztucznym Stripe'em (tests/e2e/sztuczny-stripe.mjs): Zapłać → strona płatności →
// powrót. Prawdziwy Stripe z kartami testowymi sprawdziłem osobno, ręcznie na localhost (docs/decyzje.md).

import { expect, test, type Page } from "@playwright/test";
import { fotel, przejdzDoStripe, seanse, stanStripe, wolnyFotel, wypelnijIRezerwuj, zaplacNaStripe } from "./pomocnicze";

async function zarezerwujPrzezFormularz(page: Page, eventId: string, seatId: string) {
  await page.goto(`/seans/${eventId}/miejsce/${seatId}`);
  await wypelnijIRezerwuj(page);
  await expect(page.getByRole("timer")).toBeVisible();
}

function idRezerwacji(page: Page): string {
  return /\/(?:rezerwacja|bilet)\/([0-9a-f-]{36})/.exec(page.url())?.[1] as string;
}

test("cena jest przy wydarzeniu, na mapie, w formularzu i na przycisku płatności", async ({ page, request }) => {
  const [seans] = await seanse(request);
  const seatId = await wolnyFotel(request, seans!.id);
  await page.goto("/");
  await expect(page.locator(".seans", { hasText: seans!.movie }).getByText("32 zł")).toBeVisible();
  await page.goto(`/seans/${seans!.id}`);
  await expect(page.getByText("32 zł")).toBeVisible();
  await page.goto(`/seans/${seans!.id}/miejsce/${seatId}`);
  await expect(page.getByText("32 zł")).toBeVisible();
  await wypelnijIRezerwuj(page);
  await expect(page.getByRole("button", { name: "Zapłać 32 zł" })).toBeVisible();
});

test("przerwana płatność: wraca do sklepu i może spróbować jeszcze raz, tą samą sesją", async ({ page, request }) => {
  const [seans] = await seanse(request);
  await zarezerwujPrzezFormularz(page, seans!.id, await wolnyFotel(request, seans!.id));

  await przejdzDoStripe(page);
  const adresSesji = page.url();
  await page.getByRole("link", { name: "Przerwij" }).click();

  await expect(page).toHaveURL(/\/rezerwacja\/.*platnosc=przerwana/);
  await expect(page.getByText("Płatność przerwana")).toBeVisible();
  await expect(page.getByRole("timer")).toBeVisible();

  await przejdzDoStripe(page);
  expect(page.url()).toBe(adresSesji);
  await page.getByRole("link", { name: "Zapłać kartą" }).click();
  await expect(page.locator(".bilet__kod")).toHaveText(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
});

test("webhook się spóźnia: „płatność w toku…” sama zamienia się w bilet", async ({ page, request }) => {
  const [seans] = await seanse(request);
  await zarezerwujPrzezFormularz(page, seans!.id, await wolnyFotel(request, seans!.id));

  await zaplacNaStripe(page, "?webhook=opozniony&ms=1500");
  await expect(page).toHaveURL(/\/bilet\//);
  await expect(page.getByText("Płatność w toku…")).toBeVisible();
  await expect(page.getByRole("button", { name: "Kopiuj kod" })).toBeDisabled();

  await expect(page.locator(".bilet__kod")).toHaveText(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  await expect(page.getByText("Płatność w toku…")).toHaveCount(0);
  await expect(page.getByText(/Zapłacono 32 zł/)).toBeVisible();
});

test("Stripe powtarza webhook: jeden bilet i ten sam kod", async ({ page, request }) => {
  const [seans] = await seanse(request);
  await zarezerwujPrzezFormularz(page, seans!.id, await wolnyFotel(request, seans!.id));
  await zaplacNaStripe(page, "?webhook=podwojny");
  const kod = page.locator(".bilet__kod");
  await expect(kod).toHaveText(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  const id = idRezerwacji(page);
  const stan = await (await request.get(`/api/reservations/${id}`)).json();
  expect(stan).toMatchObject({ status: "paid", amount: 3200, code: await kod.textContent() });
  const { webhooki } = await stanStripe(request);
  expect(webhooki.slice(-2).map((w) => w.status)).toEqual([200, 200]);
});

test("płatność po wygaśnięciu rezerwacji: bez biletu, z informacją o zwrocie, a fotel wrócił do puli", async ({ page, request }) => {
  const seans = (await seanse(request)).at(-1);
  const seatId = await wolnyFotel(request, seans!.id);
  await zarezerwujPrzezFormularz(page, seans!.id, seatId);
  const id = idRezerwacji(page);
  const { expiresAt } = (await (await request.get(`/api/reservations/${id}`)).json()) as { expiresAt: number };

  // Sesja Stripe'a żyje co najmniej 30 minut, więc strona płatności wciąż działa, gdy rezerwacji już nie ma.
  await przejdzDoStripe(page);
  await page.waitForTimeout(Math.max(0, expiresAt - Date.now()) + 1500);
  await page.getByRole("link", { name: "Zapłać kartą" }).click();

  await expect(page.getByRole("heading", { name: "Ta rezerwacja wygasła" })).toBeVisible();
  await expect(page.getByText(/Pieniądze wracają na Twoją kartę/)).toBeVisible();
  await expect(page.locator(".bilet__kod")).toHaveCount(0);
  expect(await (await request.get(`/api/reservations/${id}`)).json()).toMatchObject({ status: "expired", refund: "pending" });

  await page.goto(`/seans/${seans!.id}`);
  await expect(fotel(page, seatId)).not.toHaveClass(/fotel--zajety/);
});

test("kontrakt przez API: checkout 2× ta sama sesja, po czasie 410, błędny identyfikator 400", async ({ request }) => {
  const [seans] = await seanse(request);
  const seatId = await wolnyFotel(request, seans!.id);
  const rezerwacja = await request.post("/api/reservations", {
    data: { eventId: seans!.id, seatId, name: "API", email: `api-${Date.now()}@example.com` },
  });
  expect(rezerwacja.status()).toBe(201);
  const { reservationId, expiresAt, amount } = (await rezerwacja.json()) as { reservationId: string; expiresAt: number; amount: number };
  expect(amount).toBe(3200);

  const [a, b] = await Promise.all([
    request.post(`/api/reservations/${reservationId}/checkout`),
    request.post(`/api/reservations/${reservationId}/checkout`),
  ]);
  expect([a.status(), b.status()]).toEqual([200, 200]);
  expect((await a.json()).url).toBe((await b.json()).url);

  expect((await request.get(`/api/reservations/${reservationId}`)).status()).toBe(200);
  expect((await request.post("/api/reservations/abc/checkout")).status()).toBe(400);
  expect((await request.post("/api/webhooks/stripe", { data: {} })).status()).toBe(400);

  await new Promise((r) => setTimeout(r, Math.max(0, expiresAt - Date.now()) + 200));
  expect((await request.post(`/api/reservations/${reservationId}/checkout`)).status()).toBe(410);
  expect(await (await request.get(`/api/reservations/${reservationId}`)).json()).toMatchObject({ status: "expired", amount: 3200 });
});
