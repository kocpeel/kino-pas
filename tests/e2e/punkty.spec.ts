// Etap III w przeglądarce: saldo po wpisaniu e-maila (karta A), „Użyj punktów” i „Zapłać 22 zł” (karta B),
// podsumowanie na stronie biletu (karta C). Sztuczny Voucherify i sztuczny Stripe, prawdziwe podpisy webhooków.
// Kroki po bilecie (naliczenie, mail) robi Cron, którego w e2e nie ma: strona pokazuje je jako trwające.

import { expect, test } from "@playwright/test";
import { seanse, stanStripe, unikalnyEmail, wolnyFotel } from "./pomocnicze";

const PORT_VOUCHERIFY = process.env.SZTUCZNY_VOUCHERIFY_PORT || "8793";

test("nowy klient płaci 1000 punktami: sesja na 22 zł, a bilet pokazuje podsumowanie", async ({ page, request }) => {
  const [seans] = await seanse(request);
  const seatId = await wolnyFotel(request, seans!.id);
  const email = unikalnyEmail();
  await page.goto(`/seans/${seans!.id}/miejsce/${seatId}`);
  await page.getByLabel("Imię").fill("Punkty E2E");
  await page.getByLabel("E-mail").fill(email);
  await expect(page.getByText(/Masz 1000 pkt/)).toBeVisible();
  await page.getByRole("button", { name: "Zarezerwuj fotel" }).click();
  await expect(page.getByRole("timer")).toBeVisible();

  await expect(page.getByText(/Możesz wydać najwięcej 1000 pkt/)).toBeVisible();
  await page.getByRole("button", { name: "Najwięcej" }).click();
  await expect(page.getByLabel("Użyj punktów")).toHaveValue("1000");
  await page.getByRole("button", { name: "Zapłać 22 zł" }).click();
  await page.waitForURL(/\/pay\//);
  await expect(page.getByText("22 pln")).toBeVisible();

  // Punkty zeszły w Voucherify, zanim powstała sesja.
  const { karty } = (await (await request.get(`http://localhost:${PORT_VOUCHERIFY}/__stan`)).json()) as {
    karty: { email: string; balance: number; operacje: { source_id: string; points: number }[] }[];
  };
  const karta = karty.find((k) => k.email === email);
  expect(karta?.balance).toBe(0);
  expect(karta?.operacje.map((o) => o.points)).toEqual([1000, -1000]);

  await page.goto(`${page.url()}/oplac`);
  await expect(page.locator(".bilet__kod")).toHaveText(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  const podsumowanie = page.locator(".podsumowanie-zakupu");
  await expect(podsumowanie).toContainText("22 zł");
  await expect(podsumowanie).toContainText("1000 pkt (10 zł)");
  await expect(podsumowanie).toContainText("+220 pkt");

  const { webhooki } = await stanStripe(request);
  expect(webhooki.at(-1)?.status).toBe(200);
  expect((await (await request.get(`/api/loyalty?email=${encodeURIComponent(email)}`)).json()).points).toBe(0);
});

test("API: za dużo punktów 400, a punkty ustala pierwszy checkout", async ({ request }) => {
  const [seans] = await seanse(request);
  const seatId = await wolnyFotel(request, seans!.id);
  const rezerwacja = await request.post("/api/reservations", {
    data: { eventId: seans!.id, seatId, name: "API Punkty", email: unikalnyEmail() },
  });
  const { reservationId } = (await rezerwacja.json()) as { reservationId: string };

  expect((await request.post(`/api/reservations/${reservationId}/checkout`, { data: { points: 1601 } })).status()).toBe(400);
  const pierwszy = await request.post(`/api/reservations/${reservationId}/checkout`, { data: { points: 500 } });
  expect(pierwszy.status()).toBe(200);
  const inny = await request.post(`/api/reservations/${reservationId}/checkout`, { data: { points: 600 } });
  expect(inny.status()).toBe(409);
  expect((await inny.json()).error).toBe("points_locked");
  const stan = await (await request.get(`/api/reservations/${reservationId}`)).json();
  expect(stan).toMatchObject({ status: "held", pointsUsed: 500 });
});
