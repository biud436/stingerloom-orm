/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * JSON Query Performance Benchmark — QueryDSL (qAlias) over JSON columns.
 *
 * Seeds 10,000 rows with a nested `profile` JSON payload and runs a fixed
 * workload of JSON-path queries on three drivers:
 *   - SQLite (in-memory)       json_extract / json_type / json_array_length
 *   - MySQL/MariaDB            JSON_EXTRACT / JSON_CONTAINS / JSON_TYPE
 *   - PostgreSQL (jsonb)       #>>, @>, jsonb_array_length, jsonb_typeof, ? operator
 *
 * Connection info mirrors `.mcp.json` (192.168.35.227, root/root for MySQL,
 * postgres/postgres for Postgres, database multi_tenancy_db) and can be
 * overridden via env vars.
 *
 * Run:
 *   npx ts-node --project __tests__/bench/tsconfig.json __tests__/bench/json-query-bench.ts
 *
 *   # skip a driver:
 *   BENCH_MYSQL=false    npx ts-node ... json-query-bench.ts
 *   BENCH_POSTGRES=false npx ts-node ... json-query-bench.ts
 *   BENCH_SQLITE=false   npx ts-node ... json-query-bench.ts
 *
 * Each scenario is timed with 10 iterations (discarding the first as warmup)
 * and reports min / median / mean. A raw-SQL baseline is run alongside every
 * scenario so ORM overhead is visible in one table.
 *
 * ── Results (2026-04-14, 10,000 rows, remote DB @ 192.168.35.227) ──────────
 *
 *   SQLite in-memory — seed 20.9ms
 *
 *   Scenario                        │    DSL │    Raw │ ratio │ matches
 *   ────────────────────────────────┼────────┼────────┼───────┼────────
 *   eq nested scalar                │  5.2ms │  5.1ms │ 1.02x │      1
 *   gt nested numeric               │  6.9ms │  5.8ms │ 1.18x │  6,159
 *   array contains scalar           │  7.0ms │  5.8ms │ 1.21x │  8,333
 *   array length > 2                │  5.9ms │  6.6ms │ 0.89x │  4,999
 *   hasKey(phone)                   │  7.8ms │  5.8ms │ 1.35x │  9,000
 *   items[0].price >= 50            │  6.6ms │  5.9ms │ 1.13x │  5,550
 *   combined (age>30 AND role=...)  │  6.4ms │  6.0ms │ 1.06x │  1,999
 *
 *   MySQL/MariaDB 11.8 (remote) — seed 1.28s
 *
 *   Scenario                        │    DSL │    Raw │ ratio │ matches
 *   ────────────────────────────────┼────────┼────────┼───────┼────────
 *   eq nested scalar                │ 66.4ms │ 66.9ms │ 0.99x │      1
 *   gt nested numeric               │137.3ms │ 92.5ms │ 1.48x │  6,159
 *   array contains scalar           │142.1ms │ 67.8ms │ 2.10x │  6,666
 *   array length > 2                │116.9ms │113.9ms │ 1.03x │  4,999
 *   hasKey(phone)                   │194.1ms │ 99.4ms │ 1.95x │  9,000
 *   items[0].price >= 50            │123.6ms │107.8ms │ 1.15x │  5,550
 *   combined (age>30 AND role=...)  │123.8ms │128.3ms │ 0.96x │  1,999
 *
 *   PostgreSQL 16.13 (remote, jsonb) — seed 1.49s
 *
 *   Scenario                        │    DSL │    Raw │ ratio │ matches
 *   ────────────────────────────────┼────────┼────────┼───────┼────────
 *   eq nested scalar                │ 73.0ms │ 78.5ms │ 0.93x │      1
 *   gt nested numeric               │137.2ms │ 48.0ms │ 2.86x │  6,159
 *   array contains scalar           │155.3ms │ 57.0ms │ 2.72x │  6,666
 *   array length > 2                │120.6ms │ 45.7ms │ 2.64x │  4,999
 *   hasKey(phone)                   │183.3ms │ 49.2ms │ 3.73x │  9,000
 *   items[0].price >= 50            │130.8ms │ 53.5ms │ 2.44x │  5,550
 *   combined (age>30 AND role=...)  │ 66.1ms │ 47.3ms │ 1.40x │  1,999
 *
 *   Key takeaways:
 *   - SQLite: DSL overhead is negligible (1.0-1.35x). The in-memory path
 *     is dominated by SQL execution itself; ORM transformation cost is small.
 *   - MySQL: simple eq/AND predicates are parity with raw; JSON_CONTAINS
 *     (array contains) and JSON_CONTAINS_PATH (hasKey) show ~2x DSL overhead
 *     because the DSL emits JSON_EXTRACT+compare instead of native operators.
 *   - PostgreSQL: DSL overhead is largest (2.4-3.7x on most scenarios) —
 *     DSL emits `#>>` text extraction plus casts, while hand-tuned raw SQL
 *     uses jsonb-native `?` (key exists), `@>` (containment), and
 *     jsonb_array_length. Teaching the DSL to recognize jsonb and emit
 *     `?` / `@>` / `->` would reclaim most of the gap.
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  qAlias,
} from "../../src";
import { DatabaseClient } from "../../src/DatabaseClient";
import mysql from "mysql2/promise";
import pg from "pg";

