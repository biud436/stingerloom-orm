/**
 * SQLite In-Memory: batchUpsert() rows that state different columns.
 *
 * The batch was one statement naming every column any row stated, and a row
 * that left one out bound NULL there: a new row lost the column's default,
 * and a conflicting row had its stored value overwritten with NULL. upsert()
 * leaves both alone. The rows are now written one statement per column set.
 *
 * PostgreSQL / MySQL: __tests__/integration/batch-upsert-mixed-columns.test.ts
 */

import "reflect-metadata";
import { createTestConnection, type TestConnectionResult } from "../helpers/test-connection";
import { Entity, Column, PrimaryGeneratedColumn, UniqueIndex } from "../../../src";

interface CounterRow {
  id: number;
  slug: string;
  title: string;
  views: number;
  note: string | null;
}

describe("[Integration] SQLite: batchUpsert() rows that state different columns", () => {
  let conn: TestConnectionResult;
  let Counter: new () => CounterRow;

  beforeAll(async () => {
    conn = await createTestConnection(
      { type: "sqlite", database: ":memory:", synchronize: true, logging: false },
      () => {
        @Entity({ name: `bumc_counter_${String(Date.now()).slice(-6)}` })
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
  });

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

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
});
