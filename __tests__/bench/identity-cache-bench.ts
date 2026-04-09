/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * First-Level Cache (Identity Map) Performance Benchmark
 *
 * Measures the benefit of skipping DB queries when an entity is already
 * in the WriteBuffer's Identity Map (PK-only findOne lookup).
 *
 * Two benchmark modes:
 *   1. Mock DB — isolates pure cache overhead (no network)
 *   2. Real DB — measures actual savings against remote MariaDB / PostgreSQL
 *
 * Run (mock only — no DB required):
 *   npx ts-node --project __tests__/bench/tsconfig.json __tests__/bench/identity-cache-bench.ts
 *
 * Run (with real DB):
 *   BENCH_REAL_DB=true npx ts-node --project __tests__/bench/tsconfig.json __tests__/bench/identity-cache-bench.ts
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { Entity, Column, PrimaryGeneratedColumn } from "../../src";
import { bufferPlugin } from "../../src/core/plugin/buffer/bufferPlugin";
import { DatabaseClient } from "../../src/DatabaseClient";

// ── Config ─────────────────────────────────────────────────

const ITERATIONS = 1000;
const WARMUP = 100;
const ENTITY_COUNT = 50; // number of distinct entities to seed

const MY_OPTS = {
  type: "mysql" as const,
  host: process.env.DB_HOST || "192.168.35.227",
  port: parseInt(process.env.DB_PORT || "3306", 10),
  username: process.env.DB_USER || "mariadb",
  password: process.env.DB_PASSWORD || "mariadb",
  database: process.env.DB_NAME || "cats_db",
};

const PG_OPTS = {
  type: "postgres" as const,
  host: process.env.PG_HOST || "192.168.35.227",
  port: parseInt(process.env.PG_PORT || "5432", 10),
  username: process.env.PG_USER || "postgres",
  password: process.env.PG_PASSWORD || "postgres",
  database: process.env.PG_DATABASE || "multi_tenancy_db",
};

// ── Entity Factory ─────────────────────────────────────────

function makeEntity(tableName: string) {
  const EC = class {} as any;
  Object.defineProperty(EC, "name", { value: tableName });
  Reflect.defineMetadata("design:type", Number, EC.prototype, "id");
  PrimaryGeneratedColumn()(EC.prototype, "id");
  Reflect.defineMetadata("design:type", String, EC.prototype, "name");
  Column({ type: "varchar", length: 100 })(EC.prototype, "name");
  Reflect.defineMetadata("design:type", Number, EC.prototype, "age");
  Column({ type: "int" })(EC.prototype, "age");
  Entity()(EC);
  return EC;
}

// ── Helpers ────────────────────────────────────────────────

function fmt(ms: number): string {
  if (ms < 0.01) return `${(ms * 1000).toFixed(1)}µs`;
  return ms < 1000 ? `${ms.toFixed(2)}ms` : `${(ms / 1000).toFixed(3)}s`;
}

function perOp(totalMs: number, n: number): string {
  const us = (totalMs / n) * 1000;
  if (us < 1) return `${(us * 1000).toFixed(0)}ns/op`;
  if (us < 1000) return `${us.toFixed(1)}µs/op`;
  return `${(us / 1000).toFixed(2)}ms/op`;
}

function speedup(withoutCache: number, withCache: number): string {
  if (withCache === 0) return "∞x";
  return `${(withoutCache / withCache).toFixed(1)}x`;
}

// ── Mock Benchmark ─────────────────────────────────────────

