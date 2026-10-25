import { applyD1Migrations, env } from "cloudflare:test";

// Migracje są idempotentne (tabela d1_migrations), więc można je wołać przed każdym plikiem.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
