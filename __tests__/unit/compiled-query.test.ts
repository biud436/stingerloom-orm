import "reflect-metadata";
import sql, { Sql } from "sql-template-tag";
import {
  CompiledQuery,
  PlaceholderMarker,
  isPlaceholder,
  p,
} from "../../src/core/CompiledQuery";
import { SelectQueryBuilder } from "../../src/core/SelectQueryBuilder";
import { RawQueryBuilderFactory } from "../../src/core/RawQueryBuilderFactory";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { Column, Entity, PrimaryGeneratedColumn } from "../../src/decorators";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";

@Entity()
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "int" })
  age!: number;
}

@Entity()
class Account {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", name: "full_name" })
  fullName!: string;

  @Column({ type: "boolean", name: "is_active" })
  isActive!: boolean;
}

function createMockEm(captured: { sql?: Sql; calls: number } = { calls: 0 }) {
  const resolver = new RelationMetadataResolver();
  const wrap = (col: string) => `\`${col.replace(/`/g, "``")}\``;
  return {
    wrap,
    wrapTable: (t: string) => wrap(t),
    resolver,
    _ctx: {
      isMySqlFamily: () => true,
      isPostgres: () => false,
      isSqlite: () => false,
    },
    async query<T>(query: Sql): Promise<T[]> {
      captured.sql = query;
      captured.calls++;
      return [] as T[];
    },
    compile(...args: unknown[]) {
      return EntityManager.prototype.compile.apply(this as any, args as any);
    },
  } as unknown as EntityManager;
}

describe("PlaceholderMarker", () => {
  it("p() returns a marker carrying its name", () => {
    const marker = p("userId");
    expect(marker).toBeInstanceOf(PlaceholderMarker);
    expect(marker.name).toBe("userId");
  });

  it("isPlaceholder() identifies markers and rejects plain values", () => {
    expect(isPlaceholder(p("id"))).toBe(true);
    expect(isPlaceholder({})).toBe(false);
    expect(isPlaceholder("id")).toBe(false);
    expect(isPlaceholder(null)).toBe(false);
    expect(isPlaceholder(undefined)).toBe(false);
  });
});

describe("CompiledQuery", () => {
  it("substitutes placeholder values and leaves literals alone", async () => {
    const executor = jest.fn(async (_s: Sql) => [] as unknown[]);
    const cq = new CompiledQuery<{ id: number }, { id: number }>(
      ["SELECT * FROM users WHERE id = ", " AND tenant = ", ""],
      [p("id"), "public"],
      executor,
    );

    await cq.execute({ id: 42 });
    expect(executor).toHaveBeenCalledTimes(1);
    const arg = executor.mock.calls[0][0];
    expect(arg.sql).toBe("SELECT * FROM users WHERE id = ? AND tenant = ?");
    expect(arg.values).toEqual([42, "public"]);
  });

  it("reuses the same strings on repeated execution", async () => {
    const seen: Sql[] = [];
    const executor = async (s: Sql) => {
      seen.push(s);
      return [] as unknown[];
    };
    const cq = new CompiledQuery<unknown, { x: number }>(
      ["SELECT ", ""],
      [p("x")],
      executor,
    );
    await cq.execute({ x: 1 });
    await cq.execute({ x: 2 });
    expect(seen[0].strings).toEqual(seen[1].strings);
    expect(seen[0].values).not.toBe(seen[1].values);
    expect(seen[0].values).toEqual([1]);
    expect(seen[1].values).toEqual([2]);
  });

  it("throws MISSING_PLACEHOLDER when a value is omitted", async () => {
    const cq = new CompiledQuery<unknown, { id: number }>(
      ["x ", ""],
      [p("id")],
      async () => [],
    );
    await expect(cq.execute({} as any)).rejects.toMatchObject({
      code: OrmErrorCode.MISSING_PLACEHOLDER,
    });
  });

  it("executeOne returns first row or null", async () => {
    const cq = new CompiledQuery<number, Record<string, never>>(
      ["SELECT 1"],
      [],
      async () => [10, 20],
    );
    await expect(cq.executeOne()).resolves.toBe(10);

    const empty = new CompiledQuery<number, Record<string, never>>(
      ["SELECT 1"],
      [],
      async () => [],
    );
    await expect(empty.executeOne()).resolves.toBeNull();
  });

  it("executeRaw skips the deserializer", async () => {
    const rawRows = [{ a: 1 }];
    const deserialize = jest.fn(() => [{ deserialized: true }]);
    const cq = new CompiledQuery<unknown, Record<string, never>>(
      ["SELECT 1"],
      [],
      async () => rawRows,
      deserialize as any,
    );
    await expect(cq.executeRaw()).resolves.toBe(rawRows);
    expect(deserialize).not.toHaveBeenCalled();
  });

  it("exposes parameterNames derived from markers", () => {
    const cq = new CompiledQuery<unknown, { a: number; b: string }>(
      ["a=", " b=", " a2=", ""],
      [p("a"), p("b"), p("a")],
      async () => [],
    );
    expect([...cq.parameterNames].sort()).toEqual(["a", "b"]);
  });
});