async function benchMock() {
  const EC = makeEntity("MockUser");
  const em = new EntityManager();
  (em as any)._entities = [EC];
  const extended = em.extend(bufferPlugin());

  // Simulate DB rows
  const rows = Array.from({ length: ENTITY_COUNT }, (_, i) => {
    const inst = Object.create(EC.prototype);
    inst.id = i + 1;
    inst.name = `user_${i}`;
    inst.age = 20 + i;
    return inst;
  });

  // Mock em.findOne to simulate DB latency
  const DB_LATENCY_US = 50; // 50µs simulated latency
  const mockFindOne = async (_entity: any, option: any) => {
    // Simulate minimal async overhead (microtask)
    await new Promise<void>((r) => setTimeout(r, 0));
    const id = option?.where?.id;
    return rows.find((r: any) => r.id === id) ?? null;
  };

  // ── Without cache: create fresh buffer each time (no identity map) ──
  jest.spyOn(extended, "findOne").mockImplementation(mockFindOne as any);

  // Warmup
  for (let i = 0; i < WARMUP; i++) {
    const buf = extended.buffer();
    await buf.findOne(EC, { where: { id: (i % ENTITY_COUNT) + 1 } as any });
  }

  const t1 = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    // Fresh buffer = no cache, always goes to em.findOne
    const buf = extended.buffer();
    await buf.findOne(EC, { where: { id: (i % ENTITY_COUNT) + 1 } as any });
  }
  const noCacheMs = performance.now() - t1;

  // ── With cache: reuse same buffer (identity map populated) ──
  const buf = extended.buffer();

  // Populate identity map with all entities
  for (let i = 0; i < ENTITY_COUNT; i++) {
    await buf.findOne(EC, { where: { id: i + 1 } as any });
  }

  // Warmup cached reads
  for (let i = 0; i < WARMUP; i++) {
    await buf.findOne(EC, { where: { id: (i % ENTITY_COUNT) + 1 } as any });
  }

  const findOneSpy = jest.spyOn(extended, "findOne");
  findOneSpy.mockClear();

  const t2 = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    await buf.findOne(EC, { where: { id: (i % ENTITY_COUNT) + 1 } as any });
  }
  const cachedMs = performance.now() - t2;
  const dbCalls = findOneSpy.mock.calls.length;

  findOneSpy.mockRestore();

  return { noCacheMs, cachedMs, dbCalls };
}

// ── Real DB Benchmark ──────────────────────────────────────

async function benchRealDB(label: string, dbOpts: any) {
  const TS = Date.now().toString().slice(-7);
  const TABLE = `bc_cache_${TS}`;
  const EC = makeEntity(TABLE);

  const em = new EntityManager();
  await em.register({
    ...dbOpts,
    synchronize: true,
    logging: false,
    entities: [EC],
  });
  const extended = em.extend(bufferPlugin());
  const repo = em.getRepository(EC);

  // Seed rows
  const rows = Array.from({ length: ENTITY_COUNT }, (_, i) => ({
    name: `user_${i}`,
    age: 20 + i,
  }));
  await repo.insertMany(rows);

  const iters = 200; // fewer iterations for real DB

  // ── Without cache: fresh buffer each findOne ──
  // Warmup
  for (let i = 0; i < 20; i++) {
    const buf = extended.buffer();
    await buf.findOne(EC, { where: { id: (i % ENTITY_COUNT) + 1 } as any });
  }

  const t1 = performance.now();
  for (let i = 0; i < iters; i++) {
    const buf = extended.buffer();
    await buf.findOne(EC, { where: { id: (i % ENTITY_COUNT) + 1 } as any });
  }
  const noCacheMs = performance.now() - t1;

  // ── With cache: same buffer, identity map hit ──
  const buf = extended.buffer();
  for (let i = 0; i < ENTITY_COUNT; i++) {
    await buf.findOne(EC, { where: { id: i + 1 } as any });
  }

  // Warmup
  for (let i = 0; i < 20; i++) {
    await buf.findOne(EC, { where: { id: (i % ENTITY_COUNT) + 1 } as any });
  }

  const t2 = performance.now();
  for (let i = 0; i < iters; i++) {
    await buf.findOne(EC, { where: { id: (i % ENTITY_COUNT) + 1 } as any });
  }
  const cachedMs = performance.now() - t2;

  // Cleanup
  try {
    await em.query(
      dbOpts.type === "mysql"
        ? `DROP TABLE IF EXISTS \`${TABLE}\``
        : `DROP TABLE IF EXISTS "${TABLE}"`,
    );
  } catch {}
  await DatabaseClient.getInstance().close();

  return { noCacheMs, cachedMs, iters };
}

