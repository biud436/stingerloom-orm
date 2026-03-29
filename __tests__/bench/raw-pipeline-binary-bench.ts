/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * RawPipeline Binary Mode Benchmark — PostgreSQL & MySQL
 *
 * Compares em.find() / pipe().raw() / pipe().binary() on real databases.
 *
 * Run:
 *   PG_HOST=192.168.35.227 INTEGRATION_TEST=true \
 *     NODE_OPTIONS="--expose-gc" npx ts-node --project __tests__/bench/tsconfig.json \
 *     __tests__/bench/raw-pipeline-binary-bench.ts
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { DatabaseClient } from "../../src/DatabaseClient";
import { rawPipelinePlugin } from "../../src/core/plugin/raw-pipeline";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import sql, { raw as sqlRaw } from "sql-template-tag";
import { MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";
import { resetScannerContainer } from "../../src/scanner/ScannerContainer";

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
  if (global.gc) global.gc();
}

async function measure<T>(fn: () => Promise<T>): Promise<{ time: number; mem: number }> {
  tryGC();
  const memBefore = process.memoryUsage().heapUsed;
  const start = performance.now();
  await fn();
  const time = performance.now() - start;
  const memAfter = process.memoryUsage().heapUsed;
  tryGC();
  return { time, mem: Math.max(0, memAfter - memBefore) };
}

// ── Driver configs ──────────────────────────────────────────

interface DriverConfig {
  label: string;
  type: "postgres" | "mysql";
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  quote: string;
}

