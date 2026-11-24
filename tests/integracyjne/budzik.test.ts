// Budzik outboxu (Durable Object z alarmem) w workerd: nastawia się na najbliższy job i tylko na wcześniej, a alarm
// wykonuje joby w terminie i nastawia się na następny. Na nim stoją terminy „najpóźniej 15 s” (punkty wracają po
// expiresAt, oferta z listy przechodzi dalej); Cron to tylko siatka. Job `lista-kolejka` nie potrzebuje sieci.

import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { zasiej } from "./pomocnicze";

function budzik(nazwa: string) {
  return env.BUDZIK_TEST.get(env.BUDZIK_TEST.idFromName(nazwa));
}

type Budzik = ReturnType<typeof budzik>;

function alarmBudzika(b: Budzik): Promise<number | null> {
  return runInDurableObject(b, (_obiekt, stan) => stan.storage.getAlarm());
}

async function dodajJob(id: string, visibleAt: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO outbox (id, task, input, visibleAt, createdAt)
     VALUES (?1, 'lista-kolejka', json_object('eventId', 'waitlist-test', 'ttlMs', 120000), ?2, ?2)`,
  )
    .bind(id, visibleAt)
    .run();
}

async function zrobiony(id: string): Promise<boolean> {
  const wiersz = await env.DB.prepare(`SELECT completedAt FROM outbox WHERE id = ?1`).bind(id).first<{ completedAt: number | null }>();
  return wiersz?.completedAt != null;
}

beforeEach(async () => {
  await zasiej();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("budzik outboxu (Durable Object z alarmem)", () => {
  it("nastawia się na najbliższy job, a później dopisany job alarmu nie przesuwa (wcześniejszy tak)", async () => {
    const teraz = Date.now();
    const b = budzik("nastawianie");
    await dodajJob("lista-kolejka:waitlist-test", teraz + 60_000);
    await b.zaplanuj();
    expect(await alarmBudzika(b)).toBe(teraz + 60_000);

    await dodajJob("lista-kolejka:pozniej", teraz + 120_000);
    await b.zaplanuj();
    expect(await alarmBudzika(b)).toBe(teraz + 60_000);

    await dodajJob("lista-kolejka:wczesniej", teraz + 30_000);
    await b.zaplanuj();
    expect(await alarmBudzika(b)).toBe(teraz + 30_000);
    await runInDurableObject(b, (_obiekt, stan) => stan.storage.deleteAlarm());
  });

  it("alarm wykonuje joby, których termin minął, i nastawia się na następny, a bez jobów nie zostaje", async () => {
    const teraz = Date.now();
    const b = budzik("alarm");
    await dodajJob("lista-kolejka:waitlist-test", teraz + 60_000);
    await dodajJob("lista-kolejka:pozniej", teraz + 120_000);
    await b.zaplanuj();
    expect(await alarmBudzika(b)).toBe(teraz + 60_000);
    // Termin pierwszego joba minął (bez ruszania budzika); alarm wymuszony teraz.
    await env.DB.prepare(`UPDATE outbox SET visibleAt = ?1 WHERE id = 'lista-kolejka:waitlist-test'`).bind(teraz - 1).run();

    expect(await runDurableObjectAlarm(b)).toBe(true);
    expect(await zrobiony("lista-kolejka:waitlist-test")).toBe(true);
    expect(await zrobiony("lista-kolejka:pozniej")).toBe(false);
    expect(await alarmBudzika(b)).toBe(teraz + 120_000);

    // Job zrobiony gdzie indziej (np. przez Crona): alarm odpala, nic nie ma do zrobienia i niczego nie zostawia.
    await env.DB.prepare(`UPDATE outbox SET completedAt = ?1 WHERE id = 'lista-kolejka:pozniej'`).bind(teraz).run();
    expect(await runDurableObjectAlarm(b)).toBe(true);
    expect(await alarmBudzika(b)).toBeNull();
    expect(await runDurableObjectAlarm(b)).toBe(false);
  });

  it("job na teraz: alarm odpala sam w ciągu sekund, bez Crona i bez żądań", async () => {
    const b = budzik("sam");
    await dodajJob("lista-kolejka:waitlist-test", Date.now() - 1);
    const start = Date.now();
    await b.zaplanuj();
    await vi.waitUntil(() => zrobiony("lista-kolejka:waitlist-test"), { timeout: 3_000, interval: 50 });
    expect(Date.now() - start).toBeLessThan(3_000);
  });

  it("pusty outbox: zaplanuj() nie ustawia alarmu", async () => {
    const b = budzik("pusty");
    await b.zaplanuj();
    expect(await alarmBudzika(b)).toBeNull();
    expect(await runDurableObjectAlarm(b)).toBe(false);
  });
});
