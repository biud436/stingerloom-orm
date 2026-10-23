/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * `em.pipe()` inside a transaction on a real PostgreSQL / MySQL (MariaDB):
 * every batch runs on the transaction's connection, so a traversal reads the
 * transaction's own uncommitted writes — as `count()` and `find()` there do —
 * and stays inside its snapshot.
 *
 * SQLite has one connection, so its batches always read the transaction's
 * writes; nothing here would fail there.
 */
import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { rawPipelinePlugin } from "../../src/core/plugin/raw-pipeline";
import {
  createTestConnection,
  dropTestTable,
  rawQuery,
  type TestConnectionResult,
} from "./helpers/test-connection";
import { getTestDrivers, type TestDriverConfig } from "./helpers/driver-config";
import { Entity, Column, PrimaryGeneratedColumn } from "../../src";

function shortName(prefix: string): string {
  return `${prefix}_${String(Date.now()).slice(-7)}`;
}

async function drain(gen: AsyncGenerator<any[]>): Promise<any[]> {
  const rows: any[] = [];
  for await (const batch of gen) rows.push(...batch);
  return rows;
}

const labels = (rows: any[]) => rows.map((r) => String(r.label)).sort();

describe.each(getTestDrivers())(
  "[Integration] $label: em.pipe() inside a transaction",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: any;
    let Note: new () => any;
    const table = shortName("rptx");
    const q = (name: string) => (type === "mysql" ? `\`${name}\`` : `"${name}"`);

    beforeAll(async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          @Entity({ name: table })
          class N {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) label!: string;
          }
          Note = N;
          return { entities: [N] };
        },
      );
      const base: EntityManager = conn.em;
      em = base.extend(rawPipelinePlugin());
    }, 60000);

    beforeEach(async () => {
      await rawQuery(`DELETE FROM ${q(table)}`);
      await em.save(Note, { label: "a" });
      await em.save(Note, { label: "b" });
    });

    afterAll(async () => {
      await dropTestTable(table);
      if (conn) await conn.cleanup();
    }, 30000);

    it("reads the transaction's own uncommitted writes in every batch mode", async () => {
      const seen = await em.transaction(async () => {
        await em.save(Note, { label: "c" });
        await em.delete(Note, { label: "a" });
        return {
          raw: labels(await drain(em.pipe(Note, { batchSize: 1 }).raw())),
          keyset: labels(
            await drain(em.pipe(Note, { orderBy: { id: "ASC" }, keyset: true, batchSize: 1 }).raw()),
          ),
          binary: labels(await drain(em.pipe(Note, { batchSize: 1 }).binary())),
          count: Number(await em.pipe(Note).count()),
        };
      });

      expect(seen).toEqual({ raw: ["b", "c"], keyset: ["b", "c"], binary: ["b", "c"], count: 2 });
    });

    it("leaves nothing behind once the transaction rolls back", async () => {
      await expect(
        em.transaction(async () => {
          await em.save(Note, { label: "c" });
          expect(labels(await em.pipe(Note).collect())).toEqual(["a", "b", "c"]);
          throw new Error("roll back");
        }),
      ).rejects.toThrow("roll back");

      expect(labels(await em.pipe(Note).collect())).toEqual(["a", "b"]);
    });

    it("pages through one snapshot under REPEATABLE READ", async () => {
      const rows = await em.transaction(
        async () => {
          const read: any[] = [];
          for await (const batch of em.pipe(Note, { orderBy: { id: "ASC" }, batchSize: 1 }).raw()) {
            read.push(...batch);
            // Committed by another connection after the snapshot was taken.
            if (read.length === 1) await rawQuery(`INSERT INTO ${q(table)} (label) VALUES ('late')`);
          }
          return read;
        },
        { isolationLevel: "REPEATABLE READ" },
      );

      expect(labels(rows)).toEqual(["a", "b"]);
      expect(labels(await em.pipe(Note).collect())).toEqual(["a", "b", "late"]);
    });
  },
);