// ── Config ─────────────────────────────────────────────────────────────────

const ROWS = 10_000;
const ITERATIONS = 10; // 1 warmup + 9 measured
const TS = Date.now().toString().slice(-7);
const TABLE = `bj_${TS}`;

const MY_OPTS = {
  type: "mysql" as const,
  host: process.env.DB_HOST || "192.168.35.227",
  port: parseInt(process.env.DB_PORT || "3306", 10),
  username: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "root",
  database: process.env.DB_NAME || "multi_tenancy_db",
};

const PG_OPTS = {
  type: "postgres" as const,
  host: process.env.PG_HOST || "192.168.35.227",
  port: parseInt(process.env.PG_PORT || "5432", 10),
  username: process.env.PG_USER || "postgres",
  password: process.env.PG_PASSWORD || "postgres",
  database: process.env.PG_DATABASE || "multi_tenancy_db",
};

const SQLITE_OPTS = {
  type: "sqlite" as const,
  database: ":memory:",
};

type DriverType = "sqlite" | "mysql" | "postgres";

// ── Seed data ──────────────────────────────────────────────────────────────

const ROLES = ["admin", "editor", "viewer", "guest"] as const;
const CITIES = ["Seoul", "Busan", "Incheon", "Daegu", "Gwangju"] as const;
const TAG_POOL = ["red", "blue", "green", "yellow", "black", "white"] as const;

function buildProfile(i: number) {
  const role = ROLES[i % ROLES.length];
  const city = CITIES[i % CITIES.length];
  const tagCount = i % TAG_POOL.length; // 0..5
  const tags = TAG_POOL.slice(0, tagCount);
  const itemCount = 1 + (i % 4); // 1..4
  const items = Array.from({ length: itemCount }, (_, k) => ({
    name: `item_${k}`,
    price: 10 + ((i + k) % 90),
  }));
  // ~every 10th row omits contact.phone to exercise hasKey/isNull.
  const contact: any = { email: `user${i}@example.com` };
  if (i % 10 !== 0) contact.phone = `010-${String(i).padStart(6, "0")}`;

  return {
    role,
    tags,
    contact,
    personal: { age: 18 + (i % 60), city },
    items,
  };
}

// ── Entity factory ─────────────────────────────────────────────────────────

