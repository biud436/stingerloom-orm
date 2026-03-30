/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Write Operation Performance Benchmark
 *
 * Compares five approaches for inserting 100 rows:
 *   1. Raw driver INSERT x100     — Individual INSERT per row (baseline)
 *   2. Raw driver batch INSERT    — Single INSERT with 100 value tuples
 *   3. ORM save() x100            — Individual save() per row (transaction per call)
 *   4. ORM insertMany(100)        — Single batch INSERT via repository
 *   5. ORM buffer+flush(100)      — WriteBuffer persist() x100 then flush()
 *
 * Runs against remote MariaDB and PostgreSQL.
 * Also measures read performance (find, findOne) for reference.
 *
 * Run:
 *   npx ts-node --project __tests__/bench/tsconfig.json __tests__/bench/write-bench.ts
 *
 * Environment variables (defaults shown):
 *   DB_HOST=192.168.35.227  DB_PORT=3306  DB_USER=mariadb  DB_PASSWORD=mariadb  DB_NAME=cats_db
 *   PG_HOST=192.168.35.227  PG_PORT=5432  PG_USER=postgres PG_PASSWORD=postgres PG_DATABASE=multi_tenancy_db
 *
 * ── Results (2026-03-30, remote DB 192.168.35.227) ─────────────────────────
 *
 *   Write (100 rows INSERT):
 *
 *   Method                  │ MariaDB  │ PostgreSQL │ vs Raw batch
 *   ────────────────────────┼──────────┼────────────┼────────────
 *   Raw batch INSERT(100)   │     11ms │       10ms │ 1.0x
 *   ORM insertMany(100)     │     35ms │       41ms │ 3.1x / 3.9x
 *   ORM buffer+flush(100)   │   1.76s  │      695ms │ 153.8x / 67.2x
 *   Raw INSERT x100         │    771ms │     1.07s  │ 67.2x / 103.0x
 *   ORM save() x100         │   6.47s  │     3.45s  │ 563.7x / 333.3x
 *
 *   Read (100 rows, x100 iterations):
 *
 *   Method                  │ MariaDB        │ PostgreSQL
 *   ────────────────────────┼────────────────┼──────────────
 *   ORM find() x100         │  893ms (8.9/op)│  692ms (6.9/op)
 *   ORM findOne() x100      │  652ms (6.5/op)│  645ms (6.5/op)
 *
 *   Key takeaways:
 *   - insertMany() is the right choice for bulk inserts (3-4x vs raw, acceptable)
 *   - save() x100 is slow due to per-call transaction wrapping (6 DB round-trips each)
 *   - buffer+flush is slow because flush() internally calls save() per item
 *   - Read operations have negligible ORM overhead
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { Entity, Column, PrimaryGeneratedColumn } from "../../src";
import { DatabaseClient } from "../../src/DatabaseClient";
import { bufferPlugin } from "../../src/core/plugin/buffer/bufferPlugin";
import mysql from "mysql2/promise";
import pg from "pg";

// ── Config ─────────────────────────────────────────────────

const TS = Date.now().toString().slice(-7);
const TABLE_ORM = `bw_orm_${TS}`;
const TABLE_BUF = `bw_buf_${TS}`;
const TABLE_RAW_MY = `bw_raw_my_${TS}`;
const TABLE_RAW_PG = `bw_raw_pg_${TS}`;
const TABLE_READ = `bw_read_${TS}`;

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

const ROWS = Array.from({ length: 100 }, (_, i) => ({
  name: `user_${i}`,
  age: 20 + (i % 50),
}));

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
  return ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function perOp(ms: number, n = 100): string {
  return `${(ms / n).toFixed(1)}ms/op`;
}

// ── Raw Benchmarks ─────────────────────────────────────────

async function benchRawMySQL() {
  const pool = mysql.createPool({
    host: MY_OPTS.host,
    port: MY_OPTS.port,
    user: MY_OPTS.username,
    password: MY_OPTS.password,
    database: MY_OPTS.database,
    connectionLimit: 10,
  });

  await pool.execute(
    `CREATE TABLE IF NOT EXISTS \`${TABLE_RAW_MY}\` (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100), age INT)`,
  );

  // Individual INSERT x100
  const t1 = performance.now();
  for (let i = 0; i < 100; i++) {
    await pool.execute(
      `INSERT INTO \`${TABLE_RAW_MY}\` (name, age) VALUES (?, ?)`,
      [ROWS[i].name, ROWS[i].age],
    );
  }
  const individualMs = performance.now() - t1;

  // Batch INSERT (single query)
  await pool.execute(`DELETE FROM \`${TABLE_RAW_MY}\``);
  const values = ROWS.map((r) => `('${r.name}', ${r.age})`).join(", ");
  const t2 = performance.now();
  await pool.execute(
    `INSERT INTO \`${TABLE_RAW_MY}\` (name, age) VALUES ${values}`,
  );
  const batchMs = performance.now() - t2;

  await pool.execute(`DROP TABLE IF EXISTS \`${TABLE_RAW_MY}\``);
  await pool.end();
  return { individualMs, batchMs };
}

