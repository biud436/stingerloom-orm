/**
 * stream() / streamBatch() on a real server (V4-T1-2 ③).
 *
 * Real-driver mirror of sqlite/stream.test.ts — LIMIT/OFFSET batching runs
 * through each server's own dialect (PostgreSQL rejects MySQL's
 * `LIMIT off, cnt` tuple, so the dialect routing is load-bearing here), and
 * the mid-stream abandonment case runs against a real connection pool: each
 * batch is an independent find with its own pooled session, so a `break`
 * must leave nothing checked out. With `pool: { max: 2 }`, two leaked
 * sessions would deadlock every later query — the strongest leak probe the
 * public surface allows.
 *
 * The caller-window cases (`take` / `limit` tuple) are the real-driver
 * fail-before mirror of the overlap defect pinned in the SQLite suite.
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import {
  createTestConnection,
  dropTestTable,
  type TestConnectionResult,
} from "./helpers/test-connection";
import {
  createCrudTestEntity,
  type DynamicEntityResult,
} from "./helpers/create-test-entity";
import { getTestDrivers } from "./helpers/driver-config";

const drivers = getTestDrivers();

const TOTAL_ROWS = 250;

describe.each(drivers)(
  "[Integration] $label: stream() / streamBatch() (V4-T1-2)",
  ({ options }) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let entity: DynamicEntityResult;

    beforeAll(async () => {
      conn = await createTestConnection(
        { ...options, synchronize: true, logging: false, pool: { max: 2 } },
        () => {
          entity = createCrudTestEntity("stream");
          return { entities: [entity.EntityClass] };
        },
      );
      em = conn.em;

      await em.insertMany(
        entity.EntityClass,
        Array.from({ length: TOTAL_ROWS }, (_, i) => ({
          name: `row-${i + 1}`,
          age: i + 1,
        })),
      );
    }, 60000);

    afterAll(async () => {
      if (!conn) return;
      try {
        await dropTestTable(entity.tableName);
      } catch {
        // ignore
      }
      await conn.cleanup();
    }, 15000);

    it("yields every row exactly once, in order, across batch boundaries", async () => {
      const ages: number[] = [];
      for await (const row of em.stream(
        entity.EntityClass,
        { orderBy: { age: "ASC" } as any },
        100,
      )) {
        ages.push((row as any).age);
      }

      expect(ages).toEqual(Array.from({ length: TOTAL_ROWS }, (_, i) => i + 1));
    }, 60000);

    it("streamBatch yields full windows and a correctly-sized tail", async () => {
      const sizes: number[] = [];
      for await (const batch of em.streamBatch(
        entity.EntityClass,
        { orderBy: { age: "ASC" } as any },
        100,
      )) {
        sizes.push(batch.length);
      }

      expect(sizes).toEqual([100, 100, 50]);
    }, 60000);

    it("take larger than the batch size streams exactly take rows", async () => {
      const ages: number[] = [];
      for await (const row of em.stream(
        entity.EntityClass,
        { orderBy: { age: "ASC" } as any, take: 150 },
        100,
      )) {
        ages.push((row as any).age);
      }

      expect(ages).toEqual(Array.from({ length: 150 }, (_, i) => i + 1));
    }, 60000);

    it("a limit tuple defines the stream's window", async () => {
      const ages: number[] = [];
      for await (const row of em.stream(
        entity.EntityClass,
        { orderBy: { age: "ASC" } as any, limit: [50, 120] },
        100,
      )) {
        ages.push((row as any).age);
      }

      expect(ages).toEqual(Array.from({ length: 120 }, (_, i) => i + 51));
    }, 60000);

    it("abandoned streams leak no pooled connections", async () => {
      // Abandon five streams mid-flight on a 2-connection pool…
      for (let i = 0; i < 5; i++) {
        let yielded = 0;
        for await (const _row of em.stream(
          entity.EntityClass,
          { orderBy: { age: "ASC" } as any },
          50,
        )) {
          if (++yielded === 10) break;
        }
      }

      // …then saturate the pool: two concurrent transactions each need their
      // own connection. A single leaked session would make this hang until
      // the jest timeout kills it.
      const [a, b] = await Promise.all([
        em.transaction((tem) => tem.count(entity.EntityClass)),
        em.transaction((tem) => tem.count(entity.EntityClass)),
      ]);

      expect(a).toBe(TOTAL_ROWS);
      expect(b).toBe(TOTAL_ROWS);
    }, 60000);
  },
);
