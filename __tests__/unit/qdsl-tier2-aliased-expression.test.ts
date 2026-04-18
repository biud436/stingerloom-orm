import "reflect-metadata";
import { SelectQueryBuilder, qAlias } from "../../src/core/SelectQueryBuilder";
import {
  AliasedExpression,
  isAliasedExpression,
} from "../../src/core/expressions/AliasedExpression";
import { Entity, PrimaryGeneratedColumn, Column } from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { createDialectExpression } from "../../src/dialects/DialectExpression";

@Entity()
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  name!: string;

  @Column({ type: "varchar", length: 50, nullable: true })
  status!: string | null;

  @Column({ type: "int" })
  age!: number;

  @Column({ type: "json" })
  metadata!: { profile?: { email?: string; score?: number }; tags?: string[] };
}

type DbType = "mysql" | "postgresql" | "sqlite";

function createMockEm(dbType: DbType = "postgresql") {
  const resolver = new RelationMetadataResolver();
  function wrap(col: string) {
    if (dbType === "mysql") return `\`${col.replace(/`/g, "``")}\``;
    return `"${col.replace(/"/g, '""')}"`;
  }
  return {
    wrap,
    wrapTable: (t: string) => wrap(t),
    resolver,
    _ctx: {
      isMySqlFamily: () => dbType === "mysql",
      isPostgres: () => dbType === "postgresql",
      isSqlite: () => dbType === "sqlite",
      getDialect: () =>
        dbType === "mysql" ? "mysql" : dbType === "sqlite" ? "sqlite" : "postgresql",
    },
  } as unknown as EntityManager;
}

function createQb(dbType: DbType = "postgresql") {
  const em = createMockEm(dbType);
  const qb = new SelectQueryBuilder<User>(User, "u", em);
  const resolver = (em as any).resolver as RelationMetadataResolver;
  const meta = resolver.resolveEntityMetadata(User);
  if (meta) {
    const map = new Map<string, string>();
    for (const c of meta.columns) {
      map.set((c as any).propertyKey ?? c.name!, c.name!);
    }
    qb.setPropertyToColumnMap(map);
  }
  const dialectName = dbType === "postgresql" ? "postgres" : dbType;
  qb.setDialectExpression(createDialectExpression(dialectName));
  return qb;
}

