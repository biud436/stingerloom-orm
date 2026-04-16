/**
 * Type-level tests for SelectQueryBuilder.
 *
 * These tests verify that the TypeScript compiler correctly narrows the
 * result type when `select()` is called with specific columns.
 *
 * Strict equality is enforced via the `Equal`/`Expect` helpers — `extends`
 * on `T[]` alone is vacuously satisfied by `Pick<T, K>[]`, so we cannot
 * rely on it to detect narrowing regressions.
 */
import "reflect-metadata";
import { SelectQueryBuilder } from "../../src/core/SelectQueryBuilder";
import { Entity, PrimaryGeneratedColumn, Column } from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { CompiledQuery } from "../../src/core/CompiledQuery";

// ── Type-level equality helpers ────────────────────────────────
// (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2)
// yields `true` only when X and Y are strictly identical — covariance
// does not leak, so `Pick<T, K>` is NOT equal to `T`.
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends
  (<T>() => T extends Y ? 1 : 2)
    ? true
    : false;
type Expect<T extends true> = T;

@Entity()
class TestUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar" })
  email!: string;

  @Column({ type: "int" })
  age!: number;

  @Column({ type: "boolean" })
  isActive!: boolean;
}

function createMockEm(): EntityManager {
  const resolver = new RelationMetadataResolver();
  function wrap(col: string) {
    return `"${col.replace(/"/g, '""')}"`;
  }
  return {
    wrap,
    wrapTable(tableName: string) {
      return wrap(tableName);
    },
    resolver,
    _ctx: {
      isMySqlFamily: () => false,
      isPostgres: () => true,
    },
    async query<T>(): Promise<T[]> {
      return [] as T[];
    },
  } as unknown as EntityManager;
}

describe("SelectQueryBuilder type narrowing (strict equality)", () => {
  it("getMany() returns Promise<T[]> by default", () => {
    const em = createMockEm();
    const qb = new SelectQueryBuilder<TestUser, TestUser>(TestUser, "u", em);

    type Actual = ReturnType<typeof qb.getMany>;
    type _ = Expect<Equal<Actual, Promise<TestUser[]>>>;
    expect(true).toBe(true);
  });

  it("getMany() narrows to Promise<Pick<T, K>[]> after select()", () => {
    const em = createMockEm();
    const qb = new SelectQueryBuilder<TestUser, TestUser>(TestUser, "u", em)
      .select(["id", "name"]);

    type Actual = ReturnType<typeof qb.getMany>;
    type _ = Expect<Equal<Actual, Promise<Pick<TestUser, "id" | "name">[]>>>;

    // Sanity: strict equality should reject the wider type.
    type _Reject = Expect<Equal<Equal<Actual, Promise<TestUser[]>>, false>>;
    expect(true).toBe(true);
  });

  it("getOne() narrows to Promise<Pick<T, K> | null>", () => {
    const em = createMockEm();
    const qb = new SelectQueryBuilder<TestUser, TestUser>(TestUser, "u", em)
      .select(["id", "email"]);

    type Actual = ReturnType<typeof qb.getOne>;
    type _ = Expect<Equal<Actual, Promise<Pick<TestUser, "id" | "email"> | null>>>;
    expect(true).toBe(true);
  });

  it("getOneOrFail() narrows to Promise<Pick<T, K>>", () => {
    const em = createMockEm();
    const qb = new SelectQueryBuilder<TestUser, TestUser>(TestUser, "u", em)
      .select(["id", "email"]);

    type Actual = ReturnType<typeof qb.getOneOrFail>;
    type _ = Expect<Equal<Actual, Promise<Pick<TestUser, "id" | "email">>>>;
    expect(true).toBe(true);
  });

  it("getManyAndCount() narrows to Promise<[Pick<T, K>[], number]>", () => {
    const em = createMockEm();
    const qb = new SelectQueryBuilder<TestUser, TestUser>(TestUser, "u", em)
      .select(["id", "age"]);

    type Actual = ReturnType<typeof qb.getManyAndCount>;
    type _ = Expect<Equal<Actual, Promise<[Pick<TestUser, "id" | "age">[], number]>>>;
    expect(true).toBe(true);
  });

  it("getPartialMany() and getPartialOne() narrow to the same shape", () => {
    const em = createMockEm();
    const qb = new SelectQueryBuilder<TestUser, TestUser>(TestUser, "u", em)
      .select(["id", "name"]);

    type ActualMany = ReturnType<typeof qb.getPartialMany>;
    type ActualOne = ReturnType<typeof qb.getPartialOne>;

    type _Many = Expect<Equal<ActualMany, Promise<Pick<TestUser, "id" | "name">[]>>>;
    type _One = Expect<Equal<ActualOne, Promise<Pick<TestUser, "id" | "name"> | null>>>;
    expect(true).toBe(true);
  });

  it("prepare() carries the narrowed TResult into CompiledQuery", () => {
    const em = createMockEm();
    const qb = new SelectQueryBuilder<TestUser, TestUser>(TestUser, "u", em)
      .select(["id", "name"]);

    type Actual = ReturnType<typeof qb.prepare>;
    type Expected = CompiledQuery<Pick<TestUser, "id" | "name">, Record<string, unknown>>;
    type _ = Expect<Equal<Actual, Expected>>;
    expect(true).toBe(true);
  });

  it("select('*') returns the full T shape", () => {
    const em = createMockEm();
    const qb = new SelectQueryBuilder<TestUser, TestUser>(TestUser, "u", em)
      .select("*");

    type Actual = ReturnType<typeof qb.getMany>;
    type _ = Expect<Equal<Actual, Promise<TestUser[]>>>;
    expect(true).toBe(true);
  });
});

