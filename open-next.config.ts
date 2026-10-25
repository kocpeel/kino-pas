import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Aplikacja renderuje wszystko dynamicznie (SSR) i sama zarządza cache odczytów,
// więc nie potrzebuje incremental cache (R2/KV) ani kolejki rewalidacji.
export default defineCloudflareConfig({});