describe("AliasedExpression (QueryDSL Tier 2)", () => {
  describe("ColumnExpression.as()", () => {
    it("returns an AliasedExpression carrying the alias", () => {
      const u = qAlias(User, "u");
      const a = u.name.as("n");
      expect(isAliasedExpression(a)).toBe(true);
      expect(a).toBeInstanceOf(AliasedExpression);
      expect(a.alias).toBe("n");
    });

    it("does not mutate the original ColumnExpression", () => {
      const u = qAlias(User, "u");
      const col = u.name;
      col.as("x");
      // subsequent .as() returns independent objects
      const a1 = col.as("a1");
      const a2 = col.as("a2");
      expect(a1.alias).toBe("a1");
      expect(a2.alias).toBe("a2");
      expect(a1).not.toBe(a2);
    });

    it("renderer produces a qualified column reference (no params)", () => {
      const u = qAlias(User, "u");
      const a = u.name.as("n");
      const sql = a.renderer((ref) => {
        const [alias, col] = ref.split(".");
        return `"${alias}"."${col}"`;
      });
      expect(sql.sql).toBe(`"u"."name"`);
      expect(sql.values).toEqual([]);
    });
  });

  describe("JsonPathExpression.as()", () => {
    it("returns an AliasedExpression carrying the alias", () => {
      const u = qAlias(User, "u");
      const a = u.metadata.profile.email.as("contact");
      expect(isAliasedExpression(a)).toBe(true);
      expect(a.alias).toBe("contact");
    });

    it("renderer throws when no dialect is provided", () => {
      const u = qAlias(User, "u");
      const a = u.metadata.profile.email.as("contact");
      expect(() =>
        a.renderer((ref) => `"${ref.replace(".", '"."')}"`),
      ).toThrow(/requires a DialectExpression/);
    });

    it("renderer delegates to the dialect's jsonExtract (PostgreSQL)", () => {
      const u = qAlias(User, "u");
      const a = u.metadata.profile.email.as("contact");
      const dialect = createDialectExpression("postgres");
      const sql = a.renderer(
        (ref) => {
          const [alias, col] = ref.split(".");
          return `"${alias}"."${col}"`;
        },
        dialect,
      );
      // PG uses #>> for text extraction
      expect(sql.sql).toContain("#>>");
    });
  });

  describe("SelectQueryBuilder — select(AliasedExpression)", () => {
    it("renders a single column alias via SELECT", () => {
      const qb = createQb();
      const u = qAlias(User, "u");
      qb.select(u.name.as("display_name"));
      const { text, values } = qb.getSql();
      expect(text).toMatch(/SELECT "u"\."name" AS "display_name"/);
      expect(values).toEqual([]);
    });

    it("renders multiple column aliases", () => {
      const qb = createQb();
      const u = qAlias(User, "u");
      qb.select([u.name.as("n"), u.age.as("years")]);
      const { text } = qb.getSql();
      expect(text).toMatch(
        /SELECT "u"\."name" AS "n", "u"\."age" AS "years"/,
      );
    });

    it("renders DISTINCT with aliased expressions", () => {
      const qb = createQb();
      const u = qAlias(User, "u");
      qb.setDistinct(true).select([u.name.as("n")]);
      const { text } = qb.getSql();
      expect(text).toMatch(/SELECT DISTINCT "u"\."name" AS "n"/);
    });

    it("renders JSON extract with its path bound as a parameter (MySQL)", () => {
      const qb = createQb("mysql");
      const u = qAlias(User, "u");
      qb.select(u.metadata.profile.email.as("email"));
      const { text, values } = qb.getSql();
      expect(text).toContain("JSON_UNQUOTE(JSON_EXTRACT(");
      expect(text).toMatch(/AS `email`/);
      // JSON path is bound, not inlined
      expect(values).toContain("$.profile.email");
    });

    it("renders JSON extract via #>> on PostgreSQL", () => {
      const qb = createQb("postgresql");
      const u = qAlias(User, "u");
      qb.select(u.metadata.profile.email.as("email"));
      const { text } = qb.getSql();
      expect(text).toContain("#>>");
      expect(text).toMatch(/AS "email"/);
    });

    it("mixes AliasedExpression and AggregateExpression in one select()", () => {
      const qb = createQb();
      const u = qAlias(User, "u");
      qb.select([u.name.as("n"), u.id.count().as("total")]);
      const { text } = qb.getSql();
      expect(text).toContain(`"u"."name" AS "n"`);
      expect(text).toContain(`COUNT("u"."id") AS "total"`);
    });
  });

  describe("SelectQueryBuilder — addSelect(AliasedExpression)", () => {
    it("appends an aliased column to an existing SELECT list", () => {
      const qb = createQb();
      const u = qAlias(User, "u");
      qb.select(["id", "name"]);
      qb.addSelect(u.age.as("years"));
      const { text } = qb.getSql();
      expect(text).toMatch(
        /SELECT "u"\."id", "u"\."name", "u"\."age" AS "years"/,
      );
    });

    it("appends a JSON-aliased expression with params preserved", () => {
      const qb = createQb("mysql");
      const u = qAlias(User, "u");
      qb.select(["id"]);
      qb.addSelect(u.metadata.profile.email.as("email"));
      const { text, values } = qb.getSql();
      expect(text).toContain("JSON_UNQUOTE(JSON_EXTRACT(");
      expect(values).toContain("$.profile.email");
    });

    it("appends aliased expression onto the default SELECT *", () => {
      const qb = createQb();
      const u = qAlias(User, "u");
      qb.addSelect(u.name.as("n"));
      const { text } = qb.getSql();
      // SELECT "u".*, "u"."name" AS "n"
      expect(text).toMatch(/"u"\.\*, "u"\."name" AS "n"/);
    });
  });

  describe("clone() preserves aliased projection", () => {
    it("clone mirrors the aliased SELECT list without sharing the array", () => {
      const qb = createQb();
      const u = qAlias(User, "u");
      qb.select([u.name.as("n")]);
      const c = qb.clone();
      const originalSql = qb.getSql().text;
      const cloneSql = c.getSql().text;
      expect(cloneSql).toBe(originalSql);
      // Append a further select to the original — clone should not change
      qb.addSelect(u.age.as("years"));
      expect(c.getSql().text).toBe(originalSql);
    });
  });
});
