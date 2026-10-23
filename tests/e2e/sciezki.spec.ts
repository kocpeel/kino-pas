import { expect, test } from "@playwright/test";
import { fotel, seanse, unikalnyEmail, wolnyFotel, wypelnijIRezerwuj } from "./pomocnicze";

test("1. pełna ścieżka: seans → fotel → formularz → licznik → bilet", async ({ page, request }) => {
  const [seans] = await seanse(request);
  const seatId = await wolnyFotel(request, seans!.id);
  const [rzad, numer] = [seatId[0]!, seatId.slice(1)];

  await page.goto("/");
  await page.getByRole("link", { name: new RegExp(seans!.movie) }).click();
  await expect(page).toHaveURL(new RegExp(`/seans/${seans!.id}$`));
  await fotel(page, seatId).click();

  await expect(page.getByRole("heading", { name: `Rząd ${rzad}, miejsce ${numer}` })).toBeVisible();
  await wypelnijIRezerwuj(page);

  await expect(page.getByRole("timer")).toHaveText(/^00:0[1-5]$/);
  await page.getByRole("button", { name: "Kupuję bilet" }).click();

  await expect(page).toHaveURL(/\/bilet\//);
  const bilet = page.getByRole("article", { name: "Bilet" });
  await expect(bilet.locator(".bilet__kod")).toHaveText(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  await expect(bilet).toContainText(seans!.movie);
  await expect(bilet).toContainText(seans!.hall);
  await expect(bilet.getByText(rzad, { exact: true })).toBeVisible();
  await expect(bilet.getByText(numer, { exact: true })).toBeVisible();
});

test("2. wygaśnięcie: po TTL komunikat, a mapa znów pokazuje fotel jako wolny", async ({ page, request }) => {
  const [seans] = await seanse(request);
  const seatId = await wolnyFotel(request, seans!.id);

  await page.goto(`/seans/${seans!.id}/miejsce/${seatId}`);
  await wypelnijIRezerwuj(page);
  await expect(page.getByRole("timer")).toBeVisible();

  await expect(page.getByRole("heading", { name: "Rezerwacja wygasła, fotel wrócił do puli" })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("link", { name: "Wybierz inny fotel" }).click();
  await expect(fotel(page, seatId)).not.toHaveClass(/fotel--zajety/);
  await expect(fotel(page, seatId)).toHaveAccessibleName(/wolne$/);
});

test("3. dwie sesje wybierają ten sam fotel: druga dostaje komunikat i odświeżoną mapę", async ({ browser, request }) => {
  const [seans] = await seanse(request);
  const seatId = await wolnyFotel(request, seans!.id);
  const [pierwsza, druga] = await Promise.all([browser.newContext(), browser.newContext()]);
  const [a, b] = await Promise.all([pierwsza.newPage(), druga.newPage()]);
  await Promise.all([
    a.goto(`/seans/${seans!.id}/miejsce/${seatId}`),
    b.goto(`/seans/${seans!.id}/miejsce/${seatId}`),
  ]);

  await wypelnijIRezerwuj(a);
  await expect(a.getByRole("timer")).toBeVisible();

  await wypelnijIRezerwuj(b, "Druga Osoba", unikalnyEmail());
  await expect(b.locator(".baner[role=alert]")).toContainText("Ten fotel został właśnie zajęty");
  await b.getByRole("link", { name: "Wróć do mapy" }).click();
  await expect(b.locator(".baner[role=alert]")).toContainText("Ten fotel został właśnie zajęty");
  await expect(fotel(b, seatId)).toHaveClass(/fotel--zajety/);

  await Promise.all([pierwsza.close(), druga.close()]);
});

test("4. odświeżenie strony licznika i biletu: nic nie wybucha, kod ten sam", async ({ page, browser, request }) => {
  const [seans] = await seanse(request);
  const seatId = await wolnyFotel(request, seans!.id);
  await page.goto(`/seans/${seans!.id}/miejsce/${seatId}`);
  await wypelnijIRezerwuj(page);
  await expect(page.getByRole("timer")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("timer")).toBeVisible();
  await page.getByRole("button", { name: "Kupuję bilet" }).click();
  const kod = page.locator(".bilet__kod");
  await expect(kod).toHaveText(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  const tekstKodu = await kod.textContent();

  await page.reload();
  await expect(kod).toHaveText(tekstKodu!);

  // Nowa karta bez sessionStorage: kod odtworzony idempotentnym POST zakupu.
  const inny = await browser.newContext();
  const nowaKarta = await inny.newPage();
  await nowaKarta.goto(page.url());
  await expect(nowaKarta.locator(".bilet__kod")).toHaveText(tekstKodu!);
  await inny.close();
});

test("5. telefon (375 px): mapa mieści się bez przewijania poziomego", async ({ browser, request }) => {
  const [seans] = await seanse(request);
  const kontekst = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const page = await kontekst.newPage();
  await page.goto(`/seans/${seans!.id}`);
  await expect(fotel(page, "H10")).toBeVisible();
  const { szerokoscStrony, szerokoscOkna, prawaKrawedz } = await page.evaluate(() => ({
    szerokoscStrony: document.documentElement.scrollWidth,
    szerokoscOkna: window.innerWidth,
    prawaKrawedz: document.querySelector('[data-seat="A10"]')!.getBoundingClientRect().right,
  }));
  expect(szerokoscStrony).toBeLessThanOrEqual(szerokoscOkna);
  expect(prawaKrawedz).toBeLessThanOrEqual(szerokoscOkna);
  const rozmiar = await fotel(page, "A1").evaluate((el) => el.getBoundingClientRect().width);
  expect(rozmiar).toBeGreaterThanOrEqual(24);
  await kontekst.close();
});
