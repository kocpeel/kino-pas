import { expect, test, type Page } from "@playwright/test";
import { seanse, wolnyFotel, wypelnijIRezerwuj } from "../e2e/pomocnicze";

// Content-Security-Policy z nonce'em ustawia worker.ts, więc sprawdzamy ją na zbudowanej aplikacji.

/** Zbiera naruszenia CSP zgłoszone przez przeglądarkę (zdarzenie i komunikaty konsoli). */
function obserwujNaruszenia(page: Page): () => Promise<string[]> {
  const zKonsoli: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy/i.test(m.text())) zKonsoli.push(m.text());
  });
  void page.addInitScript(() => {
    const okno = window as unknown as { __csp: string[] };
    okno.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => okno.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  return async () => [...zKonsoli, ...(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp))];
}

test("strony mają CSP z nowym nonce'em, skrypty Next.js go niosą, a przeglądarka niczego nie blokuje", async ({
  page,
  request,
}) => {
  const naruszenia = obserwujNaruszenia(page);
  const odp = await page.goto("/");
  const csp = odp!.headers()["content-security-policy"]!;
  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  const nonce = /'nonce-([^']+)'/.exec(csp)![1];
  // Przeglądarka ukrywa atrybut nonce w DOM, ale zostawia właściwość.
  const nonceSkryptow = await page.locator("script").evaluateAll((s) => s.map((e) => (e as HTMLScriptElement).nonce));
  expect(nonceSkryptow.length).toBeGreaterThan(0);
  expect(new Set(nonceSkryptow)).toEqual(new Set([nonce]));
  expect(await naruszenia()).toEqual([]);

  // Każde żądanie ma inny nonce, a API nie dostaje polityki stron.
  expect((await request.get("/")).headers()["content-security-policy"]).not.toBe(csp);
  expect((await request.get("/api/events")).headers()["content-security-policy"]).toBeUndefined();

  // Mapa z kanałem na żywo (WebSocket przez connect-src) i formularz rezerwacji.
  const seans = (await seanse(request))[1]!;
  await page.goto(`/seans/${seans.id}`);
  await expect(page.getByText("Na żywo")).toBeVisible();
  expect(await naruszenia()).toEqual([]);

  await page.goto(`/seans/${seans.id}/miejsce/${await wolnyFotel(request, seans.id)}`);
  await wypelnijIRezerwuj(page);
  await expect(page.getByRole("timer")).toBeVisible();
  expect(await naruszenia()).toEqual([]);

  // 404 renderowane na żądanie: też z nonce'em, a link wraca do repertuaru nawigacją kliencką.
  const brak = await page.goto("/nie-ma-takiej-strony");
  expect(brak!.status()).toBe(404);
  expect(brak!.headers()["content-security-policy"]).toMatch(/'nonce-/);
  await page.getByRole("link", { name: "Wróć do repertuaru" }).click();
  await expect(page).toHaveURL(/\/$/);
  expect(await naruszenia()).toEqual([]);
});
