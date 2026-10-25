import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { fotel, seanse, wolnyFotel, wypelnijIRezerwuj } from "./pomocnicze";

async function bezNaruszen(page: Page, ekran: string) {
  const wynik = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const opis = wynik.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`);
  expect(opis, `naruszenia axe na ekranie: ${ekran}`).toEqual([]);
}

test("6a. axe: brak naruszeń na każdym ekranie", async ({ page, request }) => {
  const [seans] = await seanse(request);
  const seatId = await wolnyFotel(request, seans!.id);

  await page.goto("/");
  await bezNaruszen(page, "repertuar");
  await page.goto(`/seans/${seans!.id}`);
  await expect(fotel(page, "A1")).toBeVisible();
  await bezNaruszen(page, "mapa sali");
  await page.goto(`/seans/${seans!.id}/miejsce/${seatId}`);
  await bezNaruszen(page, "formularz");
  await page.getByRole("button", { name: "Zarezerwuj fotel" }).click();
  await bezNaruszen(page, "formularz z błędami");
  await wypelnijIRezerwuj(page);
  await expect(page.getByRole("timer")).toBeVisible();
  await bezNaruszen(page, "licznik");
  await page.getByRole("button", { name: "Kupuję bilet" }).click();
  await expect(page.locator(".bilet__kod")).toBeVisible();
  await bezNaruszen(page, "bilet");
  await page.goto("/seans/nie-ma-takiego");
  await bezNaruszen(page, "nie znaleziono");
});

test("6b. obsługa samą klawiaturą: mapa → formularz → rezerwacja", async ({ page, request }) => {
  const [seans] = await seanse(request);
  await page.goto(`/seans/${seans!.id}`);
  const aktywny = page.locator('.fotel[tabindex="0"]');
  await aktywny.focus();
  const start = await aktywny.getAttribute("data-seat");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  const cel = await page.evaluate(() => document.activeElement?.getAttribute("data-seat"));
  expect(cel).not.toBe(start);
  expect(await page.locator('.fotel[tabindex="0"]').count()).toBe(1);

  // Przejście do pierwszego wolnego fotela strzałkami, potem Enter.
  for (let i = 0; i < 80; i++) {
    const zajety = await page.evaluate(() => document.activeElement?.getAttribute("aria-disabled") === "true");
    if (!zajety) break;
    await page.keyboard.press("ArrowRight");
  }
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Imię")).toBeVisible();

  await page.getByLabel("Imię").focus();
  await page.keyboard.type("Klawiatura");
  await page.keyboard.press("Tab");
  await page.keyboard.type(`klawiatura-${Date.now()}@example.com`);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("timer")).toBeVisible();
});

test("6c. prefers-reduced-motion: animacje wyłączone", async ({ page, request }) => {
  const [seans] = await seanse(request);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/seans/${seans!.id}?zajete=A1`);
  const czas = await page.locator(".fotel--swiezo-zajety").evaluate((el) => getComputedStyle(el).animationDuration);
  expect(parseFloat(czas)).toBeLessThan(0.01);
  const przejscie = await fotel(page, "B1").evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(parseFloat(przejscie)).toBeLessThan(0.01);
});

test("6d. mapa po polsku: lang=pl i etykiety foteli", async ({ page, request }) => {
  const [seans] = await seanse(request);
  await page.goto(`/seans/${seans!.id}`);
  await expect(page.locator("html")).toHaveAttribute("lang", "pl");
  await expect(fotel(page, "F7")).toHaveAccessibleName(/^Rząd F, miejsce 7, (wolne|zajęte)$/);
  await expect(page.getByRole("grid")).toBeVisible();
});

test("wspólne: bez danych sesji licznik pozwala spróbować kupić (serwer decyduje)", async ({ page, request }) => {
  const [seans] = await seanse(request);
  const seatId = await wolnyFotel(request, seans!.id);
  await page.goto(`/seans/${seans!.id}/miejsce/${seatId}`);
  await wypelnijIRezerwuj(page);
  await expect(page.getByRole("timer")).toBeVisible();
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await expect(page.getByText("Nie widzimy czasu ważności tej rezerwacji")).toBeVisible();
  await page.getByRole("button", { name: "Kupuję bilet" }).click();
  await expect(page.locator(".bilet__kod")).toBeVisible();
});
