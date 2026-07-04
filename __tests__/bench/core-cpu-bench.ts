/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Core CPU Benchmark (SQLite in-memory)
 *
 * Exercises EntityManager hot paths against better-sqlite3 :memory: so the
 * numbers reflect ORM CPU overhead rather than network latency. Intended to
 * run under --cpu-prof to locate hotspots:
 *
 *   node --cpu-prof --cpu-prof-dir=/tmp/prof \
 *     -r ts-node/register/transpile-only __tests__/bench/core-cpu-bench.ts
 *
 * Or plain timing mode:
 *
 *   npx ts-node --transpile-only --project __tests__/bench/tsconfig.json \
 *     __tests__/bench/core-cpu-bench.ts
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  OneToMany,
} from "../../src";
import { DatabaseClient } from "../../src/DatabaseClient";

// ── Entities ───────────────────────────────────────────────

@Entity({ name: "bench_user" })
class BenchUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 100 })
  name!: string;

  @Column({ type: "varchar", length: 200 })
  email!: string;

  @Column({ type: "int" })
  age!: number;

  @Column({ type: "int" })
  score!: number;

  @Column({ type: "varchar", length: 50 })
  city!: string;

  @Column({ type: "boolean" })
  active!: boolean;

  @Column({ type: "text", nullable: true })
  bio?: string;

  @OneToMany(() => BenchPost, { mappedBy: "author" })
  posts?: BenchPost[];
}

@Entity({ name: "bench_post" })
class BenchPost {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 200 })
  title!: string;

  @Column({ type: "text" })
  body!: string;

  @Column({ type: "int" })
  views!: number;

  @Column({ type: "int", nullable: true })
  authorId?: number;

  @ManyToOne(() => BenchUser, (e: any) => e.author, {
    joinColumn: "authorId",
    eager: true,
  })
  author?: BenchUser;
}

// ── Timing helpers ─────────────────────────────────────────

interface BenchResult {
  name: string;
  iterations: number;
  totalMs: number;
  opsPerSec: number;
}

const results: BenchResult[] = [];

/** Iteration multiplier — bump with BENCH_SCALE=5 for CPU profiling runs. */
const SCALE = Math.max(1, parseInt(process.env.BENCH_SCALE || "1", 10));

/** Comma-separated substring filter, e.g. BENCH_ONLY="findOne,count". */
const ONLY = (process.env.BENCH_ONLY || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

async function bench(
  name: string,
  baseIterations: number,
  warmup: number,
  fn: (i: number) => Promise<unknown>,
): Promise<void> {
  if (ONLY.length && !ONLY.some((f) => name.includes(f))) return;
  const iterations = baseIterations * SCALE;
  for (let i = 0; i < warmup; i++) await fn(i);
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) await fn(i);
  const totalMs = Number(process.hrtime.bigint() - start) / 1e6;
  results.push({
    name,
    iterations,
    totalMs,
    opsPerSec: (iterations / totalMs) * 1000,
  });
  console.log(
    `${name.padEnd(32)} ${String(iterations).padStart(6)} iters  ` +
      `${totalMs.toFixed(1).padStart(9)} ms  ` +
      `${((iterations / totalMs) * 1000).toFixed(0).padStart(8)} ops/s`,
  );
}

// ── Main ───────────────────────────────────────────────────

async function main() {
  const em = new EntityManager();
  await em.register({
    type: "sqlite",
    database: ":memory:",
    synchronize: false,
    logging: false,
    entities: [BenchUser, BenchPost],
  } as any);

  const conn = DatabaseClient.getInstance().getConnection();
  await conn.query(`
    CREATE TABLE "bench_user" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "name" TEXT NOT NULL,
      "email" TEXT NOT NULL,
      "age" INTEGER NOT NULL,
      "score" INTEGER NOT NULL,
      "city" TEXT NOT NULL,
      "active" INTEGER NOT NULL,
      "bio" TEXT
    )
  `);
  await conn.query(`
    CREATE TABLE "bench_post" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "title" TEXT NOT NULL,
      "body" TEXT NOT NULL,
      "views" INTEGER NOT NULL,
      "authorId" INTEGER,
      FOREIGN KEY ("authorId") REFERENCES "bench_user"("id")
    )
  `);

  const mkUser = (i: number): Partial<BenchUser> => ({
    name: `user-${i}`,
    email: `user-${i}@example.com`,
    age: 20 + (i % 50),
    score: i * 7,
    city: i % 2 ? "seoul" : "busan",
    active: i % 3 !== 0,
    bio: i % 5 ? `bio text for user ${i}` : undefined,
  });

  // Seed data used by read benchmarks: 1,000 users / 2,000 posts
  await em.insertMany(
    BenchUser,
    Array.from({ length: 1000 }, (_, i) => mkUser(i)),
  );
  await em.insertMany(
    BenchPost,
    Array.from({ length: 2000 }, (_, i) => ({
      title: `post ${i}`,
      body: `lorem ipsum body for post number ${i}`,
      views: i % 100,
      authorId: (i % 1000) + 1,
    })),
  );

  console.log("--- write paths ---");
  await bench("save (individual)", 300, 30, (i) =>
    em.save(BenchUser, mkUser(10000 + i)),
  );
  await bench("saveMany (batch 100)", 10, 2, (i) =>
    em.saveMany(
      BenchUser,
      Array.from({ length: 100 }, (_, k) => mkUser(20000 + i * 100 + k)),
    ),
  );
  await bench("insertMany (batch 100)", 10, 2, (i) =>
    em.insertMany(
      BenchUser,
      Array.from({ length: 100 }, (_, k) => mkUser(40000 + i * 100 + k)),
    ),
  );
  await bench("update by pk", 500, 50, (i) =>
    em.update(BenchUser, { id: (i % 1000) + 1 }, { score: i }),
  );

  console.log("--- read paths ---");
  await bench("findOne by pk", 2000, 200, (i) =>
    em.findOne(BenchUser, { where: { id: (i % 1000) + 1 } as any }),
  );
  await bench("find 100 rows", 300, 30, (i) =>
    em.find(BenchUser, {
      where: { city: i % 2 ? "seoul" : "busan" } as any,
      limit: [0, 100],
    }),
  );
  await bench("find 100 rows + eager M2O", 100, 10, (i) =>
    em.find(BenchPost, {
      where: { views: i % 100 } as any,
      limit: [0, 100],
    }),
  );
  await bench("qb getMany 100 rows", 300, 30, () =>
    em
      .createQueryBuilder(BenchUser, "u")
      .where("age", ">", 30)
      .limit(100)
      .getMany(),
  );
  await bench("count", 1000, 100, () =>
    em.count(BenchUser, { city: "seoul" } as any),
  );

  console.log("\nJSON_RESULTS " + JSON.stringify(results));

  await em.propagateShutdown();
  await DatabaseClient.getInstance().close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
