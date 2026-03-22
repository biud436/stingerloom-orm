/**
 * Type-level tests for SelectQueryBuilder.
 *
 * These tests verify that the TypeScript compiler correctly narrows
 * the result type when select() is called with specific columns.
 *
 * If the type system is working correctly, all `@ts-expect-error` lines
 * should produce errors, and all other lines should compile fine.
 */
import "reflect-metadata";
import { SelectQueryBuilder } from "../../src/core/SelectQueryBuilder";
import { Entity, PrimaryGeneratedColumn, Column } from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";

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

describe("SelectQueryBuilder type safety", () => {
  it("should narrow result type when select() specifies columns", () => {
    const em = createMockEm();

    // Without select() — result is full TestUser
    const qbFull = new SelectQueryBuilder<TestUser, TestUser>(TestUser, "u", em);
    type FullResult = ReturnType<typeof qbFull.getMany>;
    type AssertFull = FullResult extends Promise<TestUser[]> ? true : false;
    const _checkFull: AssertFull = true;
    expect(_checkFull).toBe(true);

    // With select(["id", "name"]) — result narrows to Pick<TestUser, "id" | "name">
    const qbPartial = new SelectQueryBuilder<TestUser, TestUser>(TestUser, "u", em)
      .select(["id", "name"]);
    type PartialResult = ReturnType<typeof qbPartial.getMany>;
    type ExpectedPartial = Promise<Pick<TestUser, "id" | "name">[]>;
    type AssertPartial = PartialResult extends ExpectedPartial ? true : false;
    const _checkPartial: AssertPartial = true;
    expect(_checkPartial).toBe(true);

    // With select("*") — result is full TestUser
    const qbStar = new SelectQueryBuilder<TestUser, TestUser>(TestUser, "u", em)
      .select("*");
    type StarResult = ReturnType<typeof qbStar.getMany>;
    type AssertStar = StarResult extends Promise<TestUser[]> ? true : false;
    const _checkStar: AssertStar = true;
    expect(_checkStar).toBe(true);
  });

  it("should narrow getOne() return type", () => {
    const em = createMockEm();

    const qb = new SelectQueryBuilder<TestUser, TestUser>(TestUser, "u", em)
      .select(["id", "email"]);

    type OneResult = ReturnType<typeof qb.getOne>;
    type ExpectedOne = Promise<Pick<TestUser, "id" | "email"> | null>;
    type AssertOne = OneResult extends ExpectedOne ? true : false;
    const _check: AssertOne = true;
    expect(_check).toBe(true);
  });

  it("should narrow getManyAndCount() return type", () => {
    const em = createMockEm();

    const qb = new SelectQueryBuilder<TestUser, TestUser>(TestUser, "u", em)
      .select(["id", "age"]);

    type CountResult = ReturnType<typeof qb.getManyAndCount>;
    type ExpectedCount = Promise<[Pick<TestUser, "id" | "age">[], number]>;
    type AssertCount = CountResult extends ExpectedCount ? true : false;
    const _check: AssertCount = true;
    expect(_check).toBe(true);
  });

  it("should allow where/orderBy to reference ALL entity columns after select()", () => {
    const em = createMockEm();

    // Even after select(["id", "name"]), WHERE and ORDER BY should still
    // accept any column from the full entity T — not just the selected ones.
    const qb = new SelectQueryBuilder<TestUser, TestUser>(TestUser, "u", em)
      .select(["id", "name"])
      .where("isActive", true)       // isActive is NOT selected, but valid for WHERE
      .andWhere("age", ">=", 18)     // age is NOT selected, but valid for WHERE
      .orderBy({ email: "DESC" });   // email is NOT selected, but valid for ORDER BY

    const { text } = qb.getSql();
    expect(text).toContain('"u"."id"');
    expect(text).toContain('"u"."name"');
    expect(text).toContain('"u"."isActive"');
    expect(text).toContain('"u"."age"');
    expect(text).toContain('"u"."email"');
  });

  it("should reject invalid column names in select()", () => {
    const em = createMockEm();
    const qb = new SelectQueryBuilder<TestUser, TestUser>(TestUser, "u", em);

    // @ts-expect-error — "nonexistent" is not a key of TestUser
    qb.select(["id", "nonexistent"]);
  });

  it("should reject invalid column names in where()", () => {
    const em = createMockEm();
    const qb = new SelectQueryBuilder<TestUser, TestUser>(TestUser, "u", em);

    // @ts-expect-error — "nonexistent" is not a key of TestUser
    qb.where("nonexistent", "value");
  });

  it("should reject invalid column names in orderBy()", () => {
    const em = createMockEm();
    const qb = new SelectQueryBuilder<TestUser, TestUser>(TestUser, "u", em);

    // @ts-expect-error — "nonexistent" is not a key of TestUser
    qb.orderBy({ nonexistent: "ASC" });
  });

  it("should verify runtime behavior matches type narrowing", async () => {
    const em = createMockEm();

    // With select — getPartialMany returns the narrowed Pick type
    const results = await new SelectQueryBuilder<TestUser, TestUser>(TestUser, "u", em)
      .select(["id", "name"])
      .getPartialMany();

    expect(results).toEqual([]);

    // getPartialOne returns null from empty mock
    const one = await new SelectQueryBuilder<TestUser, TestUser>(TestUser, "u", em)
      .select(["id", "name"])
      .getPartialOne();

    expect(one).toBeNull();

    // getMany without select returns T[] (class instances)
    const entities = await new SelectQueryBuilder<TestUser, TestUser>(TestUser, "u", em)
      .getMany();

    expect(entities).toEqual([]);

    // getRawMany returns Record<string, unknown>[]
    const raw = await new SelectQueryBuilder<TestUser, TestUser>(TestUser, "u", em)
      .getRawMany();

    expect(raw).toEqual([]);
  });
});
