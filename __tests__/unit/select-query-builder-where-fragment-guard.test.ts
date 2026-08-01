/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import sql, { Sql } from "sql-template-tag";
import { SelectQueryBuilder } from "../../src/core/SelectQueryBuilder";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { Conditions } from "../../src/core/Conditions";
import { Column, Entity, PrimaryGeneratedColumn } from "../../src/decorators";
import { InvalidQueryError } from "../../src/errors/InvalidQueryError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";

@Entity()
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "int" })
  age!: number;

  @Column({ type: "varchar", name: "first_name" })
  firstName!: string;
}

function createMockEm() {
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
      return [] as T[];
    },
  } as unknown as EntityManager;
}

function qb() {
  return new SelectQueryBuilder(User, "u", createMockEm());
}

describe("where()/andWhere()/orWhere() — SQL-fragment string guard (#436)", () => {
  describe("fails fast on raw SQL strings", () => {
    it("rejects the TypeORM-style named-parameter form", () => {
      expect(() => qb().where("u.id = :id", { id: 99 })).toThrow(
        InvalidQueryError,
      );
    });

    it("rejects a lone SQL-fragment string (typing already forbids it — runtime guard for JS users)", () => {
      expect(() => qb().where("u.name = 'Alice'" as any)).toThrow(
        InvalidQueryError,
      );
    });

    it("rejects fragments without spaces (u.id=:id)", () => {
      expect(() => qb().where("u.id=:id", { id: 1 })).toThrow(
        InvalidQueryError,
      );
    });

    it("rejects function-call expressions", () => {
      expect(() => qb().where("LOWER(name)", "alice")).toThrow(
        InvalidQueryError,
      );
    });

    it("andWhere() applies the same guard", () => {
      expect(() => qb().andWhere("age >= 18" as any)).toThrow(
        InvalidQueryError,
      );
    });

    it("orWhere() applies the same guard", () => {
      expect(() =>
        qb().where("name", "Alice").orWhere("age > 30" as any),
      ).toThrow(InvalidQueryError);
    });

    it("carries INVALID_QUERY code and an actionable suggestion", () => {
      try {
        qb().where("u.id = :id", { id: 99 });
        fail("expected InvalidQueryError");
      } catch (e) {
        const err = e as InvalidQueryError;
        expect(err.code).toBe(OrmErrorCode.INVALID_QUERY);
        expect(err.message).toContain("column reference");
        expect(err.suggestion).toContain("Conditions");
        expect(err.suggestion).toContain("sql`");
      }
    });
  });

  describe("plain column references keep working (regression)", () => {
    it("where(column, value) — bare property", () => {
      const built = qb().where("name", "Alice").toSql();
      expect(built.sql).toMatch(/`name`\s*=\s*\?/);
      expect(built.values).toEqual(["Alice"]);
    });

    it("where(column, value) — alias-qualified property", () => {
      const built = qb().where("u.name", "Alice").toSql();
      expect(built.sql).toMatch(/`u`\.`name`\s*=\s*\?/);
    });

    it("where(column, operator, value)", () => {
      const built = qb().where("age", ">=", 18).toSql();
      expect(built.sql).toMatch(/`age`\s*>=\s*\?/);
      expect(built.values).toContain(18);
    });

    it("camelCase and snake_case properties pass the guard (no false positive)", () => {
      const built = qb().where("firstName", "Ann").toSql();
      expect(built.sql).toContain("`firstName`");
      const snake = qb().where("first_name", "Ann").toSql();
      expect(snake.sql).toContain("`first_name`");
    });

    it("chained andWhere/orWhere with column references", () => {
      const built = qb()
        .where("name", "Alice")
        .andWhere("age", ">", 20)
        .orWhere("u.id", 1)
        .toSql();
      expect(built.sql).toContain("OR");
      expect(built.values).toEqual(expect.arrayContaining(["Alice", 20, 1]));
    });
  });

  describe("non-string condition forms are untouched", () => {
    it("sql template tag", () => {
      const built = qb().where(sql`u.id = ${42}`).toSql();
      expect(built.sql).toContain("u.id = ?");
      expect(built.values).toContain(42);
    });

    it("Conditions helper", () => {
      const built = qb().where(Conditions.like("`name`", "%a%")).toSql();
      expect(built.sql).toContain("LIKE");
    });

    it("filter-object form", () => {
      const built = qb().where({ name: "Alice" }).toSql();
      expect(built.values).toContain("Alice");
    });
  });
});
