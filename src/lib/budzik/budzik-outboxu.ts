// Durable Object „budzik outboxu”: jeden egzemplarz na Workera, który dzwoni wtedy, gdy w outboksie jest coś
// do zrobienia, i wtedy to robi (te same funkcje co Cron, z tym samym claimem, więc nic nie wykona się dwa razy).
//
// Po co, skoro jest Cron: Cron Trigger na Cloudflare chodzi najczęściej raz na minutę (a darmowy Vercel Cron
// raz na dobę), a niektóre kroki mają termin co do sekundy: punkty wracają najpóźniej 15 s po `expiresAt`,
// a miejsce z listy oczekujących przechodzi na następną osobę zaraz po końcu oferty. Alarm Durable Objectu
// nastawiony na `visibleAt` najbliższego joba wykonuje go w sekundę. Cron zostaje siatką bezpieczeństwa.
//
// Kto go budzi: każde miejsce, które dopisuje albo przesuwa job, woła `zaplanuj()` (RPC, w tle żądania).
// Budzik sam czyta z D1, kiedy jest najbliższy job, więc wołający nie musi znać terminu.

import { DurableObject } from "cloudflare:workers";
import { zegarSystemowy } from "../czas";
import { najblizszyJob } from "../db/zapytania-outbox";
import { przetworzOutbox } from "../domain/outbox";
import { bramkaResendZeSrodowiska, type SrodowiskoResend } from "../maile/resend";
import { bramkaZeSrodowiska, type SrodowiskoStripe } from "../platnosci/stripe";
import { uslugaPunktowZeSrodowiska, type SrodowiskoPunktow } from "../punkty/usluga";

export interface SrodowiskoBudzika extends SrodowiskoStripe, SrodowiskoResend, SrodowiskoPunktow {
  DB: D1Database;
}

/** Jobów na jeden alarm: ochrona przed limitem podżądań; gdy zostanie więcej, następny alarm jest zaraz. */
const JOBOW_NA_ALARM = 10;
/** Najkrótszy odstęp do następnego alarmu, żeby job odłożony „na teraz” nie kręcił się w pętli. */
const MIN_ODSTEP_MS = 200;

export class BudzikOutboxu extends DurableObject<SrodowiskoBudzika> {
  /** RPC: outbox się zmienił. Budzik ustawia się na najbliższy job (wcześniej niż był, nigdy później). */
  async zaplanuj(): Promise<void> {
    const kiedy = await najblizszyJob(this.env.DB);
    if (kiedy === null) return;
    const cel = Math.max(kiedy, Date.now());
    const obecny = await this.ctx.storage.getAlarm();
    if (obecny === null || cel < obecny) await this.ctx.storage.setAlarm(cel);
  }

  async alarm(): Promise<void> {
    const uslugi = {
      platnosci: bramkaZeSrodowiska(this.env),
      punkty: uslugaPunktowZeSrodowiska(this.env),
      maile: bramkaResendZeSrodowiska(this.env),
    };
    await przetworzOutbox(this.env.DB, uslugi, { zegar: zegarSystemowy, limit: JOBOW_NA_ALARM });
    // Błąd wyżej = runtime ponowi alarm sam. Tu: następny termin z bazy (także jobów odłożonych w tym przebiegu).
    const kiedy = await najblizszyJob(this.env.DB);
    if (kiedy !== null) await this.ctx.storage.setAlarm(Math.max(kiedy, Date.now() + MIN_ODSTEP_MS));
  }
}