function makeEntity(tableName: string, jsonType: "json" | "jsonb") {
  const EC = class {} as any;
  Object.defineProperty(EC, "name", { value: tableName });

  Reflect.defineMetadata("design:type", Number, EC.prototype, "id");
  PrimaryGeneratedColumn()(EC.prototype, "id");

  Reflect.defineMetadata("design:type", String, EC.prototype, "name");
  Column({ type: "varchar", length: 100 })(EC.prototype, "name");

  Reflect.defineMetadata("design:type", Object, EC.prototype, "profile");
  Column({ type: jsonType, nullable: true })(EC.prototype, "profile");

  Entity()(EC);
  return EC;
}

// ── Stats ──────────────────────────────────────────────────────────────────

function stats(timings: number[]) {
  const measured = timings.slice(1); // drop warmup
  const sorted = [...measured].sort((a, b) => a - b);
  const min = sorted[0];
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = measured.reduce((a, b) => a + b, 0) / measured.length;
  return { min, median, mean };
}

function fmt(ms: number): string {
  if (ms < 1) return `${ms.toFixed(2)}ms`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// ── Seed helpers ───────────────────────────────────────────────────────────

async function seedRows(
  em: EntityManager,
  driver: DriverType,
  tableName: string,
) {
  const BATCH = driver === "sqlite" ? 1000 : 500;
  const q = driver === "mysql" ? "`" : '"';
  const tbl = `${q}${tableName}${q}`;
  const nameCol = `${q}name${q}`;
  const profileCol = `${q}profile${q}`;

  for (let offset = 0; offset < ROWS; offset += BATCH) {
    const end = Math.min(offset + BATCH, ROWS);
    const params: any[] = [];
    const tuples: string[] = [];
    for (let i = offset; i < end; i++) {
      const k = i - offset;
      if (driver === "postgres") {
        tuples.push(`($${k * 2 + 1}, $${k * 2 + 2}::jsonb)`);
      } else {
        tuples.push(`(?, ?)`);
      }
      params.push(`user_${i}`, JSON.stringify(buildProfile(i)));
    }
    const sqlStr = `INSERT INTO ${tbl} (${nameCol}, ${profileCol}) VALUES ${tuples.join(", ")}`;
    await em.query(sqlStr, params);
  }
}

// ── Raw SQL baselines ──────────────────────────────────────────────────────
// Each scenario below has both an ORM (QueryDSL) path and a raw SQL path so
// overhead is directly comparable.

interface Scenario {
  label: string;
  dsl: (em: EntityManager, EC: any) => Promise<number>;
  raw: (em: EntityManager, tbl: string) => Promise<number>;
}

function scenarios(driver: DriverType, tableName: string): Scenario[] {
  const q = driver === "mysql" ? "`" : '"';
  const tbl = `${q}${tableName}${q}`;

  // raw SQL fragments per-driver
  const extractEmailEq =
    driver === "mysql"
      ? `JSON_UNQUOTE(JSON_EXTRACT(${tbl}.\`profile\`, '$.contact.email')) = ?`
      : driver === "postgres"
        ? `${tbl}."profile" #>> '{contact,email}' = $1`
        : `json_extract(${tbl}."profile", '$.contact.email') = ?`;

  const extractAgeGt =
    driver === "mysql"
      ? `CAST(JSON_EXTRACT(${tbl}.\`profile\`, '$.personal.age') AS SIGNED) > ?`
      : driver === "postgres"
        ? `(${tbl}."profile" #>> '{personal,age}')::int > $1`
        : `CAST(json_extract(${tbl}."profile", '$.personal.age') AS INTEGER) > ?`;

  const arrContains =
    driver === "mysql"
      ? `JSON_CONTAINS(${tbl}.\`profile\`, JSON_QUOTE(?), '$.tags')`
      : driver === "postgres"
        ? `${tbl}."profile" -> 'tags' @> to_jsonb($1::text)`
        : `EXISTS (SELECT 1 FROM json_each(json_extract(${tbl}."profile", '$.tags')) WHERE value = ?)`;

  const arrLenGt =
    driver === "mysql"
      ? `JSON_LENGTH(JSON_EXTRACT(${tbl}.\`profile\`, '$.tags')) > ?`
      : driver === "postgres"
        ? `jsonb_array_length(${tbl}."profile" -> 'tags') > $1`
        : `json_array_length(json_extract(${tbl}."profile", '$.tags')) > ?`;

  const hasKeyPhone =
    driver === "mysql"
      ? `JSON_CONTAINS_PATH(${tbl}.\`profile\`, 'one', '$.contact.phone')`
      : driver === "postgres"
        ? `(${tbl}."profile" -> 'contact') ? 'phone'`
        : `json_extract(${tbl}."profile", '$.contact.phone') IS NOT NULL`;

  const itemPriceGte =
    driver === "mysql"
      ? `CAST(JSON_EXTRACT(${tbl}.\`profile\`, '$.items[0].price') AS SIGNED) >= ?`
      : driver === "postgres"
        ? `(${tbl}."profile" #>> '{items,0,price}')::int >= $1`
        : `CAST(json_extract(${tbl}."profile", '$.items[0].price') AS INTEGER) >= ?`;

  const pgParam = (n: number) => (driver === "postgres" ? `$${n}` : `?`);

  return [
    {
      label: "eq nested scalar",
      dsl: async (em, EC) => {
        const u = qAlias(EC, "u") as any;
        const r = await em
          .createQueryBuilder(EC, "u")
          .where(u.profile.contact.email.eq("user777@example.com"))
          .getRawMany();
        return r.length;
      },
      raw: async (em) => {
        const r = await em.query<any>(
          `SELECT id FROM ${tbl} WHERE ${extractEmailEq}` as any,
          ["user777@example.com"],
        );
        return r.length;
      },
    },
    {
      label: "gt nested numeric",
      dsl: async (em, EC) => {
        const u = qAlias(EC, "u") as any;
        const r = await em
          .createQueryBuilder(EC, "u")
          .where(u.profile.personal.age.gt(40))
          .getRawMany();
        return r.length;
      },
      raw: async (em) => {
        const r = await em.query<any>(
          `SELECT id FROM ${tbl} WHERE ${extractAgeGt}` as any,
          [40],
        );
        return r.length;
      },
    },
    {
      // SQLite's DSL .contains() is scalar-equality only, so we can't express
      // array-element containment through qAlias. We substitute path("tags[0]")
      // on SQLite to keep the scenario measurable on all three drivers.
      label: "array contains scalar",
      dsl: async (em, EC) => {
        const u = qAlias(EC, "u") as any;
        const expr =
          driver === "sqlite"
            ? u.profile.path("tags[0]").eq("red")
            : u.profile.tags.contains("blue");
        const r = await em
          .createQueryBuilder(EC, "u")
          .where(expr)
          .getRawMany();
        return r.length;
      },
      raw: async (em) => {
        if (driver === "sqlite") {
          const r = await em.query<any>(
            `SELECT id FROM ${tbl} WHERE json_extract(${tbl}."profile", '$.tags[0]') = ?` as any,
            ["red"],
          );
          return r.length;
        }
        const r = await em.query<any>(
          `SELECT id FROM ${tbl} WHERE ${arrContains}` as any,
          ["blue"],
        );
        return r.length;
      },
    },
    {
      label: "array length > 2",
      dsl: async (em, EC) => {
        const u = qAlias(EC, "u") as any;
        const r = await em
          .createQueryBuilder(EC, "u")
          .where(u.profile.tags.arrayLength().gt(2))
          .getRawMany();
        return r.length;
      },
      raw: async (em) => {
        const r = await em.query<any>(
          `SELECT id FROM ${tbl} WHERE ${arrLenGt}` as any,
          [2],
        );
        return r.length;
      },
    },
    {
      label: "hasKey(phone)",
      dsl: async (em, EC) => {
        const u = qAlias(EC, "u") as any;
        const r = await em
          .createQueryBuilder(EC, "u")
          .where(u.profile.contact.hasKey("phone"))
          .getRawMany();
        return r.length;
      },
      raw: async (em) => {
        const r = await em.query<any>(
          `SELECT id FROM ${tbl} WHERE ${hasKeyPhone}` as any,
          [],
        );
        return r.length;
      },
    },
    {
      label: "items[0].price >= 50",
      dsl: async (em, EC) => {
        const u = qAlias(EC, "u") as any;
        const r = await em
          .createQueryBuilder(EC, "u")
          .where(u.profile.items[0].price.gte(50))
          .getRawMany();
        return r.length;
      },
      raw: async (em) => {
        const r = await em.query<any>(
          `SELECT id FROM ${tbl} WHERE ${itemPriceGte}` as any,
          [50],
        );
        return r.length;
      },
    },
    {
      label: "combined (age>30 AND role=editor)",
      dsl: async (em, EC) => {
        const u = qAlias(EC, "u") as any;
        const r = await em
          .createQueryBuilder(EC, "u")
          .where(u.profile.personal.age.gt(30))
          .andWhere(u.profile.role.eq("editor"))
          .getRawMany();
        return r.length;
      },
      raw: async (em) => {
        const ageCond = extractAgeGt.replace(/\?|\$1/, pgParam(1));
        const roleCond =
          driver === "mysql"
            ? `JSON_UNQUOTE(JSON_EXTRACT(${tbl}.\`profile\`, '$.role')) = ?`
            : driver === "postgres"
              ? `${tbl}."profile" #>> '{role}' = $2`
              : `json_extract(${tbl}."profile", '$.role') = ?`;
        const r = await em.query<any>(
          `SELECT id FROM ${tbl} WHERE ${ageCond} AND ${roleCond}` as any,
          [30, "editor"],
        );
        return r.length;
      },
    },
  ];
}

// ── Driver runner ──────────────────────────────────────────────────────────

async function runDriver(
  driver: DriverType,
  label: string,
  opts: any,
): Promise<{
  label: string;
  results: Array<{
    scenario: string;
    dsl: { min: number; median: number; mean: number };
    raw: { min: number; median: number; mean: number };
    matches: number;
    ratio: number;
  }>;
  seedMs: number;
}> {
  const tableName = `${TABLE}_${driver}`;
  const jsonType: "json" | "jsonb" = driver === "postgres" ? "jsonb" : "json";
  const EC = makeEntity(tableName, jsonType);

  const em = new EntityManager();
  await em.register({
    ...opts,
    synchronize: true,
    logging: false,
    entities: [EC],
  } as any);

  // Seed
  const seedStart = performance.now();
  await seedRows(em, driver, tableName);
  const seedMs = performance.now() - seedStart;

  const scns = scenarios(driver, tableName);
  const results: any[] = [];

  for (const s of scns) {
    const dslT: number[] = [];
    const rawT: number[] = [];
    let matches = 0;

    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      matches = await s.dsl(em, EC);
      dslT.push(performance.now() - t0);

      const t1 = performance.now();
      await s.raw(em, tableName);
      rawT.push(performance.now() - t1);
    }

    const dsl = stats(dslT);
    const raw = stats(rawT);
    results.push({
      scenario: s.label,
      dsl,
      raw,
      matches,
      ratio: dsl.median / raw.median,
    });
  }

  // Cleanup
  const q = driver === "mysql" ? "`" : '"';
  try {
    await em.query(`DROP TABLE IF EXISTS ${q}${tableName}${q}` as any);
  } catch {
    // ignore
  }
  await DatabaseClient.getInstance().close();

  return { label, results, seedMs };
}

