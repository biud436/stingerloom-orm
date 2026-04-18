import "reflect-metadata";
import { SelectQueryBuilder, qAlias } from "../../src/core/SelectQueryBuilder";
import { Entity, PrimaryGeneratedColumn, Column } from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { createDialectExpression } from "../../src/dialects/DialectExpression";
import { coalesce } from "../../src/core/expressions/NullishExpression";
import { isScalarExpression } from "../../src/core/expressions/ScalarExpression";

@Entity()
class Product {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  name!: string;

  @Column({ type: "varchar", length: 100 })
  sku!: string;

  @Column({ type: "int" })
  quantity!: number;

  @Column({ type: "double" })
  price!: number;

  @Column({ type: "int" })
  stock!: number;
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
  const qb = new SelectQueryBuilder<Product>(Product, "p", em);
  const resolver = (em as any).resolver as RelationMetadataResolver;
  const meta = resolver.resolveEntityMetadata(Product);
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

describe("String / numeric / math expressions (QueryDSL Tier 3, Phase 3.1)", () => {
  describe("string methods — ColumnExpression", () => {
    it("toLowerCase → LOWER(col)", () => {
      const p = qAlias(Product, "p");
      expect(createQb().select([p.name.toLowerCase().as("n")]).getSql().text)
        .toContain(`LOWER("p"."name") AS "n"`);
    });

    it("toUpperCase → UPPER(col)", () => {
      const p = qAlias(Product, "p");
      expect(createQb().select([p.name.toUpperCase().as("n")]).getSql().text)
        .toContain(`UPPER("p"."name") AS "n"`);
    });

    it("trim → TRIM(col)", () => {
      const p = qAlias(Product, "p");
      expect(createQb().select([p.name.trim().as("n")]).getSql().text)
        .toContain(`TRIM("p"."name") AS "n"`);
    });

    it("length → CHAR_LENGTH(col)", () => {
      const p = qAlias(Product, "p");
      expect(createQb().select([p.name.length().as("n")]).getSql().text)
        .toContain(`CHAR_LENGTH("p"."name") AS "n"`);
    });

    it("substring(start) → SUBSTR(col, start+1)", () => {
      const p = qAlias(Product, "p");
      const { text, values } = createQb()
        .select([p.name.substring(3).as("s")])
        .getSql();
      expect(text).toContain(`SUBSTR("p"."name", ?)`);
      expect(values).toContain(4);
    });

    it("substring(start, end) → SUBSTR(col, start+1, end-start)", () => {
      const p = qAlias(Product, "p");
      const { text, values } = createQb()
        .select([p.name.substring(2, 5).as("s")])
        .getSql();
      expect(text).toContain(`SUBSTR("p"."name", ?, ?)`);
      expect(values).toContain(3); // start+1
      expect(values).toContain(3); // end-start (same value — length)
    });

    it("concat → CONCAT(col, ...args)", () => {
      const p = qAlias(Product, "p");
      const { text, values } = createQb()
        .select([p.name.concat(" — ", p.sku).as("label")])
        .getSql();
      expect(text).toContain(`CONCAT("p"."name", ?, "p"."sku") AS "label"`);
      expect(values).toContain(" — ");
    });

    it("indexOf → (STRPOS(col, needle) - 1) on PostgreSQL", () => {
      const p = qAlias(Product, "p");
      const { text, values } = createQb("postgresql")
        .select([p.sku.indexOf("-").as("dash")])
        .getSql();
      expect(text).toContain(`(STRPOS("p"."sku", ?) - 1) AS "dash"`);
      expect(values).toContain("-");
    });

    it("indexOf → (LOCATE(needle, col) - 1) on MySQL", () => {
      const p = qAlias(Product, "p");
      const { text } = createQb("mysql")
        .select([p.sku.indexOf("-").as("dash")])
        .getSql();
      expect(text).toContain("(LOCATE(?, `p`.`sku`) - 1) AS `dash`");
    });

    it("indexOf → (INSTR(col, needle) - 1) on SQLite", () => {
      const p = qAlias(Product, "p");
      const { text } = createQb("sqlite")
        .select([p.sku.indexOf("-").as("dash")])
        .getSql();
      expect(text).toContain(`(INSTR("p"."sku", ?) - 1) AS "dash"`);
    });

    it("replace → REPLACE(col, from, to)", () => {
      const p = qAlias(Product, "p");
      const { text, values } = createQb()
        .select([p.name.replace("old", "new").as("n")])
        .getSql();
      expect(text).toContain(`REPLACE("p"."name", ?, ?) AS "n"`);
      expect(values).toEqual(expect.arrayContaining(["old", "new"]));
    });
  });

  describe("numeric arithmetic — ColumnExpression", () => {
    it("add renders (col + ?)", () => {
      const p = qAlias(Product, "p");
      const { text, values } = createQb()
        .select([p.price.add(10).as("adj")])
        .getSql();
      expect(text).toContain(`("p"."price" + ?) AS "adj"`);
      expect(values).toContain(10);
    });

    it("sub / mul / div / mod", () => {
      const p = qAlias(Product, "p");
      const qb = createQb().select([
        p.price.sub(1).as("a"),
        p.quantity.mul(2).as("b"),
        p.price.div(3).as("c"),
        p.quantity.mod(4).as("d"),
      ]);
      const { text } = qb.getSql();
      expect(text).toContain(`("p"."price" - ?)`);
      expect(text).toContain(`("p"."quantity" * ?)`);
      expect(text).toContain(`("p"."price" / ?)`);
      expect(text).toContain(`("p"."quantity" % ?)`);
    });

    it("neg → (-col)", () => {
      const p = qAlias(Product, "p");
      const { text } = createQb().select([p.quantity.neg().as("n")]).getSql();
      expect(text).toContain(`(-"p"."quantity") AS "n"`);
    });

    it("column on both sides — add(col)", () => {
      const p = qAlias(Product, "p");
      const { text } = createQb()
        .select([p.price.add(p.stock).as("total")])
        .getSql();
      expect(text).toContain(`("p"."price" + "p"."stock") AS "total"`);
    });
  });

  describe("math functions — ColumnExpression", () => {
    it("abs / floor / ceil / sqrt", () => {
      const p = qAlias(Product, "p");
      const { text } = createQb()
        .select([
          p.price.abs().as("a"),
          p.price.floor().as("f"),
          p.price.ceil().as("c"),
          p.price.sqrt().as("s"),
        ])
        .getSql();
      expect(text).toContain(`ABS("p"."price")`);
      expect(text).toContain(`FLOOR("p"."price")`);
      expect(text).toContain(`CEIL("p"."price")`);
      expect(text).toContain(`SQRT("p"."price")`);
    });

    it("round() and round(digits)", () => {
      const p = qAlias(Product, "p");
      const { text, values } = createQb()
        .select([p.price.round().as("r1"), p.price.round(2).as("r2")])
        .getSql();
      expect(text).toContain(`ROUND("p"."price") AS "r1"`);
      expect(text).toContain(`ROUND("p"."price", ?) AS "r2"`);
      expect(values).toContain(2);
    });
  });

  describe("ScalarExpression chaining", () => {
    it("chain string fn on a coalesce result", () => {
      const p = qAlias(Product, "p");
      const { text } = createQb()
        .select([coalesce(p.name, "(unnamed)").toUpperCase().as("label")])
        .getSql();
      expect(text).toContain(
        `UPPER(COALESCE("p"."name", ?)) AS "label"`,
      );
    });

    it("chain math after arithmetic", () => {
      const p = qAlias(Product, "p");
      const { text } = createQb()
        .select([p.price.sub(1).abs().as("delta")])
        .getSql();
      expect(text).toContain(`ABS(("p"."price" - ?)) AS "delta"`);
    });

    it("chain trim + toLowerCase on cast result", () => {
      const p = qAlias(Product, "p");
      const qb = createQb()
        .select([p.quantity.stringValue().trim().toLowerCase().as("q")]);
      const { text } = qb.getSql();
      expect(text).toContain(`LOWER(TRIM(CAST("p"."quantity" AS TEXT))) AS "q"`);
    });

    it("scalar .concat() mirrors column behavior", () => {
      const p = qAlias(Product, "p");
      // Start from a coalesce → scalar, then concat
      const expr = coalesce(p.name, "?").concat(" / ", p.sku);
      expect(isScalarExpression(expr)).toBe(true);
      const { text } = createQb().select([expr.as("label")]).getSql();
      expect(text).toContain(`CONCAT(COALESCE("p"."name", ?), ?, "p"."sku") AS "label"`);
    });

    it("scalar .add / .mul chain", () => {
      const p = qAlias(Product, "p");
      const expr = p.price.add(10).mul(2);
      const { text, values } = createQb().select([expr.as("final")]).getSql();
      expect(text).toContain(`(("p"."price" + ?) * ?) AS "final"`);
      expect(values).toEqual(expect.arrayContaining([10, 2]));
    });
  });

  describe("WHERE / HAVING usage", () => {
    it("length().gt(N) filters", () => {
      const p = qAlias(Product, "p");
      const { text, values } = createQb()
        .where(p.name.length().gt(20))
        .getSql();
      expect(text).toContain(`CHAR_LENGTH("p"."name") > ?`);
      expect(values).toContain(20);
    });

    it("toLowerCase().eq() — case-insensitive equality via chain", () => {
      const p = qAlias(Product, "p");
      const { text, values } = createQb()
        .where(p.name.toLowerCase().eq("alice"))
        .getSql();
      expect(text).toContain(`LOWER("p"."name") = ?`);
      expect(values).toContain("alice");
    });

    it("price.mul(0.9).lte(100) — compute on column, compare", () => {
      const p = qAlias(Product, "p");
      const { text, values } = createQb()
        .where(p.price.mul(0.9).lte(100))
        .getSql();
      expect(text).toContain(`("p"."price" * ?) <= ?`);
      expect(values).toEqual(expect.arrayContaining([0.9, 100]));
    });
  });

  describe("Error paths", () => {
    it("indexOf() throws when detached (no dialect)", () => {
      const p = qAlias(Product, "p");
      const expr = p.name.indexOf("x");
      expect(() => expr.renderer((ref) => ref)).toThrow(
        /require.* DialectExpression/,
      );
    });
  });
});
