import "reflect-metadata";
import sql from "sql-template-tag";
import { SelectQueryBuilder, qAlias } from "../../src/core/SelectQueryBuilder";
import { Entity, PrimaryGeneratedColumn, Column } from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { createDialectExpression } from "../../src/dialects/DialectExpression";
import { Expressions } from "../../src/core/expressions/LogicalCondition";
import { rawExpr as raw } from "../../src/core/expressions/RawExpression";
import { isScalarExpression } from "../../src/core/expressions/ScalarExpression";

@Entity()
class Report {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  name!: string;

  @Column({ type: "datetime" })
  createdAt!: Date;

  @Column({ type: "int" })
  count!: number;

  @Column({ type: "int" })
  quantity!: number;
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
  const qb = new SelectQueryBuilder<Report>(Report, "r", em);
  const resolver = (em as any).resolver as RelationMetadataResolver;
  const meta = resolver.resolveEntityMetadata(Report);
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

describe("TS/Node-native helpers (QueryDSL Tier 3, Phase 3.3)", () => {
  describe("Expressions.raw<T>()", () => {
    it("wraps a Sql fragment as a ScalarExpression", () => {
      const expr = raw(sql`CURRENT_TIMESTAMP`);
      expect(isScalarExpression(expr)).toBe(true);
    });

    it("embeds in SELECT via .as()", () => {
      const qb = createQb();
      qb.select([raw(sql`CURRENT_TIMESTAMP`).as("now")]);
      expect(qb.getSql().text).toContain(`CURRENT_TIMESTAMP AS "now"`);
    });

    it("preserves parameter bindings from the template", () => {
      const qb = createQb("postgresql");
      qb.select([
        raw<number>(sql`EXTRACT(epoch FROM (NOW() - INTERVAL ${"1 day"}))`).as("ago"),
      ]);
      const { text, values } = qb.getSql();
      expect(text).toContain("EXTRACT(epoch FROM (NOW() - INTERVAL ?))");
      expect(values).toContain("1 day");
    });

    it("composes with comparison methods (WHERE)", () => {
      const qb = createQb();
      const epoch = raw<number>(sql`EXTRACT(epoch FROM NOW())`);
      qb.where(epoch.gt(1700000000));
      const { text, values } = qb.getSql();
      expect(text).toContain("EXTRACT(epoch FROM NOW()) > ?");
      expect(values).toContain(1700000000);
    });

    it("composes with coalesce()", () => {
      const qb = createQb();
      const rawScore = raw<number>(sql`(count + 10)`);
      qb.select([Expressions.coalesce(rawScore, 0).as("boosted")]);
      const { text } = qb.getSql();
      expect(text).toContain("COALESCE((count + 10), ?)");
    });

    it("Expressions.raw<T>() delegates to the factory", () => {
      expect(isScalarExpression(Expressions.raw<number>(sql`RANDOM()`))).toBe(true);
    });
  });

  describe(".bigintValue()", () => {
    it("PostgreSQL emits CAST(... AS BIGINT)", () => {
      const r = qAlias(Report, "r");
      const { text } = createQb("postgresql")
        .select([r.count.bigintValue().as("c")])
        .getSql();
      expect(text).toContain(`CAST("r"."count" AS BIGINT) AS "c"`);
    });

    it("MySQL emits CAST(... AS SIGNED)", () => {
      const r = qAlias(Report, "r");
      const { text } = createQb("mysql")
        .select([r.count.bigintValue().as("c")])
        .getSql();
      expect(text).toContain("CAST(`r`.`count` AS SIGNED) AS `c`");
    });

    it("SQLite emits CAST(... AS INTEGER)", () => {
      const r = qAlias(Report, "r");
      const { text } = createQb("sqlite")
        .select([r.count.bigintValue().as("c")])
        .getSql();
      expect(text).toContain(`CAST("r"."count" AS INTEGER) AS "c"`);
    });

    it("chains after coalesce — coalesce(col, 0).bigintValue().as()", () => {
      const r = qAlias(Report, "r");
      const { text } = createQb("postgresql")
        .select([
          Expressions.coalesce(r.count, 0).bigintValue().as("total"),
        ])
        .getSql();
      expect(text).toContain(
        `CAST(COALESCE("r"."count", ?) AS BIGINT) AS "total"`,
      );
    });
  });

  describe("qb.selectSchema(schema)", () => {
    it("attaches schema.parse as the row validator", async () => {
      // Mock zod-like schema
      const schema = {
        parse: jest.fn((data: unknown) => data),
      };
      const qb = createQb();
      const ret = qb.selectSchema(schema);
      // Return type narrows — but runtime check: the builder is
      // chainable and the same underlying object.
      expect(ret).toBe(qb);
      expect((qb as any).rowValidator).toBe(schema);
    });

    it("validates rows through schema.parse on getMany-like path", async () => {
      const parse = jest.fn((data: unknown) => data);
      const schema = { parse };
      const qb = createQb();

      qb.selectSchema(schema);
      // Directly exercise the validator path
      const row = { id: 1, name: "hello" };
      const v = (qb as any).rowValidator;
      expect(v).toBeDefined();
      v.parse(row);
      expect(parse).toHaveBeenCalledWith(row);
    });

    it("schema may be a plain function-wrapped object (Zod-compatible shape)", () => {
      type ExpectedRow = { id: number; name: string };
      const schema = {
        parse(data: unknown): ExpectedRow {
          if (typeof data !== "object" || data === null) {
            throw new Error("bad row");
          }
          return data as ExpectedRow;
        },
      };
      const qb = createQb().selectSchema(schema);
      // Subsequent chain methods still work
      expect(typeof qb.getSql).toBe("function");
    });

    it("throws on bad row when invoked", () => {
      const schema = {
        parse(data: unknown) {
          if (typeof data !== "object" || data === null) throw new Error("nope");
          return data;
        },
      };
      const qb = createQb().selectSchema(schema);
      const v = (qb as any).rowValidator;
      expect(() => v.parse(null)).toThrow("nope");
    });
  });

  describe("combination — raw + bigint + schema", () => {
    it("raw expression chained through cast and alias", () => {
      const qb = createQb("postgresql");
      qb.select([
        raw<number>(sql`(count * 2)`).bigintValue().as("doubled"),
      ]);
      const { text } = qb.getSql();
      expect(text).toContain(`CAST((count * 2) AS BIGINT) AS "doubled"`);
    });

    it("raw + coalesce + schema validator", () => {
      const schema = { parse: jest.fn((x: unknown) => x) };
      const qb = createQb();
      qb.select([Expressions.coalesce(raw<number>(sql`(count + 1)`), 0).as("x")])
        .selectSchema(schema);
      expect(qb.getSql().text).toContain("COALESCE((count + 1), ?)");
      expect((qb as any).rowValidator).toBe(schema);
    });
  });
});
