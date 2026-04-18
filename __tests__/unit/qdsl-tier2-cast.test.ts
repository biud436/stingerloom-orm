import "reflect-metadata";
import { SelectQueryBuilder, qAlias } from "../../src/core/SelectQueryBuilder";
import { Entity, PrimaryGeneratedColumn, Column } from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { createDialectExpression } from "../../src/dialects/DialectExpression";
import { coalesce } from "../../src/core/expressions/NullishExpression";

@Entity()
class Item {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 50 })
  sku!: string;

  @Column({ type: "int" })
  quantity!: number;

  @Column({ type: "double" })
  price!: number;

  @Column({ type: "varchar", length: 10 })
  status!: string;
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
  const qb = new SelectQueryBuilder<Item>(Item, "i", em);
  const resolver = (em as any).resolver as RelationMetadataResolver;
  const meta = resolver.resolveEntityMetadata(Item);
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

describe("CAST expressions (QueryDSL Tier 2)", () => {
  describe("ColumnExpression cast methods", () => {
    it("stringValue() renders CAST(col AS TEXT) on PostgreSQL", () => {
      const i = qAlias(Item, "i");
      const qb = createQb("postgresql");
      qb.select([i.quantity.stringValue().as("qty_str")]);
      expect(qb.getSql().text).toContain(
        `CAST("i"."quantity" AS TEXT) AS "qty_str"`,
      );
    });

    it("stringValue() renders CAST(col AS CHAR) on MySQL", () => {
      const i = qAlias(Item, "i");
      const qb = createQb("mysql");
      qb.select([i.quantity.stringValue().as("qty_str")]);
      expect(qb.getSql().text).toContain(
        "CAST(`i`.`quantity` AS CHAR) AS `qty_str`",
      );
    });

    it("stringValue() renders CAST(col AS TEXT) on SQLite", () => {
      const i = qAlias(Item, "i");
      const qb = createQb("sqlite");
      qb.select([i.quantity.stringValue().as("qty_str")]);
      expect(qb.getSql().text).toContain(
        `CAST("i"."quantity" AS TEXT) AS "qty_str"`,
      );
    });

    it("intValue() renders INTEGER on PG and SIGNED on MySQL", () => {
      const i = qAlias(Item, "i");
      expect(
        createQb("postgresql")
          .select([i.price.intValue().as("p")])
          .getSql().text,
      ).toContain(`CAST("i"."price" AS INTEGER)`);
      expect(
        createQb("mysql").select([i.price.intValue().as("p")]).getSql().text,
      ).toContain("CAST(`i`.`price` AS SIGNED)");
    });

    it("longValue() renders BIGINT on PG and SIGNED on MySQL", () => {
      const i = qAlias(Item, "i");
      expect(
        createQb("postgresql")
          .select([i.price.longValue().as("p")])
          .getSql().text,
      ).toContain(`CAST("i"."price" AS BIGINT)`);
      expect(
        createQb("mysql").select([i.price.longValue().as("p")]).getSql().text,
      ).toContain("CAST(`i`.`price` AS SIGNED)");
    });

    it("floatValue() renders REAL on PG and DECIMAL on MySQL", () => {
      const i = qAlias(Item, "i");
      expect(
        createQb("postgresql")
          .select([i.quantity.floatValue().as("q")])
          .getSql().text,
      ).toContain(`CAST("i"."quantity" AS REAL)`);
      expect(
        createQb("mysql").select([i.quantity.floatValue().as("q")]).getSql().text,
      ).toContain("CAST(`i`.`quantity` AS DECIMAL)");
    });

    it("booleanValue() renders BOOLEAN on PG, UNSIGNED on MySQL, INTEGER on SQLite", () => {
      const i = qAlias(Item, "i");
      expect(
        createQb("postgresql")
          .select([i.quantity.booleanValue().as("b")])
          .getSql().text,
      ).toContain(`CAST("i"."quantity" AS BOOLEAN)`);
      expect(
        createQb("mysql").select([i.quantity.booleanValue().as("b")]).getSql().text,
      ).toContain("CAST(`i`.`quantity` AS UNSIGNED)");
      expect(
        createQb("sqlite").select([i.quantity.booleanValue().as("b")]).getSql().text,
      ).toContain(`CAST("i"."quantity" AS INTEGER)`);
    });
  });

  describe("ScalarExpression cast chaining", () => {
    it("chains CAST onto a coalesce() result", () => {
      const i = qAlias(Item, "i");
      const qb = createQb("postgresql");
      qb.select([coalesce(i.price, 0).floatValue().as("safe_price")]);
      const { text, values } = qb.getSql();
      expect(text).toContain(
        `CAST(COALESCE("i"."price", ?) AS REAL) AS "safe_price"`,
      );
      expect(values).toContain(0);
    });

    it("supports a cast of a cast (uncommon but valid)", () => {
      const i = qAlias(Item, "i");
      const qb = createQb("postgresql");
      qb.select([i.quantity.intValue().stringValue().as("qty_text")]);
      expect(qb.getSql().text).toContain(
        `CAST(CAST("i"."quantity" AS INTEGER) AS TEXT) AS "qty_text"`,
      );
    });
  });

  describe("WHERE / HAVING usage", () => {
    it("cast expressions compare cleanly in WHERE", () => {
      const i = qAlias(Item, "i");
      const qb = createQb("postgresql");
      qb.where(i.sku.intValue().gt(1000));
      const { text, values } = qb.getSql();
      expect(text).toContain(`CAST("i"."sku" AS INTEGER) > ?`);
      expect(values).toContain(1000);
    });

    it("cast is composable with Expressions.and", () => {
      const i = qAlias(Item, "i");
      const qb = createQb("postgresql");
      qb.where(
        i.sku
          .intValue()
          .gt(1000)
          .and(i.quantity.stringValue().eq("100")),
      );
      const { text } = qb.getSql();
      expect(text).toContain(`CAST("i"."sku" AS INTEGER) >`);
      expect(text).toContain(`CAST("i"."quantity" AS TEXT) =`);
      expect(text).toContain(" AND ");
    });
  });

  describe("Error paths", () => {
    it("throws on missing dialect when the expression is detached", () => {
      const i = qAlias(Item, "i");
      const expr = i.quantity.intValue();
      expect(() => expr.renderer((ref) => ref)).toThrow(
        /require.* DialectExpression/,
      );
    });
  });
});
