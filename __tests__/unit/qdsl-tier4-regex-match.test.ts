import "reflect-metadata";
import {
  resolveRegex,
  inlineFlagPrefix,
  parseInlineFlags,
} from "../../src/core/expressions/RegexPattern";
import {
  ColumnExpression,
  SelectQueryBuilder,
  qAlias,
} from "../../src/core/SelectQueryBuilder";
import { Entity, PrimaryGeneratedColumn, Column } from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { createDialectExpression } from "../../src/dialects/DialectExpression";

/**
 * QueryDSL Tier 4 — `.matches()` regex predicate. Exact per-dialect SQL is
 * pinned in the golden-SQL suite; this file covers the normalization helpers,
 * the dialect operator split, the no-dialect fallback, and the end-to-end
 * WHERE path through SelectQueryBuilder.
 */

const resolvePg = (ref: string): string => {
  if (!ref.includes(".")) return `"${ref}"`;
  const [a, c] = ref.split(".");
  return `"${a}"."${c}"`;
};

const pg = createDialectExpression("postgres");
const mysql = createDialectExpression("mysql");
const sqlite = createDialectExpression("sqlite");

describe("RegexPattern helpers", () => {
  describe("resolveRegex", () => {
    it("treats a string as a flagless pattern", () => {
      expect(resolveRegex("^abc$")).toEqual({
        pattern: "^abc$",
        caseInsensitive: false,
        multiline: false,
        dotAll: false,
      });
    });

    it("extracts i / m / s flags from a RegExp", () => {
      expect(resolveRegex(/abc/ims)).toEqual({
        pattern: "abc",
        caseInsensitive: true,
        multiline: true,
        dotAll: true,
      });
    });

    it("ignores g / u / y flags (meaningless for a SQL predicate)", () => {
      const r = resolveRegex(/abc/giuy);
      expect(r.caseInsensitive).toBe(true);
      expect(r.multiline).toBe(false);
      expect(r.dotAll).toBe(false);
    });
  });

  describe("inlineFlagPrefix", () => {
    const f = (
      caseInsensitive: boolean,
      multiline: boolean,
      dotAll: boolean,
    ) => ({ caseInsensitive, multiline, dotAll });

    it("returns empty string when no flags are set", () => {
      expect(inlineFlagPrefix(f(false, false, false))).toBe("");
    });
    it("emits letters in i, m, s order", () => {
      expect(inlineFlagPrefix(f(true, false, false))).toBe("(?i)");
      expect(inlineFlagPrefix(f(false, true, false))).toBe("(?m)");
      expect(inlineFlagPrefix(f(false, false, true))).toBe("(?s)");
      expect(inlineFlagPrefix(f(true, true, true))).toBe("(?ims)");
    });
  });

  describe("parseInlineFlags", () => {
    it("splits a leading inline group into JS flags", () => {
      expect(parseInlineFlags("(?i)abc")).toEqual({
        source: "abc",
        jsFlags: "i",
      });
      expect(parseInlineFlags("(?ims)x")).toEqual({
        source: "x",
        jsFlags: "ims",
      });
    });
    it("passes a pattern with no leading group through unchanged", () => {
      expect(parseInlineFlags("^abc$")).toEqual({
        source: "^abc$",
        jsFlags: "",
      });
    });
    it("drops unknown option letters (e.g. PostgreSQL x)", () => {
      expect(parseInlineFlags("(?x)abc")).toEqual({
        source: "abc",
        jsFlags: "",
      });
    });
  });
});

describe("ColumnExpression.matches()", () => {
  it("renders `~` on PostgreSQL with the pattern bound", () => {
    const out = new ColumnExpression("u.email")
      .matches("^admin@")
      .resolve(resolvePg, pg);
    expect(out.sql).toBe('"u"."email" ~ ?');
    expect(out.values).toEqual(["^admin@"]);
  });

  it("renders `REGEXP` on MySQL and SQLite", () => {
    expect(
      new ColumnExpression("u.email").matches("^admin@").resolve(resolvePg, mysql)
        .sql,
    ).toBe('"u"."email" REGEXP ?');
    expect(
      new ColumnExpression("u.email")
        .matches("^admin@")
        .resolve(resolvePg, sqlite).sql,
    ).toBe('"u"."email" REGEXP ?');
  });

  it("carries RegExp flags as an inline prefix on the bound pattern", () => {
    const out = new ColumnExpression("u.title")
      .matches(/typescript/i)
      .resolve(resolvePg, pg);
    expect(out.sql).toBe('"u"."title" ~ ?');
    expect(out.values).toEqual(["(?i)typescript"]);
  });

  it("falls back to REGEXP when no dialect is supplied", () => {
    const out = new ColumnExpression("u.email").matches("^x").resolve(resolvePg);
    expect(out.sql).toBe('"u"."email" REGEXP ?');
    expect(out.values).toEqual(["^x"]);
  });

  it("negates with .not()", () => {
    const out = new ColumnExpression("u.email")
      .matches("^admin@")
      .not()
      .resolve(resolvePg, pg);
    expect(out.sql).toBe('NOT ("u"."email" ~ ?)');
    expect(out.values).toEqual(["^admin@"]);
  });
});

// ── End-to-end WHERE integration ──

@Entity()
class Account {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  email!: string;
}

function createQb(dbType: "postgresql" | "mysql"): SelectQueryBuilder<Account> {
  const resolver = new RelationMetadataResolver();
  const wrap = (col: string): string =>
    dbType === "mysql"
      ? `\`${col.replace(/`/g, "``")}\``
      : `"${col.replace(/"/g, '""')}"`;
  const em = {
    wrap,
    wrapTable: (t: string) => wrap(t),
    resolver,
    _ctx: {
      isMySqlFamily: () => dbType === "mysql",
      isPostgres: () => dbType === "postgresql",
      isSqlite: () => false,
      getDialect: () => (dbType === "mysql" ? "mysql" : "postgresql"),
    },
  } as unknown as EntityManager;
  const qb = new SelectQueryBuilder<Account>(Account, "u", em);
  const meta = resolver.resolveEntityMetadata(Account);
  if (meta) {
    const map = new Map<string, string>();
    for (const c of meta.columns) {
      const key = (c as { propertyKey?: string }).propertyKey ?? c.name!;
      map.set(key, c.name!);
    }
    qb.setPropertyToColumnMap(map);
  }
  qb.setDialectExpression(
    createDialectExpression(dbType === "mysql" ? "mysql" : "postgres"),
  );
  return qb;
}

describe("matches() through SelectQueryBuilder.where()", () => {
  it("emits `~` on PostgreSQL with the bound pattern", () => {
    const qb = createQb("postgresql");
    const u = qAlias(Account, "u");
    qb.where(u.email.matches("^[^@]+@example\\.com$"));
    const { text, values } = qb.getSql();
    expect(text).toContain('"u"."email" ~ ?');
    expect(values).toEqual(["^[^@]+@example\\.com$"]);
  });

  it("emits `REGEXP` on MySQL", () => {
    const qb = createQb("mysql");
    const u = qAlias(Account, "u");
    qb.where(u.email.matches(/admin/i));
    const { text, values } = qb.getSql();
    expect(text).toContain("`u`.`email` REGEXP ?");
    expect(values).toEqual(["(?i)admin"]);
  });
});
