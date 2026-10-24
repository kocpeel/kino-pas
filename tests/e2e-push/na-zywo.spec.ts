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
  const seans = (await seanse(request)).at(-1)!;
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
  const seans = (await seanse(request)).at(-1)!;
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