// ── Main ───────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   WriteBuffer First-Level Cache Benchmark               ║");
  console.log("║   findOne() PK lookup: cache hit vs DB query            ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  // ── Mock benchmark ──────────────────────────────────────
  console.log(`━━━ Mock DB (${ITERATIONS} iterations, ${ENTITY_COUNT} entities) ━━━\n`);

  const mock = await benchMock();

  console.log(`  Without cache (fresh buffer):  ${fmt(mock.noCacheMs).padStart(10)}  (${perOp(mock.noCacheMs, ITERATIONS)})`);
  console.log(`  With cache (identity map hit): ${fmt(mock.cachedMs).padStart(10)}  (${perOp(mock.cachedMs, ITERATIONS)})`);
  console.log(`  DB calls with cache:           ${String(mock.dbCalls).padStart(10)}  (expected 0)`);
  console.log(`  Speedup:                       ${speedup(mock.noCacheMs, mock.cachedMs).padStart(10)}`);

  // ── Real DB benchmark (optional) ────────────────────────
  if (process.env.BENCH_REAL_DB === "true") {
    const realIters = 200;

    console.log(`\n━━━ MariaDB (${realIters} iterations, ${ENTITY_COUNT} entities) ━━━\n`);
    const my = await benchRealDB("MariaDB", MY_OPTS);
    console.log(`  Without cache:  ${fmt(my.noCacheMs).padStart(10)}  (${perOp(my.noCacheMs, my.iters)})`);
    console.log(`  With cache:     ${fmt(my.cachedMs).padStart(10)}  (${perOp(my.cachedMs, my.iters)})`);
    console.log(`  Speedup:        ${speedup(my.noCacheMs, my.cachedMs).padStart(10)}`);

    console.log(`\n━━━ PostgreSQL (${realIters} iterations, ${ENTITY_COUNT} entities) ━━━\n`);
    const pg = await benchRealDB("PostgreSQL", PG_OPTS);
    console.log(`  Without cache:  ${fmt(pg.noCacheMs).padStart(10)}  (${perOp(pg.noCacheMs, pg.iters)})`);
    console.log(`  With cache:     ${fmt(pg.cachedMs).padStart(10)}  (${perOp(pg.cachedMs, pg.iters)})`);
    console.log(`  Speedup:        ${speedup(pg.noCacheMs, pg.cachedMs).padStart(10)}`);

    // Summary table
    console.log("\n━━━ Summary ━━━\n");
    console.log("  Scenario        │ Without cache     │ With cache        │ Speedup");
    console.log("  ────────────────┼───────────────────┼───────────────────┼────────");
    console.log(`  Mock DB         │ ${fmt(mock.noCacheMs).padStart(10)} (${perOp(mock.noCacheMs, ITERATIONS).padStart(10)}) │ ${fmt(mock.cachedMs).padStart(10)} (${perOp(mock.cachedMs, ITERATIONS).padStart(10)}) │ ${speedup(mock.noCacheMs, mock.cachedMs)}`);
    console.log(`  MariaDB         │ ${fmt(my.noCacheMs).padStart(10)} (${perOp(my.noCacheMs, my.iters).padStart(10)}) │ ${fmt(my.cachedMs).padStart(10)} (${perOp(my.cachedMs, my.iters).padStart(10)}) │ ${speedup(my.noCacheMs, my.cachedMs)}`);
    console.log(`  PostgreSQL      │ ${fmt(pg.noCacheMs).padStart(10)} (${perOp(pg.noCacheMs, pg.iters).padStart(10)}) │ ${fmt(pg.cachedMs).padStart(10)} (${perOp(pg.cachedMs, pg.iters).padStart(10)}) │ ${speedup(pg.noCacheMs, pg.cachedMs)}`);
  } else {
    console.log("\n  (Set BENCH_REAL_DB=true to also benchmark against real MariaDB/PostgreSQL)");
  }
}

// jest global for mock benchmark
const _global = globalThis as any;
if (!_global.jest) {
  _global.jest = {
    spyOn(obj: any, method: string) {
      const original = obj[method];
      const calls: any[][] = [];
      const mock: any = { calls };
      const spy: any = (...args: any[]) => {
        calls.push(args);
        return (spy._impl ?? original).call(obj, ...args);
      };
      spy.mock = mock;
      spy.mockImplementation = (fn: any) => { spy._impl = fn; return spy; };
      spy.mockClear = () => { calls.length = 0; return spy; };
      spy.mockRestore = () => { obj[method] = original; };
      obj[method] = spy;
      return spy;
    },
  };
}

main().catch(console.error);
