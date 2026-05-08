import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { EntityManager, sql, raw } from "@stingerloom/orm";
import { AppModule } from "../src/app.module";

/**
 * Truncate every table in the linear_clone DB while leaving the schema in
 * place. Used to reset state between debugging passes — schema sync is
 * driven by the running app, so we only need to wipe rows.
 *
 * Run with: `pnpm exec ts-node -r tsconfig-paths/register scripts/truncate-all.ts`
 */
async function main(): Promise<void> {
  const ctx = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error", "warn"],
  });

  try {
    const em = ctx.get(EntityManager);

    const rows = await em.query<{ table_name: string } | { TABLE_NAME: string }>(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE()`,
    );
    const names = rows
      .map((r) => (r as any).table_name ?? (r as any).TABLE_NAME)
      .filter((n: unknown): n is string => typeof n === "string" && n.length > 0)
      .sort();

    if (names.length === 0) {
      console.log("[truncate-all] no tables found — nothing to truncate");
      return;
    }

    console.log(`[truncate-all] truncating ${names.length} tables`);
    await em.query(sql`SET FOREIGN_KEY_CHECKS = 0`);
    try {
      for (const name of names) {
        await em.query(sql`TRUNCATE TABLE ${raw(em.wrapTable(name))}`);
      }
    } finally {
      await em.query(sql`SET FOREIGN_KEY_CHECKS = 1`);
    }
    console.log("[truncate-all] done");
  } finally {
    await ctx.close();
  }
}

main().catch((err) => {
  console.error("[truncate-all] failed:", err);
  process.exit(1);
});
