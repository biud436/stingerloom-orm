import "reflect-metadata";
import {
  ColumnExpression,
  SelectQueryBuilder,
  qAlias,
} from "../../src/core/SelectQueryBuilder";
import { Entity, PrimaryGeneratedColumn, Column } from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { createDialectExpression } from "../../src/dialects/DialectExpression";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";

/**
 * QueryDSL Tier 5.2 — `.matchAgainst()` full-text predicate. Exact per-dialect
 * SQL is pinned in the golden-SQL suite; this file covers the dialect split,
 * the SQLite rejection, the no-dialect guard, and the WHERE integration.
 */

const resolvePg = (ref: string): string => {
  if (!ref.includes(".")) return `"${ref}"`;
  const [a, c] = ref.split(".");
  return `"${a}"."${c}"`;
};

const pg = createDialectExpression("postgres");
const mysql = createDialectExpression("mysql");
const sqlite = createDialectExpression("sqlite");

describe("ColumnExpression.matchAgainst()", () => {
  it("composes the to_tsvector pipeline on PostgreSQL with the query bound", () => {
    const out = new ColumnExpression("a.body")
      .matchAgainst("typescript orm")
      .resolve(resolvePg, pg);
    expect(out.sql).toBe('to_tsvector(?, "a"."body") @@ plainto_tsquery(?, ?)');
    expect(out.values).toEqual(["english", "english", "typescript orm"]);
  });

  it("emits MATCH … AGAINST … BOOLEAN MODE by default on MySQL", () => {
    const out = new ColumnExpression("a.body")
      .matchAgainst("typescript orm")
      .resolve(resolvePg, mysql);
    expect(out.sql).toBe('MATCH("a"."body") AGAINST(? IN BOOLEAN MODE)');
    expect(out.values).toEqual(["typescript orm"]);
  });

  it("honors natural language mode on MySQL", () => {
    const out = new ColumnExpression("a.body")
      .matchAgainst("orm", { mode: "natural" })
      .resolve(resolvePg, mysql);
    expect(out.sql).toBe(
      'MATCH("a"."body") AGAINST(? IN NATURAL LANGUAGE MODE)',
    );
  });

  it("honors a custom language on PostgreSQL", () => {
    const out = new ColumnExpression("a.body")
      .matchAgainst("bonjour", { language: "french" })
      .resolve(resolvePg, pg);
    expect(out.values).toEqual(["french", "french", "bonjour"]);
  });

  it("rejects SQLite with UNSUPPORTED_DATABASE", () => {
    let caught: unknown;
    try {
      new ColumnExpression("a.body").matchAgainst("x").resolve(resolvePg, sqlite);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OrmError);
    expect((caught as OrmError).code).toBe(OrmErrorCode.UNSUPPORTED_DATABASE);
  });

  it("throws when no dialect is supplied (no dialect-agnostic form)", () => {
    let caught: unknown;
    try {
      new ColumnExpression("a.body").matchAgainst("x").resolve(resolvePg);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OrmError);
    expect((caught as OrmError).code).toBe(OrmErrorCode.INVALID_QUERY);
  });

  it("negates with .not()", () => {
    const out = new ColumnExpression("a.body")
      .matchAgainst("spam")
      .not()
      .resolve(resolvePg, mysql);
    expect(out.sql).toBe('NOT (MATCH("a"."body") AGAINST(? IN BOOLEAN MODE))');
  });
});

// ── End-to-end WHERE integration ──

@Entity()
class Article {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "text" })
  body!: string;
}

function createQb(dbType: "postgresql" | "mysql"): SelectQueryBuilder<Article> {
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
  const qb = new SelectQueryBuilder<Article>(Article, "a", em);
  const meta = resolver.resolveEntityMetadata(Article);
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

describe("matchAgainst() through SelectQueryBuilder.where()", () => {
  it("emits the tsvector pipeline on PostgreSQL", () => {
    const qb = createQb("postgresql");
    const a = qAlias(Article, "a");
    qb.where(a.body.matchAgainst("postgres full text"));
    const { text, values } = qb.getSql();
    expect(text).toContain(
      'to_tsvector(?, "a"."body") @@ plainto_tsquery(?, ?)',
    );
    expect(values).toEqual(["english", "english", "postgres full text"]);
  });

  it("emits MATCH … AGAINST on MySQL", () => {
    const qb = createQb("mysql");
    const a = qAlias(Article, "a");
    qb.where(a.body.matchAgainst("mysql fulltext", { mode: "boolean" }));
    const { text, values } = qb.getSql();
    expect(text).toContain("MATCH(`a`.`body`) AGAINST(? IN BOOLEAN MODE)");
    expect(values).toEqual(["mysql fulltext"]);
  });
});
