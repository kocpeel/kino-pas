import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
    // Typ `exports` z "cloudflare:workers" w testach: główny moduł to worker testowy.
    interface GlobalProps {
      mainModule: typeof import("./worker-testowy");
    }
  }
}
