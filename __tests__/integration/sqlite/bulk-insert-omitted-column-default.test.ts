/**
 * SQLite In-Memory: a row of a multi-row INSERT that leaves out a column
 * other rows set gets the column's declared default.
 *
 * The batch names a column once any row sets it, and the rows that left it
 * out bound NULL there — a NOT NULL column with a default failed the whole
 * batch, and a nullable one stored NULL instead of its default, unlike the
 * same rows saved one at a time. SQLite has no DEFAULT keyword inside
 * VALUES, so the declared default is written out.
 *
 * PostgreSQL / MySQL: __tests__/integration/bulk-insert-omitted-column-default.test.ts
 */

import "reflect-metadata";
import { createTestConnection, type TestConnectionResult } from "../helpers/test-connection";
import { Entity, Column, PrimaryGeneratedColumn } from "../../../src";

interface TaskRow {
  id: number;
  title: string;
  status: string;
  priority: number | null;
  done: boolean;
  tag: string;
}

describe("[Integration] SQLite: omitted columns in a mixed multi-row INSERT", () => {
  let conn: TestConnectionResult;
  let Task: new () => TaskRow;

  beforeAll(async () => {
    conn = await createTestConnection(
      { type: "sqlite", database: ":memory:", synchronize: true, logging: false },
      () => {
        @Entity({ name: `boc_task_${String(Date.now()).slice(-6)}` })
        class DefaultedTask {
          @PrimaryGeneratedColumn() id!: number;
          @Column({ type: "varchar", length: 40 }) title!: string;
          @Column({ type: "varchar", length: 20, default: "todo" }) status!: string;
          @Column({ type: "int", nullable: true, default: 3 }) priority!: number | null;
          @Column({ type: "boolean", default: false }) done!: boolean;
          @Column({ type: "varchar", length: 30, default: "(lower('NEW'))" }) tag!: string;
        }
        Task = DefaultedTask;
        return { entities: [DefaultedTask] };
      },
    );
  });

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

  const rows = (prefix: string): Partial<TaskRow>[] => [
    { title: `${prefix}-bare` },
    { title: `${prefix}-full`, status: "doing", priority: 1, done: true, tag: "x" },
    { title: `${prefix}-null`, priority: null },
  ];

  async function stored(prefix: string) {
    const found = await conn.em.find(Task, { where: { title: { startsWith: prefix } }, orderBy: { id: "ASC" } });
    return found.map((t) => [t.title, t.status, t.priority, t.done, t.tag]);
  }

  const expected = (prefix: string) => [
    [`${prefix}-bare`, "todo", 3, false, "new"],
    [`${prefix}-full`, "doing", 1, true, "x"],
    [`${prefix}-null`, "todo", null, false, "new"],
  ];

  it("saveMany()", async () => {
    await conn.em.saveMany(Task, rows("sm"));
    expect(await stored("sm")).toEqual(expected("sm"));
  });

  it("insertMany()", async () => {
    await conn.em.insertMany(Task, rows("im"));
    expect(await stored("im")).toEqual(expected("im"));
  });

  it("insertManyAndReturn() returns the defaults it wrote", async () => {
    const returned = await conn.em.insertManyAndReturn(Task, rows("ir"));
    expect(returned.map((t) => [t.title, t.status, t.priority, t.done, t.tag])).toEqual(expected("ir"));
  });

  it("createInsertBuilder()", async () => {
    await conn.em.createInsertBuilder(Task).values(rows("ib")).execute();
    expect(await stored("ib")).toEqual(expected("ib"));
  });
});
