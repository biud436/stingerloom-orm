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
 * QueryDSL Tier 5.1 — PostgreSQL array operators. Exact per-dialect SQL is
 * pinned in the golden-SQL suite; this file covers the operator mapping, the
 * MySQL/SQLite rejection, the no-dialect guard, and the WHERE integration.
 */

const resolvePg = (ref: string): string => {
  if (!ref.includes(".")) return `"${ref}"`;
  const [a, c] = ref.split(".");
  return `"${a}"."${c}"`;
};

const pg = createDialectExpression("postgres");
const mysql = createDialectExpression("mysql");
const sqlite = createDialectExpression("sqlite");

describe("ColumnExpression array operators (Tier 5.1)", () => {
  it("arrayContains → @> with the array bound as one param", () => {
    const out = new ColumnExpression("u.tags")
      .arrayContains(["admin", "beta"])
      .resolve(resolvePg, pg);
    expect(out.sql).toBe('"u"."tags" @> ?');
    expect(out.values).toEqual([["admin", "beta"]]);
  });

  it("arrayOverlaps → &&", () => {
    const out = new ColumnExpression("u.tags")
      .arrayOverlaps(["vip"])
      .resolve(resolvePg, pg);
    expect(out.sql).toBe('"u"."tags" && ?');
    expect(out.values).toEqual([["vip"]]);
  });

  it("arrayContainedBy → <@", () => {
    const out = new ColumnExpression("u.tags")
      .arrayContainedBy(["a", "b"])
      .resolve(resolvePg, pg);
    expect(out.sql).toBe('"u"."tags" <@ ?');
    expect(out.values).toEqual([["a", "b"]]);
  });

  it("rejects MySQL and SQLite with UNSUPPORTED_DATABASE", () => {
    for (const dialect of [mysql, sqlite]) {
      let caught: unknown;
      try {
        new ColumnExpression("u.tags").arrayContains(["x"]).resolve(
          resolvePg,
          dialect,
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(OrmError);
      expect((caught as OrmError).code).toBe(OrmErrorCode.UNSUPPORTED_DATABASE);
    }
  });

  it("throws when no dialect is supplied", () => {
    let caught: unknown;
    try {
      new ColumnExpression("u.tags").arrayContains(["x"]).resolve(resolvePg);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OrmError);
    expect((caught as OrmError).code).toBe(OrmErrorCode.INVALID_QUERY);
  });

  it("negates with .not()", () => {
    const out = new ColumnExpression("u.tags")
      .arrayContains(["admin"])
      .not()
      .resolve(resolvePg, pg);
    expect(out.sql).toBe('NOT ("u"."tags" @> ?)');
    expect(out.values).toEqual([["admin"]]);
  });
});

// ── End-to-end WHERE integration (PostgreSQL) ──

@Entity()
class TaggedUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "array" })
  tags!: string[];
}

function createPgQb(): SelectQueryBuilder<TaggedUser> {
  const resolver = new RelationMetadataResolver();
  const wrap = (col: string): string => `"${col.replace(/"/g, '""')}"`;
  const em = {
    wrap,
    wrapTable: (t: string) => wrap(t),
    resolver,
    _ctx: {
      isMySqlFamily: () => false,
      isPostgres: () => true,
      isSqlite: () => false,
      getDialect: () => "postgresql",
    },
  } as unknown as EntityManager;
  const qb = new SelectQueryBuilder<TaggedUser>(TaggedUser, "u", em);
  const meta = resolver.resolveEntityMetadata(TaggedUser);
  if (meta) {
    const map = new Map<string, string>();
    for (const c of meta.columns) {
      const key = (c as { propertyKey?: string }).propertyKey ?? c.name!;
      map.set(key, c.name!);
    }
    qb.setPropertyToColumnMap(map);
  }
  qb.setDialectExpression(createDialectExpression("postgres"));
  return qb;
}

describe("array operators through SelectQueryBuilder.where()", () => {
  it("emits @> with the array bound", () => {
    const qb = createPgQb();
    const u = qAlias(TaggedUser, "u");
    qb.where(u.tags.arrayContains(["admin", "beta"]));
    const { text, values } = qb.getSql();
    expect(text).toContain('"u"."tags" @> ?');
    expect(values).toEqual([["admin", "beta"]]);
  });
});
