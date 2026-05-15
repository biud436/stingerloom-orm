/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import sql, { Sql } from "sql-template-tag";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../src/decorators/ManyToOne";

// ── Mock session + DatabaseClient (mirrors soft-delete.test.ts) ──

const mockQuery = jest.fn();
const mockCommit = jest.fn();
const mockRollback = jest.fn();
const mockClose = jest.fn();
const mockConnect = jest.fn();
const mockStartTransaction = jest.fn();

jest.mock("../../src/dialects/TransactionSessionManager", () => ({
  TransactionSessionManager: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    startTransaction: mockStartTransaction,
    query: mockQuery,
    commit: mockCommit,
    rollback: mockRollback,
    close: mockClose,
  })),
}));

const mockDbConnect = jest.fn().mockResolvedValue({ query: jest.fn() });
const mockDbClose = jest.fn();
const mockDbGetConnection = jest.fn();
const mockDbGetOptions = jest.fn().mockReturnValue({ synchronize: false });

jest.mock("../../src/DatabaseClient", () => ({
  DatabaseClient: {
    getInstance: () => ({
      connect: mockDbConnect,
      close: mockDbClose,
      getConnection: mockDbGetConnection,
      getOptions: mockDbGetOptions,
      type: "postgres",
    }),
  },
}));

import { EntityManager } from "../../src/core/EntityManager";

@Entity()
class Issue {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  title!: string;

  @Column({ type: "datetime", nullable: true })
  deletedAt?: Date | null;

  @ManyToOne(() => Issue, (i: Issue) => i.id, { joinColumn: "parent_id" })
  parent?: Issue;

  parentId?: number;
}

async function newPostgresEm(): Promise<EntityManager> {
  const em = new EntityManager();
  await em.connect({
    type: "postgres",
    host: "localhost",
    port: 5432,
    username: "test",
    password: "test",
    database: "testdb",
    entities: [],
  });
  return em;
}

describe("EntityManager.refs() — bulk ref/aliasRef helper", () => {
  let em: EntityManager;

  beforeEach(async () => {
    jest.clearAllMocks();
    em = await newPostgresEm();
  });

  test("Entity spec → SqlRef rendering bare table", () => {
    const [I] = em.refs(Issue);
    const q = sql`SELECT * FROM ${I}`;
    expect(q.sql).toBe(`SELECT * FROM "issue"`);
  });

  test("[Entity, alias] spec → SqlRef rendering 'table AS alias'", () => {
    const [Ic] = em.refs([Issue, "c"] as const);
    const q = sql`SELECT ${Ic.id} FROM ${Ic}`;
    expect(q.sql).toBe(`SELECT c."id" FROM "issue" AS c`);
  });

  test("string spec → AliasRef rendering alias-qualified columns", () => {
    const [p] = em.refs("p");
    const q = sql`JOIN x p ON ${p.id} = 1`;
    // AliasRef renders alias.col, with camelToSnakeCase on the property name.
    // The literal `1` is plain text inside the template — no bind happens.
    expect(q.sql).toBe(`JOIN x p ON p."id" = 1`);
    expect(q.values).toEqual([]);
  });

  test("mixed tuple preserves order and per-position type", () => {
    const [I, Ic, p] = em.refs(Issue, [Issue, "c"] as const, "p");
    const q = sql`
      SELECT ${I.id}, ${Ic.title}, ${p.parentId}
      FROM ${I}
      JOIN ${Ic} ON ${Ic.parentId} = ${I.id}
      JOIN cte p ON ${p.parentId} = ${I.id}
    `;
    // Spot-check fragments rather than the full whitespace-sensitive string:
    expect(q.sql).toContain(`"issue"`); // bare entity ref
    expect(q.sql).toContain(`"issue" AS c`); // aliased entity ref
    expect(q.sql).toContain(`c."title"`); // alias-qualified column
    expect(q.sql).toContain(`p."parent_id"`); // AliasRef camelCase → snake_case
    expect(q.sql).toContain(`c."parent_id" = "id"`); // join predicate
  });

  test("empty refs() call returns []", () => {
    const out = em.refs();
    expect(out).toEqual([]);
  });

  test("returned values behave as Sql fragments inside sql``", () => {
    const [I, p] = em.refs(Issue, "p");
    expect(I).toBeInstanceOf(Sql);
    expect(p).toBeInstanceOf(Sql);
  });
});

describe("EntityManager.query`...` — tagged-template overload", () => {
  let em: EntityManager;

  beforeEach(async () => {
    jest.clearAllMocks();
    em = await newPostgresEm();
    mockQuery.mockResolvedValue({ results: [], fields: [] });
  });

  function lastSqlPayload(): { text: string; values: unknown[] } {
    const call = mockQuery.mock.calls.at(-1);
    expect(call).toBeDefined();
    const arg = call![0];
    if (typeof arg === "string") {
      return { text: arg, values: [] };
    }
    return {
      text: arg.sql ?? arg.text,
      values: arg.values ?? [],
    };
  }

  test("Entity class interpolates as wrapped table identifier (no bind)", async () => {
    await em.query`SELECT * FROM ${Issue}`;
    const { text, values } = lastSqlPayload();
    expect(text).toBe(`SELECT * FROM "issue"`);
    expect(values).toEqual([]);
  });

  test("primitive value interpolates as bound parameter", async () => {
    await em.query`SELECT * FROM ${Issue} WHERE id = ${42}`;
    const { text, values } = lastSqlPayload();
    expect(text).toBe(`SELECT * FROM "issue" WHERE id = ?`);
    expect(values).toEqual([42]);
  });

  test("entity refs and bound values mix in one template", async () => {
    const ref = em.ref(Issue, "i");
    await em.query`SELECT ${ref.id} FROM ${ref} WHERE ${ref.id} = ${7}`;
    const { text, values } = lastSqlPayload();
    expect(text).toBe(`SELECT i."id" FROM "issue" AS i WHERE i."id" = ?`);
    expect(values).toEqual([7]);
  });

  test("nested Sql fragments compose without double-binding", async () => {
    const where = sql`status = ${"open"} AND id > ${10}`;
    await em.query`SELECT * FROM ${Issue} WHERE ${where}`;
    const { text, values } = lastSqlPayload();
    expect(text).toBe(`SELECT * FROM "issue" WHERE status = ? AND id > ?`);
    expect(values).toEqual(["open", 10]);
  });

  test("legacy `query(string, params?)` signature still works", async () => {
    await em.query("SELECT * FROM issue WHERE id = $1", [99]);
    const { text, values } = lastSqlPayload();
    expect(text).toBe("SELECT * FROM issue WHERE id = $1");
    expect(values).toEqual([99]);
  });

  test("legacy `query(Sql)` signature still works", async () => {
    await em.query(sql`SELECT * FROM issue WHERE id = ${5}`);
    const { text, values } = lastSqlPayload();
    expect(text).toBe(`SELECT * FROM issue WHERE id = ?`);
    expect(values).toEqual([5]);
  });
});
