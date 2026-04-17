import "reflect-metadata";
import { SelectQueryBuilder, qAlias } from "../../src/core/SelectQueryBuilder";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
} from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { createDialectExpression } from "../../src/dialects/DialectExpression";
import { escapeLikeValue } from "../../src/core/expressions/likeEscape";

@Entity()
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  name!: string;

  @Column({ type: "varchar", length: 255 })
  email!: string;

  @Column({ type: "varchar", length: 50 })
  username!: string;
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

describe("escapeLikeValue helper", () => {
  it("leaves plain text unchanged", () => {
    expect(escapeLikeValue("hello")).toBe("hello");
  });

  it("escapes %", () => {
    expect(escapeLikeValue("50%")).toBe("50\\%");
  });

  it("escapes _", () => {
    expect(escapeLikeValue("foo_bar")).toBe("foo\\_bar");
  });

  it("escapes backslash", () => {
    expect(escapeLikeValue("a\\b")).toBe("a\\\\b");
  });

  it("escapes combinations", () => {
    expect(escapeLikeValue("50% off_today\\")).toBe("50\\% off\\_today\\\\");
  });
});

describe("ColumnExpression string convenience (Tier 1)", () => {
  describe("startsWith / endsWith / contains (case-sensitive)", () => {
    it("startsWith appends % wildcard and escapes metacharacters", () => {
      const qb = createQb("postgresql");
      const u = qAlias(User, "u");
      qb.where(u.name.startsWith("Al"));
      const { text, values } = qb.getSql();
      // ESCAPE '\' is emitted as a bound parameter for consistent driver
      // handling — pattern first, escape char second.
      expect(values).toEqual(["Al%", "\\"]);
      expect(text).toContain(`"u"."name" LIKE`);
      expect(text).toContain(`ESCAPE`);
    });

    it("startsWith escapes % in user input to literal match", () => {
      const qb = createQb("postgresql");
      const u = qAlias(User, "u");
      qb.where(u.name.startsWith("50%"));
      const { values } = qb.getSql();
      // "50\%%" — backslash escapes the literal %, trailing % is the wildcard
      expect(values).toEqual(["50\\%%", "\\"]);
    });

    it("endsWith prepends % wildcard", () => {
      const qb = createQb("postgresql");
      const u = qAlias(User, "u");
      qb.where(u.name.endsWith("ice"));
      const { values } = qb.getSql();
      expect(values).toEqual(["%ice", "\\"]);
    });

    it("contains wraps in %...%", () => {
      const qb = createQb("postgresql");
      const u = qAlias(User, "u");
      qb.where(u.name.contains("lic"));
      const { values } = qb.getSql();
      expect(values).toEqual(["%lic%", "\\"]);
    });

    it("contains escapes underscores and backslashes", () => {
      const qb = createQb("postgresql");
      const u = qAlias(User, "u");
      qb.where(u.name.contains("a_b\\c"));
      const { values } = qb.getSql();
      expect(values).toEqual(["%a\\_b\\\\c%", "\\"]);
    });
  });

  describe("equalsIgnoreCase", () => {
    it("renders LOWER(col) = LOWER(value) on every dialect", () => {
      for (const db of ["postgresql", "mysql", "sqlite"] as DbType[]) {
        const qb = createQb(db);
        const u = qAlias(User, "u");
        qb.where(u.username.equalsIgnoreCase("alice"));
        const { text, values } = qb.getSql();
        expect(text.toLowerCase()).toContain("lower(");
        expect(values).toContain("alice");
      }
    });
  });

  describe("likeIgnoreCase (dialect-specific)", () => {
    it("PostgreSQL emits ILIKE ... ESCAPE", () => {
      const qb = createQb("postgresql");
      const u = qAlias(User, "u");
      qb.where(u.email.likeIgnoreCase("%@example.com"));
      const { text, values } = qb.getSql();
      expect(text).toContain("ILIKE");
      expect(text).toContain("ESCAPE");
      expect(values).toEqual(["%@example.com", "\\"]);
    });

    it("MySQL falls back to LOWER() LIKE LOWER() ESCAPE", () => {
      const qb = createQb("mysql");
      const u = qAlias(User, "u");
      qb.where(u.email.likeIgnoreCase("%@example.com"));
      const { text } = qb.getSql();
      expect(text).toContain("LOWER(");
      expect(text).toContain("LIKE LOWER(");
      expect(text).toContain("ESCAPE");
      expect(text).not.toContain("ILIKE");
    });

    it("SQLite falls back to LOWER() LIKE LOWER() ESCAPE", () => {
      const qb = createQb("sqlite");
      const u = qAlias(User, "u");
      qb.where(u.email.likeIgnoreCase("%@example.com"));
      const { text } = qb.getSql();
      expect(text).toContain("LOWER(");
      expect(text).toContain("LIKE LOWER(");
    });
  });

  describe("startsWithIgnoreCase / endsWithIgnoreCase / containsIgnoreCase", () => {
    it("startsWithIgnoreCase escapes user input and appends %", () => {
      const qb = createQb("postgresql");
      const u = qAlias(User, "u");
      qb.where(u.email.startsWithIgnoreCase("Al_ice"));
      const { text, values } = qb.getSql();
      expect(text).toContain("ILIKE");
      expect(values).toEqual(["Al\\_ice%", "\\"]);
    });

    it("endsWithIgnoreCase escapes user input and prepends %", () => {
      const qb = createQb("postgresql");
      const u = qAlias(User, "u");
      qb.where(u.email.endsWithIgnoreCase("@Example.com"));
      const { values } = qb.getSql();
      expect(values).toEqual(["%@Example.com", "\\"]);
    });

    it("containsIgnoreCase (Postgres) — ILIKE + ESCAPE", () => {
      const qb = createQb("postgresql");
      const u = qAlias(User, "u");
      qb.where(u.email.containsIgnoreCase("@gmail"));
      const { text, values } = qb.getSql();
      expect(text).toContain("ILIKE");
      expect(values).toEqual(["%@gmail%", "\\"]);
    });

    it("containsIgnoreCase (MySQL) — LOWER/LIKE/LOWER + ESCAPE", () => {
      const qb = createQb("mysql");
      const u = qAlias(User, "u");
      qb.where(u.email.containsIgnoreCase("@gmail"));
      const { text } = qb.getSql();
      expect(text).toMatch(/LOWER\(.+\) LIKE LOWER\(/);
      expect(text).toContain("ESCAPE");
    });
  });

  describe("plain like() vs startsWith — semantic difference", () => {
    it("like(pattern) passes wildcards through verbatim", () => {
      const qb = createQb("postgresql");
      const u = qAlias(User, "u");
      qb.where(u.name.like("%Al%"));
      const { values } = qb.getSql();
      expect(values).toEqual(["%Al%"]);
    });

    it("contains('Al') escapes nothing but wraps with wildcards", () => {
      const qb = createQb("postgresql");
      const u = qAlias(User, "u");
      qb.where(u.name.contains("Al"));
      const { values } = qb.getSql();
      expect(values).toEqual(["%Al%", "\\"]);
    });
  });
});
