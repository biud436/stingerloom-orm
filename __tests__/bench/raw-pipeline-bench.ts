/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * RawPipeline Performance Benchmark
 *
 * Compares four approaches for reading large datasets:
 *   1. em.find()       — Full ORM entity transformation
 *   2. em.query()      — Raw query (no entity transformation, but still JSON objects)
 *   3. pipe().raw()    — RawPipeline batched streaming (no entity transformation)
 *   4. pipe().binary() — RawPipeline with driver-level array mode
 *
 * Uses SQLite in-memory for reproducibility (no external DB required).
 *
 * Run:
 *   NODE_OPTIONS="--expose-gc" npx ts-node --project __tests__/bench/tsconfig.json __tests__/bench/raw-pipeline-bench.ts
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { rawPipelinePlugin } from "../../src/core/plugin/raw-pipeline";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import sql from "sql-template-tag";

// ── Entity ──────────────────────────────────────────────────

@Entity({ name: "bench_users" })
class BenchUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 100 })
  name!: string;

  @Column({ type: "varchar", length: 200 })
  email!: string;

  @Column({ type: "int" })
  age!: number;

  @Column({ type: "boolean" })
  active!: boolean;

  @Column({ type: "text" })
  bio!: string;
}

// ── Helpers ─────────────────────────────────────────────────

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms.toFixed(1)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function formatMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

function tryGC(): void {
  if (global.gc) {
    global.gc();
  }
}

async function measureMemory<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; memDelta: number; time: number }> {
  tryGC();
  const memBefore = process.memoryUsage().heapUsed;
  const start = performance.now();
  const result = await fn();
  const time = performance.now() - start;
  const memAfter = process.memoryUsage().heapUsed;
  tryGC();
  return { result, memDelta: Math.max(0, memAfter - memBefore), time };
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const ROW_COUNTS = [1_000, 10_000, 100_000];
  const RUNS = 5;
  const BATCH_SIZE = 1000;

  console.log("Setting up SQLite in-memory database...\n");

  // Connect via EntityManager.register()
  const em = new EntityManager();
  await em.register(
    {
      type: "sqlite",
      host: "",
      port: 0,
      username: "",
      password: "",
      database: ":memory:",
      entities: [BenchUser],
      synchronize: true,
      logging: false,
    } as any,
    "bench",
  );

  em.extend(rawPipelinePlugin());

  for (const rowCount of ROW_COUNTS) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`  ${rowCount.toLocaleString()} rows`);
    console.log(`${"=".repeat(60)}\n`);

    // Seed data
    console.log("  Seeding...");
    await seedData(em, rowCount);

    // Verify row count
    const countResult = await em.query<{ cnt: number }>(
      sql`SELECT COUNT(*) as cnt FROM "bench_users"`,
    );
    console.log(`  Seeded: ${countResult[0]?.cnt} rows\n`);

    const results: Record<string, { times: number[]; mems: number[] }> = {
      "em.find()": { times: [], mems: [] },
      "em.query()": { times: [], mems: [] },
      "pipe().raw()": { times: [], mems: [] },
      "pipe().binary()": { times: [], mems: [] },
    };

    for (let run = 0; run < RUNS; run++) {
      // 1. em.find() — Full entity transformation
      {
        const { time, memDelta } = await measureMemory(async () => {
          return em.find(BenchUser);
        });
        results["em.find()"].times.push(time);
        results["em.find()"].mems.push(memDelta);
      }

      // 2. em.query() — Raw query, no entity transformation
      {
        const { time, memDelta } = await measureMemory(async () => {
          return em.query<Record<string, unknown>>(
            sql`SELECT * FROM "bench_users"`,
          );
        });
        results["em.query()"].times.push(time);
        results["em.query()"].mems.push(memDelta);
      }

      // 3. pipe().raw() — RawPipeline batched streaming
      {
        const { time, memDelta } = await measureMemory(async () => {
          const all: Record<string, unknown>[] = [];
          for await (const batch of em
            .pipe(BenchUser, { batchSize: BATCH_SIZE })
            .raw()) {
            all.push(...batch);
          }
          return all;
        });
        results["pipe().raw()"].times.push(time);
        results["pipe().raw()"].mems.push(memDelta);
      }

      // 4. pipe().binary() — RawPipeline with arrayMode
      {
        const { time, memDelta } = await measureMemory(async () => {
          const all: any[] = [];
          for await (const batch of em
            .pipe(BenchUser, { batchSize: BATCH_SIZE })
            .binary({ arrayMode: true })) {
            all.push(...batch);
          }
          return all;
        });
        results["pipe().binary()"].times.push(time);
        results["pipe().binary()"].mems.push(memDelta);
      }
    }

    // Print results
    console.log("  Results (median of 5 runs):\n");
    console.log(
      "  " +
        "Method".padEnd(20) +
        "Time".padStart(12) +
        "Memory".padStart(12) +
        "Rows/sec".padStart(15),
    );
    console.log("  " + "-".repeat(59));

    for (const [method, data] of Object.entries(results)) {
      const medTime = median(data.times);
      const medMem = median(data.mems);
      const rowsPerSec = Math.round(rowCount / (medTime / 1000));

      console.log(
        "  " +
          method.padEnd(20) +
          formatMs(medTime).padStart(12) +
          formatMB(medMem).padStart(12) +
          rowsPerSec.toLocaleString().padStart(15),
      );
    }

    // Cleanup for next round
    await em.query('DELETE FROM "bench_users"');
  }

  // Shutdown
  await em.propagateShutdown();
  console.log("\nBenchmark complete.\n");
}

async function seedData(em: EntityManager, count: number): Promise<void> {
  const BATCH_INSERT = 500;
  for (let offset = 0; offset < count; offset += BATCH_INSERT) {
    const batchCount = Math.min(BATCH_INSERT, count - offset);
    const valueParts: string[] = [];
    const params: any[] = [];

    for (let i = 0; i < batchCount; i++) {
      const idx = offset + i;
      valueParts.push("(?, ?, ?, ?, ?)");
      params.push(
        `user_${idx}`,
        `user_${idx}@example.com`,
        20 + (idx % 60),
        idx % 2 === 0 ? 1 : 0,
        `Bio text for user ${idx}. This is some filler text to simulate real-world data.`,
      );
    }

    const insertSql = `INSERT INTO "bench_users" ("name", "email", "age", "active", "bio") VALUES ${valueParts.join(", ")}`;
    await em.query(insertSql, params);
  }
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