describe("SelectQueryBuilder compile-time rejections", () => {
  it("rejects invalid column names in select()", () => {
    const em = createMockEm();
    const qb = new SelectQueryBuilder<TestUser, TestUser>(TestUser, "u", em);

    // @ts-expect-error — "nonexistent" is not a key of TestUser
    qb.select(["id", "nonexistent"]);
  });

  it("rejects invalid column names in orderBy()", () => {
    const em = createMockEm();
    const qb = new SelectQueryBuilder<TestUser, TestUser>(TestUser, "u", em);

    // @ts-expect-error — "nonexistent" is not a key of TestUser
    qb.orderBy({ nonexistent: "ASC" });
  });

  it("allows WHERE/orderBy on unselected columns (full entity is still queryable)", () => {
    const em = createMockEm();

    const qb = new SelectQueryBuilder<TestUser, TestUser>(TestUser, "u", em)
      .select(["id", "name"])
      .where("isActive", true)
      .andWhere("age", ">=", 18)
      .orderBy({ email: "DESC" });

    const { text } = qb.getSql();
    expect(text).toContain('"u"."id"');
    expect(text).toContain('"u"."name"');
    expect(text).toContain('"u"."isActive"');
    expect(text).toContain('"u"."age"');
    expect(text).toContain('"u"."email"');
  });
});

describe("SelectQueryBuilder runtime behavior mirrors type narrowing", () => {
  it("getPartialMany after select returns the narrowed shape (empty mock)", async () => {
    const em = createMockEm();

    const results = await new SelectQueryBuilder<TestUser, TestUser>(TestUser, "u", em)
      .select(["id", "name"])
      .getPartialMany();

    expect(results).toEqual([]);

    const one = await new SelectQueryBuilder<TestUser, TestUser>(TestUser, "u", em)
      .select(["id", "name"])
      .getPartialOne();

    expect(one).toBeNull();
  });

  it("getMany() without select returns empty array (class instances)", async () => {
    const em = createMockEm();

    const entities = await new SelectQueryBuilder<TestUser, TestUser>(TestUser, "u", em)
      .getMany();

    expect(entities).toEqual([]);
  });

  it("getRawMany returns Record<string, unknown>[]", async () => {
    const em = createMockEm();

    const raw = await new SelectQueryBuilder<TestUser, TestUser>(TestUser, "u", em)
      .getRawMany();

    expect(raw).toEqual([]);
  });
});