async function benchRawPG() {
  const pool = new pg.Pool({
    host: PG_OPTS.host,
    port: PG_OPTS.port,
    user: PG_OPTS.username,
    password: PG_OPTS.password,
    database: PG_OPTS.database,
    max: 10,
  });

  await pool.query(
    `CREATE TABLE IF NOT EXISTS "${TABLE_RAW_PG}" (id SERIAL PRIMARY KEY, name VARCHAR(100), age INT)`,
  );

  // Individual INSERT x100
  const t1 = performance.now();
  for (let i = 0; i < 100; i++) {
    await pool.query(
      `INSERT INTO "${TABLE_RAW_PG}" (name, age) VALUES ($1, $2)`,
      [ROWS[i].name, ROWS[i].age],
    );
  }
  const individualMs = performance.now() - t1;

  // Batch INSERT (single query)
  await pool.query(`DELETE FROM "${TABLE_RAW_PG}"`);
  const params: any[] = [];
  const placeholders = ROWS.map((r, i) => {
    params.push(r.name, r.age);
    return `($${i * 2 + 1}, $${i * 2 + 2})`;
  }).join(", ");
  const t2 = performance.now();
  await pool.query(
    `INSERT INTO "${TABLE_RAW_PG}" (name, age) VALUES ${placeholders}`,
    params,
  );
  const batchMs = performance.now() - t2;

  await pool.query(`DROP TABLE IF EXISTS "${TABLE_RAW_PG}"`);
  await pool.end();
  return { individualMs, batchMs };
}

// ── ORM Benchmarks ─────────────────────────────────────────

async function benchOrmWrite(label: string, dbOpts: any) {
  const EC = makeEntity(TABLE_ORM);
  const em = new EntityManager();
  await em.register({
    ...dbOpts,
    synchronize: true,
    logging: false,
    entities: [EC],
  });
  const repo = em.getRepository(EC);

  // save() x100
  const t1 = performance.now();
  for (let i = 0; i < 100; i++) await repo.save(ROWS[i]);
  const saveMs = performance.now() - t1;

  // insertMany()
  const dropSql =
    dbOpts.type === "mysql"
      ? `DELETE FROM \`${TABLE_ORM}\``
      : `DELETE FROM "${TABLE_ORM}"`;
  await em.query(dropSql);
  const t2 = performance.now();
  await repo.insertMany(ROWS);
  const insertManyMs = performance.now() - t2;

  try {
    await em.query(
      dbOpts.type === "mysql"
        ? `DROP TABLE IF EXISTS \`${TABLE_ORM}\``
        : `DROP TABLE IF EXISTS "${TABLE_ORM}"`,
    );
  } catch {}
  await DatabaseClient.getInstance().close();
  return { saveMs, insertManyMs };
}

async function benchBuffer(label: string, dbOpts: any) {
  const EC = makeEntity(TABLE_BUF);
  const em = new EntityManager();
  await em.register({
    ...dbOpts,
    synchronize: true,
    logging: false,
    entities: [EC],
  });
  em.extend(bufferPlugin());
  const buf = (em as any).buffer();

  const t1 = performance.now();
  for (const row of ROWS) {
    const instance = Object.assign(Object.create(EC.prototype), row);
    buf.persist(instance);
  }
  await buf.flush();
  const bufferMs = performance.now() - t1;

  try {
    await em.query(
      dbOpts.type === "mysql"
        ? `DROP TABLE IF EXISTS \`${TABLE_BUF}\``
        : `DROP TABLE IF EXISTS "${TABLE_BUF}"`,
    );
  } catch {}
  await DatabaseClient.getInstance().close();
  return { bufferMs };
}

// ── ORM Read Benchmarks ────────────────────────────────────

async function benchOrmRead(label: string, dbOpts: any) {
  const EC = makeEntity(TABLE_READ);
  const em = new EntityManager();
  await em.register({
    ...dbOpts,
    synchronize: true,
    logging: false,
    entities: [EC],
  });
  const repo = em.getRepository(EC);

  // Seed 100 rows
  await repo.insertMany(ROWS);

  // find() x100
  const t1 = performance.now();
  for (let i = 0; i < 100; i++) await repo.find();
  const findMs = performance.now() - t1;

  // findOne() x100
  const t2 = performance.now();
  for (let i = 0; i < 100; i++) {
    await repo.findOne({ where: { id: (i % 100) + 1 } as any });
  }
  const findOneMs = performance.now() - t2;

  try {
    await em.query(
      dbOpts.type === "mysql"
        ? `DROP TABLE IF EXISTS \`${TABLE_READ}\``
        : `DROP TABLE IF EXISTS "${TABLE_READ}"`,
    );
  } catch {}
  await DatabaseClient.getInstance().close();
  return { findMs, findOneMs };
}