describe("SelectQueryBuilder.prepare()", () => {
  it("compiles once and reuses the SQL string on repeated execute()", async () => {
    const captured = { calls: 0 } as { sql?: Sql; calls: number };
    const em = createMockEm(captured);
    const qb = new SelectQueryBuilder(User, "u", em).where(
      sql`u.id = ${p("id")}`,
    );
    const compiled = qb.prepare<{ id: number }>();

    await compiled.execute({ id: 1 });
    await compiled.execute({ id: 2 });
    await compiled.execute({ id: 3 });

    expect(captured.calls).toBe(3);
    expect(captured.sql!.sql).toMatch(/WHERE u\.id = \?/);
    expect(captured.sql!.values).toEqual([3]);
  });

  it("is insulated from later builder mutations", async () => {
    const captured = { calls: 0 } as { sql?: Sql; calls: number };
    const em = createMockEm(captured);
    const qb = new SelectQueryBuilder(User, "u", em);
    const compiled = qb.prepare();
    const firstSql = compiled.sql;

    qb.where("u.id = :id", { id: 99 });
    qb.limit(5);

    expect(compiled.sql).toBe(firstSql);
  });
});

describe("SelectQueryBuilder.prepare() — deserialization parity with getMany()", () => {
  // A prepared query must run rows through the same ResultTransformer pipeline
  // as getMany(): NamingStrategy reverse mapping (`is_active` → `isActive`) and
  // column transformers (boolean 0/1 → bool). Previously prepare() called the
  // deserializer directly and skipped both, leaking raw DB column names.
  function createMockEmReturning(rows: any[]) {
    const resolver = new RelationMetadataResolver();
    const wrap = (col: string) => `\`${col.replace(/`/g, "``")}\``;
    return {
      wrap,
      wrapTable: (t: string) => wrap(t),
      resolver,
      _ctx: {
        isMySqlFamily: () => true,
        isPostgres: () => false,
        isSqlite: () => false,
      },
      async query<T>(_query: Sql): Promise<T[]> {
        return rows.map((r) => ({ ...r })) as T[];
      },
    } as unknown as EntityManager;
  }

  it("applies NamingStrategy reverse mapping and column transformers", async () => {
    const rows = [{ id: 1, full_name: "Ann", is_active: 1 }];
    const compiled = new SelectQueryBuilder(Account, "a", createMockEmReturning(rows)).prepare();
    const [row] = await compiled.execute();

    expect(row).toMatchObject({ id: 1, fullName: "Ann", isActive: true });
    // raw DB column names must not leak through
    expect((row as any).full_name).toBeUndefined();
    expect((row as any).is_active).toBeUndefined();
  });

  it("produces the same entities as getMany() for identical rows", async () => {
    const rows = [{ id: 2, full_name: "Bob", is_active: 0 }];
    const fromGetMany = await new SelectQueryBuilder(
      Account,
      "a",
      createMockEmReturning(rows),
    ).getMany();
    const fromPrepare = await new SelectQueryBuilder(
      Account,
      "a",
      createMockEmReturning(rows),
    )
      .prepare()
      .execute();

    expect(fromPrepare).toEqual(fromGetMany);
    expect((fromPrepare[0] as any).isActive).toBe(false);
  });
});

describe("RawQueryBuilder.prepare()", () => {
  it("returns a compiled query that reuses the built SQL", async () => {
    const captured = { calls: 0 } as { sql?: Sql; calls: number };
    const em = createMockEm(captured);
    const qb = RawQueryBuilderFactory.create()
      .select(["id"])
      .from("users")
      .where([sql`id = ${p("id")}`]);

    const compiled = qb.prepare<{ id: number }, { id: number }>(em as any);
    await compiled.execute({ id: 7 });
    await compiled.execute({ id: 8 });

    expect(captured.calls).toBe(2);
    expect(captured.sql!.values).toEqual([8]);
    expect(captured.sql!.sql).toMatch(/WHERE id = \?/);
  });
});

describe("EntityManager.compile()", () => {
  it("builds placeholders via a Proxy and wraps the builder", async () => {
    const captured = { calls: 0 } as { sql?: Sql; calls: number };
    const em = createMockEm(captured);

    const compiled = (em as any).compile(
      (em: any, $: { id: PlaceholderMarker }) =>
        new SelectQueryBuilder(User, "u", em).where(sql`u.id = ${$.id}`),
    );

    await compiled.execute({ id: 17 });
    expect(captured.sql!.values).toEqual([17]);
  });

  it("throws when the callback returns an object without prepare()", () => {
    const em = createMockEm();
    expect(() =>
      (em as any).compile(() => ({})),
    ).toThrow(OrmError);
  });
});