// ── MCP sanity check ───────────────────────────────────────────────────────
// For MySQL/Postgres, we expect the MCP tooling to already confirm the remote
// server is reachable. This function just pings via the drivers to fail fast.

async function ping(driver: DriverType, opts: any): Promise<string> {
  if (driver === "sqlite") return "sqlite: in-memory OK";
  if (driver === "mysql") {
    const conn = await mysql.createConnection({
      host: opts.host,
      port: opts.port,
      user: opts.username,
      password: opts.password,
      database: opts.database,
    });
    const [rows] = await conn.query("SELECT VERSION() AS v");
    await conn.end();
    const v = (rows as any[])[0]?.v ?? "?";
    return `mysql: OK (${String(v).slice(0, 40)}) @ ${opts.host}:${opts.port}/${opts.database}`;
  }
  const client = new pg.Client({
    host: opts.host,
    port: opts.port,
    user: opts.username,
    password: opts.password,
    database: opts.database,
  });
  await client.connect();
  const r = await client.query("SELECT version() AS v");
  await client.end();
  const v = r.rows[0]?.v ?? "?";
  return `postgres: OK (${String(v).slice(0, 40)}) @ ${opts.host}:${opts.port}/${opts.database}`;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log(`║  Stingerloom ORM — JSON Query Benchmark (${ROWS} rows)  ║`);
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  const enabled: Array<{ driver: DriverType; label: string; opts: any }> = [];
  if (process.env.BENCH_SQLITE !== "false")
    enabled.push({ driver: "sqlite", label: "SQLite", opts: SQLITE_OPTS });
  if (process.env.BENCH_MYSQL !== "false")
    enabled.push({ driver: "mysql", label: "MySQL/MariaDB", opts: MY_OPTS });
  if (process.env.BENCH_POSTGRES !== "false")
    enabled.push({ driver: "postgres", label: "PostgreSQL", opts: PG_OPTS });

  // ── Ping phase ────────────────────────────────────────────────────────
  console.log("━━━ Connectivity check ━━━");
  for (const d of enabled) {
    try {
      const msg = await ping(d.driver, d.opts);
      console.log(`  ✓ ${msg}`);
    } catch (e: any) {
      console.log(`  ✗ ${e.message}`);
      console.log(`    → skipping ${d.label}`);
      d.driver = "__skip__" as any;
    }
  }
  const runnable = enabled.filter((d) => (d.driver as any) !== "__skip__");
  console.log();

  // ── Run phase ─────────────────────────────────────────────────────────
  const allResults: Awaited<ReturnType<typeof runDriver>>[] = [];
  for (const d of runnable) {
    console.log(`━━━ ${d.label} ━━━`);
    const t0 = performance.now();
    const res = await runDriver(d.driver, d.label, d.opts);
    const total = performance.now() - t0;
    console.log(`  seed: ${fmt(res.seedMs)}  (${ROWS} rows)`);
    for (const r of res.results) {
      console.log(
        `  ${r.scenario.padEnd(38)} dsl=${fmt(r.dsl.median).padStart(8)} raw=${fmt(r.raw.median).padStart(8)}  ratio=${r.ratio.toFixed(2)}x  matches=${r.matches}`,
      );
    }
    console.log(`  total: ${fmt(total)}\n`);
    allResults.push(res);
  }

  // ── Summary ───────────────────────────────────────────────────────────
  console.log("━━━ Summary (median latency, DSL / raw, ratio) ━━━\n");
  const scenarioNames = allResults[0]?.results.map((r) => r.scenario) ?? [];
  const header = ["Scenario", ...allResults.map((r) => r.label)];
  console.log(
    "  " +
      header[0].padEnd(38) +
      " │ " +
      header
        .slice(1)
        .map((h) => h.padEnd(28))
        .join(" │ "),
  );
  console.log("  " + "─".repeat(38 + allResults.length * 31));
  for (const name of scenarioNames) {
    const cells = allResults.map((ar) => {
      const r = ar.results.find((x) => x.scenario === name)!;
      return `${fmt(r.dsl.median).padStart(7)}/${fmt(r.raw.median).padStart(7)} ${r.ratio.toFixed(2)}x`.padEnd(
        28,
      );
    });
    console.log("  " + name.padEnd(38) + " │ " + cells.join(" │ "));
  }
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