// ── Main ───────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║       Stingerloom ORM Write Benchmark               ║");
  console.log("║       100 rows INSERT, remote DB                    ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  // ── MariaDB ──────────────────────────────────────────────
  console.log("━━━ MariaDB ━━━\n");

  const rawMy = await benchRawMySQL();
  console.log(`  Raw INSERT x100:       ${fmt(rawMy.individualMs).padStart(8)}  (${perOp(rawMy.individualMs)})`);
  console.log(`  Raw batch INSERT(100): ${fmt(rawMy.batchMs).padStart(8)}  (1 query)`);

  const ormMy = await benchOrmWrite("MariaDB", MY_OPTS);
  console.log(`  ORM save() x100:       ${fmt(ormMy.saveMs).padStart(8)}  (${perOp(ormMy.saveMs)})`);
  console.log(`  ORM insertMany(100):   ${fmt(ormMy.insertManyMs).padStart(8)}  (1 query)`);

  const bufMy = await benchBuffer("MariaDB", MY_OPTS);
  console.log(`  ORM buffer+flush(100): ${fmt(bufMy.bufferMs).padStart(8)}  (batched)`);

  const readMy = await benchOrmRead("MariaDB", MY_OPTS);
  console.log(`  ORM find() x100:       ${fmt(readMy.findMs).padStart(8)}  (${perOp(readMy.findMs)})`);
  console.log(`  ORM findOne() x100:    ${fmt(readMy.findOneMs).padStart(8)}  (${perOp(readMy.findOneMs)})`);

  // ── PostgreSQL ───────────────────────────────────────────
  console.log("\n━━━ PostgreSQL ━━━\n");

  const rawPg = await benchRawPG();
  console.log(`  Raw INSERT x100:       ${fmt(rawPg.individualMs).padStart(8)}  (${perOp(rawPg.individualMs)})`);
  console.log(`  Raw batch INSERT(100): ${fmt(rawPg.batchMs).padStart(8)}  (1 query)`);

  const ormPg = await benchOrmWrite("PostgreSQL", PG_OPTS);
  console.log(`  ORM save() x100:       ${fmt(ormPg.saveMs).padStart(8)}  (${perOp(ormPg.saveMs)})`);
  console.log(`  ORM insertMany(100):   ${fmt(ormPg.insertManyMs).padStart(8)}  (1 query)`);

  const bufPg = await benchBuffer("PostgreSQL", PG_OPTS);
  console.log(`  ORM buffer+flush(100): ${fmt(bufPg.bufferMs).padStart(8)}  (batched)`);

  const readPg = await benchOrmRead("PostgreSQL", PG_OPTS);
  console.log(`  ORM find() x100:       ${fmt(readPg.findMs).padStart(8)}  (${perOp(readPg.findMs)})`);
  console.log(`  ORM findOne() x100:    ${fmt(readPg.findOneMs).padStart(8)}  (${perOp(readPg.findOneMs)})`);

  // ── Summary Table ────────────────────────────────────────
  console.log("\n━━━ Summary ━━━\n");
  console.log("  Method                  │ MariaDB  │ PostgreSQL │ vs Raw batch");
  console.log("  ────────────────────────┼──────────┼────────────┼────────────");
  console.log(`  Raw batch INSERT(100)   │ ${fmt(rawMy.batchMs).padStart(8)} │ ${fmt(rawPg.batchMs).padStart(10)} │ 1.0x`);
  console.log(`  ORM insertMany(100)     │ ${fmt(ormMy.insertManyMs).padStart(8)} │ ${fmt(ormPg.insertManyMs).padStart(10)} │ ${(ormMy.insertManyMs / rawMy.batchMs).toFixed(1)}x / ${(ormPg.insertManyMs / rawPg.batchMs).toFixed(1)}x`);
  console.log(`  ORM buffer+flush(100)   │ ${fmt(bufMy.bufferMs).padStart(8)} │ ${fmt(bufPg.bufferMs).padStart(10)} │ ${(bufMy.bufferMs / rawMy.batchMs).toFixed(1)}x / ${(bufPg.bufferMs / rawPg.batchMs).toFixed(1)}x`);
  console.log(`  Raw INSERT x100         │ ${fmt(rawMy.individualMs).padStart(8)} │ ${fmt(rawPg.individualMs).padStart(10)} │ ${(rawMy.individualMs / rawMy.batchMs).toFixed(1)}x / ${(rawPg.individualMs / rawPg.batchMs).toFixed(1)}x`);
  console.log(`  ORM save() x100         │ ${fmt(ormMy.saveMs).padStart(8)} │ ${fmt(ormPg.saveMs).padStart(10)} │ ${(ormMy.saveMs / rawMy.batchMs).toFixed(1)}x / ${(ormPg.saveMs / rawPg.batchMs).toFixed(1)}x`);
}

main().catch(console.error);
