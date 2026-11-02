/**
 * batchUpsert() rows that state different columns on a real PostgreSQL /
 * MySQL (MariaDB): a row that leaves a column out keeps the column's default
 * when inserted and the stored value on conflict, as upsert() does.
 *
 * SQLite: __tests__/integration/sqlite/batch-upsert-mixed-columns.test.ts
 */

import "reflect-metadata";
import { createTestConnection, dropTestTable, type TestConnectionResult } from "./helpers/test-connection";
import { getTestDrivers, type TestDriverConfig } from "./helpers/driver-config";
import { Entity, Column, PrimaryGeneratedColumn, UniqueIndex } from "../../src";

interface CounterRow {
  id: number;
  slug: string;
  title: string;
  views: number;
  note: string | null;
}

describe.each(getTestDrivers())(
  "[Integration] $label: batchUpsert() rows that state different columns",
  ({ options }: TestDriverConfig) => {
    const table = `bumc_counter_${String(Date.now()).slice(-6)}`;
    let conn: TestConnectionResult;
    let Counter: new () => CounterRow;

    beforeAll(async () => {
      conn = await createTestConnection(
        { ...options, synchronize: true, logging: false },
        () => {
          @Entity({ name: table })
          @UniqueIndex(["slug"])
          class MixedCounter {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) slug!: string;
            @Column({ type: "varchar", length: 40 }) title!: string;
            @Column({ type: "int", default: 0 }) views!: number;
            @Column({ type: "varchar", length: 40, nullable: true }) note!: string | null;
          }
          Counter = MixedCounter;
          return { entities: [MixedCounter] };
        },
      );
    }, 60000);

    afterAll(async () => {
      try {
        await dropTestTable(table);
      } catch {
        // ignore
      }
      if (conn) await conn.cleanup();
    }, 30000);

    it("leaves a column a row does not state as upsert() would", async () => {
      await conn.em.save(Counter, { slug: "kept", title: "old", views: 7, note: "keep me" });

      const result = await conn.em.batchUpsert(
        Counter,
        [
          { slug: "kept", title: "renamed" },
          { slug: "fresh", title: "new row" },
          { slug: "full", title: "all set", views: 3, note: "n" },
        ],
        ["slug"],
      );

      const rows = await conn.em.find(Counter, { orderBy: { slug: "ASC" } });
      expect(rows.map((r) => [r.slug, r.title, r.views, r.note])).toEqual([
        ["fresh", "new row", 0, null],
        ["full", "all set", 3, "n"],
        ["kept", "renamed", 7, "keep me"],
      ]);
      expect(result.affected).toBeGreaterThanOrEqual(3);
    });
  },
);
