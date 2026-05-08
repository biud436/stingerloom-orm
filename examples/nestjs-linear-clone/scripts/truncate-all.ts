import "reflect-metadata";
import { config as loadEnv } from "dotenv";
import { createConnection } from "mysql2/promise";
import { resolve } from "node:path";

/**
 * Truncate every table in linear_clone while leaving the schema in place.
 * Used to reset state between debugging passes — the running app handles
 * schema sync on next boot, so we only need to drop rows.
 *
 * Talks to mysql2 directly to avoid the multi-minute AppModule boot the
 * full Nest context requires; the only thing we need is a connection.
 *
 * Run with: `pnpm exec ts-node -r tsconfig-paths/register scripts/truncate-all.ts`
 */
async function main(): Promise<void> {
  loadEnv({ path: resolve(__dirname, "..", ".env") });

  const conn = await createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: false,
  });

  try {
    const [rows] = (await conn.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE()`,
    )) as unknown as [Array<{ table_name?: string; TABLE_NAME?: string }>, unknown];

    const names = rows
      .map((r) => r.table_name ?? r.TABLE_NAME)
      .filter((n): n is string => typeof n === "string" && n.length > 0)
      .sort();

    if (names.length === 0) {
      console.log("[truncate-all] no tables found — nothing to truncate");
      return;
    }

    console.log(`[truncate-all] truncating ${names.length} tables`);
    await conn.query(`SET FOREIGN_KEY_CHECKS = 0`);
    try {
      for (const name of names) {
        // Identifier names come from information_schema; quote with backticks
        // and reject any name containing a backtick to keep the SET safe.
        if (name.includes("`")) {
          throw new Error(`refusing unsafe table name: ${name}`);
        }
        await conn.query(`TRUNCATE TABLE \`${name}\``);
      }
    } finally {
      await conn.query(`SET FOREIGN_KEY_CHECKS = 1`);
    }
    console.log("[truncate-all] done");
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error("[truncate-all] failed:", err);
  process.exit(1);
});
