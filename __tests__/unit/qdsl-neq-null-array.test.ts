import "reflect-metadata";
import {
  ColumnCondition,
  SelectQueryBuilder,
} from "../../src/core/SelectQueryBuilder";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  DeletedAt,
} from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";

/**
 * Regression tests for `.neq()` / `.eq()` null & array normalization.
 *
 * The `=` operator already rewrote `null` → `IS NULL` and arrays → `IN (...)`,
 * but the `!=` / `<>` operators did not — so `.neq(null)` silently produced
 * `col != NULL` (always UNKNOWN → matches nothing) and `.neq([...])` produced a
 * malformed `col != (array)` instead of `NOT IN (...)`. These tests lock in the
 * symmetric rewrite across both the QueryDSL (`ColumnCondition`) path and the
 * explicit string-operator `where(col, op, value)` path.
 */

const resolve = (ref: string): string => {
  if (!ref.includes(".")) return `"${ref}"`;
  const [a, c] = ref.split(".");
  return `"${a}"."${c}"`;
};

describe("QueryDSL ColumnCondition — null & array normalization", () => {
  describe("not-equals with null → IS NOT NULL", () => {
    it("neq(null) emits IS NOT NULL, not '!= NULL'", () => {
      const r = new ColumnCondition("u.deletedAt", "!=", null).resolve(resolve);
      expect(r.sql).toBe(`"u"."deletedAt" IS NOT NULL`);
      expect(r.values).toEqual([]);
    });

    it("the '<>' alias also emits IS NOT NULL", () => {
      const r = new ColumnCondition("u.deletedAt", "<>", null).resolve(resolve);
      expect(r.sql).toBe(`"u"."deletedAt" IS NOT NULL`);
      expect(r.values).toEqual([]);
    });

    it("eq(null) still emits IS NULL (unchanged, kept symmetric)", () => {
      const r = new ColumnCondition("u.deletedAt", "=", null).resolve(resolve);
      expect(r.sql).toBe(`"u"."deletedAt" IS NULL`);
      expect(r.values).toEqual([]);
    });
  });

  describe("not-equals with array → NOT IN", () => {
    it("neq([...]) emits NOT IN (...)", () => {
      const r = new ColumnCondition("u.status", "!=", ["a", "b"]).resolve(
        resolve,
      );
      expect(r.sql).toBe(`"u"."status" NOT IN (?, ?)`);
      expect(r.values).toEqual(["a", "b"]);
    });

    it("eq([...]) still emits IN (...) (unchanged, kept symmetric)", () => {
      const r = new ColumnCondition("u.status", "=", ["a", "b"]).resolve(
        resolve,
      );
      expect(r.sql).toBe(`"u"."status" IN (?, ?)`);
      expect(r.values).toEqual(["a", "b"]);
    });

    it("neq([]) excludes nothing (1 = 1), mirroring Conditions.notIn", () => {
      const r = new ColumnCondition("u.status", "!=", []).resolve(resolve);
      expect(r.sql).toBe(`1 = 1`);
    });

    it("eq([]) matches nothing (1 = 0), mirroring Conditions.in", () => {
      const r = new ColumnCondition("u.status", "=", []).resolve(resolve);
      expect(r.sql).toBe(`1 = 0`);
    });
  });

  describe("scalar not-equals is unchanged", () => {
    it("neq(scalar) still emits '!= ?' with a bound param", () => {
      const r = new ColumnCondition("u.status", "!=", "active").resolve(resolve);
      expect(r.sql).toBe(`"u"."status" != ?`);
      expect(r.values).toEqual(["active"]);
    });
  });
});

@Entity()
class NullUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 50 })
  status!: string;

  @DeletedAt()
  deletedAt!: Date | null;
}

function createMockEm(dbType: "mysql" | "postgresql" = "mysql") {
  const resolver = new RelationMetadataResolver();
  function wrap(col: string) {
    return dbType === "mysql"
      ? `\`${col.replace(/`/g, "``")}\``
      : `"${col.replace(/"/g, '""')}"`;
  }
  const em = {
    wrap,
    wrapTable: (t: string) => wrap(t),
    resolver,
    _ctx: {
      isMySqlFamily: () => dbType === "mysql",
      isPostgres: () => dbType === "postgresql",
      isSqlite: () => false,
    },
    async query<T>(): Promise<T[]> {
      return [] as T[];
    },
    createQueryBuilder(entity: any, alias: string) {
      const qb = new SelectQueryBuilder(entity, alias, em as any);
      const meta = resolver.resolveEntityMetadata(entity);
      if (meta) {
        const map = new Map<string, string>();
        for (const col of meta.columns) {
          map.set((col as any).propertyKey ?? col.name!, col.name!);
        }
        qb.setPropertyToColumnMap(map);
      }
      return qb;
    },
  } as unknown as EntityManager;
  return em;
}

describe("SelectQueryBuilder.where(col, op, null) — explicit operator path", () => {
  it("where(col, '!=', null) rewrites to IS NOT NULL", () => {
    const em = createMockEm("mysql");
    const { text, values } = em
      .createQueryBuilder(NullUser, "u")
      .where("deletedAt", "!=", null)
      .getSql();

    expect(text).toContain("IS NOT NULL");
    expect(text).not.toContain("!= NULL");
    expect(values).not.toContain(null);
  });

  it("where(col, '<>', null) rewrites to IS NOT NULL", () => {
    const em = createMockEm("mysql");
    const { text } = em
      .createQueryBuilder(NullUser, "u")
      .where("deletedAt", "<>", null)
      .getSql();

    expect(text).toContain("IS NOT NULL");
  });

  it("where(col, '=', null) rewrites to IS NULL (matches two-arg shorthand)", () => {
    const em = createMockEm("mysql");
    const { text } = em
      .createQueryBuilder(NullUser, "u")
      .where("deletedAt", "=", null)
      .getSql();

    expect(text).toContain("IS NULL");
    expect(text).not.toContain("= NULL");
  });
});
