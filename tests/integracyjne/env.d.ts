import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      /** Budzik outboxu tylko dla budzik.test.ts (zob. wrangler.test.jsonc). */
      BUDZIK_TEST: DurableObjectNamespace<import("../../src/lib/budzik/budzik-outboxu").BudzikOutboxu>;
    }
    // Typ `exports` z "cloudflare:workers" w testach: główny moduł to worker testowy.
    interface GlobalProps {
      mainModule: typeof import("./worker-testowy");
    }
  }
}
