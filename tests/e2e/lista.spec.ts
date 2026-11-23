// Etap IV w przeglądarce: wyprzedane wydarzenie waitlist-test (dwa miejsca), „Powiadom mnie”, miejsce w kolejce,
// po wygaśnięciu rezerwacji oferta z linkiem do zapłaty, zapłata punktami, a potem bilet i status done. W e2e nie ma Resend
// ani Crona: kolejkę przesuwa odpytywanie panelu (leniwie), a mail czeka w outboksie.

import { expect, test } from "@playwright/test";
import { unikalnyEmail, zaplacNaStripe } from "./pomocnicze";

const EV = "waitlist-test";

test("lista oczekujących: zapis, kolejka, oferta po wygaśnięciu rezerwacji i zakup z listy", async ({ page, request }) => {
  test.setTimeout(90_000);
  // Oba miejsca zajmują rezerwacje innych klientów (TTL w e2e: 8 s), więc wydarzenie jest wyprzedane.
  for (const seatId of ["A1", "A2"]) {
    const odp = await request.post("/api/reservations", {
      data: { eventId: EV, seatId, customerName: "Inny Klient", email: unikalnyEmail() },
    });
    expect(odp.status()).toBe(201);
  }
  expect((await (await request.get(`/api/events/${EV}`)).json()).soldOut).toBe(true);

  await page.goto(`/seans/${EV}`);
  await expect(page.getByRole("heading", { name: "Wyprzedane" })).toBeVisible();
  await page.getByLabel("Imię").fill("Lista E2E");
  await page.getByLabel("E-mail").fill(unikalnyEmail());
  await page.getByRole("button", { name: "Powiadom mnie" }).click();
  await expect(page.getByText("Jesteś na liście oczekujących")).toBeVisible();
  await expect(page.getByRole("button", { name: "Wypisz mnie" })).toBeVisible();
  const waitlistId = await page.evaluate(() => localStorage.getItem("lista:waitlist-test"));
  expect(await (await request.get(`/api/waitlist/${waitlistId}`)).json()).toEqual({ status: "waiting", position: 1 });

  // Rezerwacje wygasają: miejsce dostaje pierwsza osoba z kolejki, a panel sam to pokazuje.
  await expect(page.getByText("Zwolniło się miejsce dla Ciebie")).toBeVisible({ timeout: 25_000 });
  await page.getByRole("link", { name: "Zapłać za miejsce" }).click();
  await expect(page.getByRole("timer")).toBeVisible();
  // Miejsce z listy to zwykła rezerwacja, więc płaci się też punktami (strona zna e-mail z „Powiadom mnie”).
  await expect(page.getByText(/Możesz wydać najwięcej 1000 pkt/)).toBeVisible();
  await page.getByRole("button", { name: "Najwięcej" }).click();
  await expect(page.getByRole("button", { name: "Zapłać 22 zł" })).toBeVisible();
  await zaplacNaStripe(page);
  await expect(page.locator(".bilet__kod")).toHaveText(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  await expect(page.locator(".podsumowanie-zakupu")).toContainText("1000 pkt (10 zł)");
  expect((await (await request.get(`/api/waitlist/${waitlistId}`)).json()).status).toBe("done");
});

test("lista oczekujących przez API: odmowy z kontraktu", async ({ request }) => {
  const nie = await request.post("/api/events/metropolis-2026-11-06/waitlist", {
    data: { email: unikalnyEmail(), customerName: "Lista API" },
  });
  expect(nie.status()).toBe(409);
  expect((await nie.json()).error).toBe("not_sold_out");
  expect((await request.post("/api/events/nie-ma-takiego/waitlist", { data: { email: unikalnyEmail(), customerName: "X Y" } })).status()).toBe(404);
  expect((await request.get("/api/waitlist/abc")).status()).toBe(400);
  expect((await request.delete("/api/waitlist/00000000-0000-4000-8000-000000000000")).status()).toBe(404);
});