function getDrivers(): DriverConfig[] {
  const drivers: DriverConfig[] = [];

  if (process.env.INTEGRATION_TEST_MYSQL !== "false") {
    drivers.push({
      label: "MySQL",
      type: "mysql",
      host: process.env.DB_HOST || "192.168.35.227",
      port: parseInt(process.env.DB_PORT || "3306", 10),
      username: process.env.DB_USER || "mariadb",
      password: process.env.DB_PASSWORD || "mariadb",
      database: process.env.DB_NAME || "fastify",
      quote: "`",
    });
  }

  if (process.env.INTEGRATION_TEST_POSTGRES !== "false") {
    drivers.push({
      label: "PostgreSQL",
      type: "postgres",
      host: process.env.PG_HOST || "localhost",
      port: parseInt(process.env.PG_PORT || "5432", 10),
      username: process.env.PG_USER || "postgres",
      password: process.env.PG_PASSWORD || "postgres",
      database: process.env.PG_DATABASE || "multi_tenancy_db",
      quote: '"',
    });
  }

  return drivers;
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const ROW_COUNTS = [1_000, 10_000, 100_000];
  const RUNS = 5;
  const BATCH_SIZE = 1000;

  const drivers = getDrivers();
  if (drivers.length === 0) {
    console.log("No drivers configured. Set INTEGRATION_TEST=true.");
    process.exit(1);
  }

  for (const driver of drivers) {
    console.log(`\n${"#".repeat(60)}`);
    console.log(`  ${driver.label} (${driver.host}:${driver.port})`);
    console.log(`${"#".repeat(60)}`);

    const q = driver.quote;
    const tableName = `bench_binary_${Date.now()}`;

    // Reset metadata
    MetadataLayerRegistry.reset();
    resetScannerContainer();

    // Define entity dynamically
    @Entity({ name: tableName })
    class BenchEntity {
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

    const em = new EntityManager();
    await em.register(
      {
        type: driver.type,
        host: driver.host,
        port: driver.port,
        username: driver.username,
        password: driver.password,
        database: driver.database,
        entities: [BenchEntity],
        synchronize: true,
        logging: false,
        plugins: [rawPipelinePlugin()],
      } as any,
      `bench_${driver.type}`,
    );

    try {
      for (const rowCount of ROW_COUNTS) {
        console.log(`\n${"=".repeat(56)}`);
        console.log(`  ${driver.label} — ${rowCount.toLocaleString()} rows`);
        console.log(`${"=".repeat(56)}\n`);

        // Seed
        console.log("  Seeding...");
        await seedData(em, tableName, rowCount, driver);

        const verifyResult = await em.query<{ cnt: number }>(
          sql`SELECT COUNT(*) as cnt FROM ${sqlRaw(`${q}${tableName}${q}`)}`,
        );
        console.log(`  Seeded: ${verifyResult[0]?.cnt} rows\n`);

        const results: Record<string, { times: number[]; mems: number[] }> = {
          "em.find()": { times: [], mems: [] },
          "pipe().raw()": { times: [], mems: [] },
          "pipe().binary()": { times: [], mems: [] },
          "pipe().arrayMode()": { times: [], mems: [] },
        };

        for (let run = 0; run < RUNS; run++) {
          // 1. em.find()
          {
            const { time, mem } = await measure(() => em.find(BenchEntity));
            results["em.find()"].times.push(time);
            results["em.find()"].mems.push(mem);
          }

          // 2. pipe().raw()
          {
            const { time, mem } = await measure(async () => {
              const all: any[] = [];
              for await (const batch of em.pipe(BenchEntity, { batchSize: BATCH_SIZE }).raw()) {
                all.push(...batch);
              }
              return all;
            });
            results["pipe().raw()"].times.push(time);
            results["pipe().raw()"].mems.push(mem);
          }

          // 3. pipe().binary({ binary: true })
          {
            const { time, mem } = await measure(async () => {
              const all: any[] = [];
              for await (const batch of em.pipe(BenchEntity, { batchSize: BATCH_SIZE }).binary({ binary: true })) {
                all.push(...batch);
              }
              return all;
            });
            results["pipe().binary()"].times.push(time);
            results["pipe().binary()"].mems.push(mem);
          }

          // 4. pipe().binary({ arrayMode: true })
          {
            const { time, mem } = await measure(async () => {
              const all: any[] = [];
              for await (const batch of em.pipe(BenchEntity, { batchSize: BATCH_SIZE }).binary({ arrayMode: true })) {
                all.push(...batch);
              }
              return all;
            });
            results["pipe().arrayMode()"].times.push(time);
            results["pipe().arrayMode()"].mems.push(mem);
          }
        }

        // Print
        console.log("  Results (median of 5 runs):\n");
        console.log(
          "  " +
            "Method".padEnd(22) +
            "Time".padStart(12) +
            "Memory".padStart(12) +
            "Rows/sec".padStart(15),
        );
        console.log("  " + "-".repeat(61));

        for (const [method, data] of Object.entries(results)) {
          const medTime = median(data.times);
          const medMem = median(data.mems);
          const rowsPerSec = Math.round(rowCount / (medTime / 1000));

          console.log(
            "  " +
              method.padEnd(22) +
              formatMs(medTime).padStart(12) +
              formatMB(medMem).padStart(12) +
              rowsPerSec.toLocaleString().padStart(15),
          );
        }

        // Cleanup rows for next round
        await em.query(`DELETE FROM ${q}${tableName}${q}`);
      }

      // Drop table
      await em.query(`DROP TABLE IF EXISTS ${q}${tableName}${q}${driver.type === "postgres" ? " CASCADE" : ""}`);
    } finally {
      try { await DatabaseClient.getInstance().close(); } catch {}
      MetadataLayerRegistry.reset();
      resetScannerContainer();
    }
  }

  console.log("\nBenchmark complete.\n");
}

async function seedData(em: EntityManager, tableName: string, count: number, driver: DriverConfig): Promise<void> {
  const q = driver.quote;
  const BATCH = 500;

  for (let offset = 0; offset < count; offset += BATCH) {
    const batchCount = Math.min(BATCH, count - offset);
    const valueParts: string[] = [];
    const params: any[] = [];

    for (let i = 0; i < batchCount; i++) {
      const idx = offset + i;
      valueParts.push("(?, ?, ?, ?, ?)");
      params.push(
        `user_${idx}`,
        `user_${idx}@example.com`,
        20 + (idx % 60),
        driver.type === "postgres" ? (idx % 2 === 0) : (idx % 2 === 0 ? 1 : 0),
        `Bio for user ${idx}. Filler text to simulate real-world payloads with some length.`,
      );
    }

    const insertSql = `INSERT INTO ${q}${tableName}${q} (${q}name${q}, ${q}email${q}, ${q}age${q}, ${q}active${q}, ${q}bio${q}) VALUES ${valueParts.join(", ")}`;
    await em.query(insertSql, params);
  }
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
