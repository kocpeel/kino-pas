// Most między adapterem OpenNext a resztą kodu: pobiera bindingi bieżącego żądania.
// Tylko ten plik importuje @opennextjs/cloudflare.

import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { Zaleznosci } from "../zaleznosci";
import { zaleznosciZBindingow, type Bindingi } from "./polaczenie";

export function zaleznosciZadania(): Zaleznosci {
  const { env, ctx } = getCloudflareContext();
  return zaleznosciZBindingow(env as unknown as Bindingi, {
    wTle: (obietnica) => ctx.waitUntil(obietnica),
  });
}
