import { expect, test, type Page } from "@playwright/test";
import { fotel, seanse, unikalnyEmail, wolnyFotel, wypelnijIRezerwuj } from "../e2e/pomocnicze";

/** Liczy zapytania mapy o stan sali (odpytywanie), żeby sprawdzić, że przy kanale na żywo ich nie ma. */
function licznikOdpytywania(page: Page, eventId: string) {
  let ile = 0;
  page.on("request", (r) => {
    if (r.method() === "GET" && new URL(r.url()).pathname === `/api/events/${eventId}`) ile++;
  });
  return () => ile;
}

test("zmiana na sali dociera do oglądającego od razu, bez odpytywania serwera", async ({ page, request }) => {
  const seans = (await seanse(request))[1]!; // środkowy seans: inne testy e2e go nie rezerwują
  await page.goto(`/seans/${seans.id}`);
  await expect(page.getByText("Na żywo")).toBeVisible();
  const zapytania = licznikOdpytywania(page, seans.id);

  const seatId = await wolnyFotel(request, seans.id);
  await expect(fotel(page, seatId)).not.toHaveClass(/fotel--zajety/);
  const odp = await request.post("/api/reservations", {
    data: { eventId: seans.id, seatId, name: "Push E2E", email: unikalnyEmail() },
  });
  expect(odp.status()).toBe(201);

  await expect(fotel(page, seatId)).toHaveClass(/fotel--zajety/, { timeout: 1500 });
  expect(zapytania()).toBe(0);
});

test("dwie osoby: rezerwacja w jednej przeglądarce od razu szarzeje fotel u drugiej", async ({ browser, request }) => {
  const seans = (await seanse(request))[1]!; // środkowy seans: inne testy e2e go nie rezerwują
  const seatId = await wolnyFotel(request, seans.id);
  const [kontekstA, kontekstB] = await Promise.all([browser.newContext(), browser.newContext()]);
  const [a, b] = await Promise.all([kontekstA.newPage(), kontekstB.newPage()]);

  await b.goto(`/seans/${seans.id}`);
  await expect(b.getByText("Na żywo")).toBeVisible();

  await a.goto(`/seans/${seans.id}/miejsce/${seatId}`);
  await wypelnijIRezerwuj(a);
  await expect(a.getByRole("timer")).toBeVisible();

  await expect(fotel(b, seatId)).toHaveClass(/fotel--zajety/, { timeout: 1500 });
  await expect(fotel(b, seatId)).toHaveAccessibleName(/zajęte$/);
  await Promise.all([kontekstA.close(), kontekstB.close()]);
});

test("dwie osoby na formularzu tego samego fotela: po rezerwacji A druga od razu widzi, że fotel zajęty", async ({
  browser,
  request,
}) => {
  const seans = (await seanse(request))[1]!; // środkowy seans: inne testy e2e go nie rezerwują
  const seatId = await wolnyFotel(request, seans.id);
  const [kontekstA, kontekstB] = await Promise.all([browser.newContext(), browser.newContext()]);
  const [a, b] = await Promise.all([kontekstA.newPage(), kontekstB.newPage()]);
  await Promise.all([
    a.goto(`/seans/${seans.id}/miejsce/${seatId}`),
    b.goto(`/seans/${seans.id}/miejsce/${seatId}`),
  ]);
  await b.getByLabel("Imię").fill("Druga Osoba");
  // Kanał formularza B musi być połączony, zanim A zarezerwuje (inaczej B dostanie stan przy połączeniu).
  await b.waitForTimeout(500);

  await wypelnijIRezerwuj(a);
  await expect(a.getByRole("timer")).toBeVisible();

  const baner = b.locator(".baner[role=alert]", { hasText: "Ten fotel właśnie zajął ktoś inny" });
  await expect(baner).toBeVisible({ timeout: 1500 });
  await expect(b.getByRole("button", { name: "Zarezerwuj fotel" })).toBeDisabled();
  await expect(baner.getByRole("link", { name: "Wróć do mapy" })).toHaveAttribute(
    "href",
    `/seans/${seans.id}?zajete=${seatId}`,
  );
  await Promise.all([kontekstA.close(), kontekstB.close()]);
});
