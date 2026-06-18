import "reflect-metadata";
import { SelectQueryBuilder, qAlias } from "../../src/core/SelectQueryBuilder";
import { Entity, PrimaryGeneratedColumn, Column } from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { createDialectExpression } from "../../src/dialects/DialectExpression";

@Entity()
class Order {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "int" })
  price!: number;

  @Column({ type: "int" })
  cost!: number;

  @Column({ type: "int" })
  floorPrice!: number;

  @Column({ type: "int" })
  ceilingPrice!: number;

  @Column({ type: "varchar", length: 50 })
  status!: string;

  @Column({ type: "varchar", length: 50 })
  previousStatus!: string;
}

type DbType = "mysql" | "postgresql";

function createQb(dbType: DbType = "postgresql") {
  const resolver = new RelationMetadataResolver();
  const wrap = (col: string) =>
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
  const qb = new SelectQueryBuilder<Order>(Order, "o", em);
  const meta = resolver.resolveEntityMetadata(Order);
  const map = new Map<string, string>();
  for (const c of meta!.columns) {
    map.set((c as any).propertyKey ?? c.name!, c.name!);
  }
  qb.setPropertyToColumnMap(map);
  qb.setDialectExpression(
    createDialectExpression(dbType === "mysql" ? "mysql" : "postgres"),
  );
  return qb;
}

describe("QueryDSL column-to-column comparison (ColumnExpression RHS)", () => {
  it("eq against another column splices the reference, binds nothing", () => {
    const qb = createQb();
    const o = qAlias(Order, "o");
    qb.where(o.price.eq(o.cost));
    const { text, values } = qb.getSql();
    expect(text).toContain(`WHERE "o"."price" = "o"."cost"`);
    expect(values).toEqual([]);
  });

  it.each(["neq", "gt", "gte", "lt", "lte"] as const)(
    "%s against another column binds nothing",
    (method) => {
      const qb = createQb();
      const o = qAlias(Order, "o");
      qb.where((o.price as any)[method](o.cost));
      const { values } = qb.getSql();
      expect(values).toEqual([]);
    },
  );

  it("gt renders the comparison operator between two column refs", () => {
    const qb = createQb();
    const o = qAlias(Order, "o");
    qb.where(o.price.gt(o.cost));
    const { text } = qb.getSql();
    expect(text).toContain(`"o"."price" > "o"."cost"`);
  });

  it("between with two column bounds binds nothing", () => {
    const qb = createQb();
    const o = qAlias(Order, "o");
    qb.where(o.price.between(o.floorPrice, o.ceilingPrice));
    const { text, values } = qb.getSql();
    expect(text).toContain(
      `"o"."price" BETWEEN "o"."floorPrice" AND "o"."ceilingPrice"`,
    );
    expect(values).toEqual([]);
  });

  it("between mixes a column bound with a literal bound", () => {
    const qb = createQb();
    const o = qAlias(Order, "o");
    qb.where(o.price.between(o.floorPrice, 100));
    const { text, values } = qb.getSql();
    expect(text).toMatch(/"o"\."price" BETWEEN "o"\."floorPrice" AND \?/);
    expect(values).toEqual([100]);
  });

  it("IN mixes a column reference with bound literals", () => {
    const qb = createQb();
    const o = qAlias(Order, "o");
    qb.where(o.status.in([o.previousStatus, "draft"]));
    const { text, values } = qb.getSql();
    expect(text).toMatch(/"o"\."status" IN \("o"\."previousStatus", \?\)/);
    expect(values).toEqual(["draft"]);
  });

  it("NOT IN mixes a column reference with bound literals", () => {
    const qb = createQb();
    const o = qAlias(Order, "o");
    qb.where(o.status.notIn([o.previousStatus, "draft"]));
    const { text, values } = qb.getSql();
    expect(text).toMatch(/"o"\."status" NOT IN \("o"\."previousStatus", \?\)/);
    expect(values).toEqual(["draft"]);
  });

  it("column operand is wrapped in the MySQL identifier quoting", () => {
    const qb = createQb("mysql");
    const o = qAlias(Order, "o");
    qb.where(o.price.gt(o.cost));
    const { text, values } = qb.getSql();
    expect(text).toContain("`o`.`price` > `o`.`cost`");
    expect(values).toEqual([]);
  });

  it("column operand resolves through the alias/naming registry", () => {
    const qb = createQb();
    // Simulate a snake-case naming strategy mapping.
    qb.setPropertyToColumnMap(
      new Map<string, string>([
        ["price", "price"],
        ["floorPrice", "floor_price"],
        ["ceilingPrice", "ceiling_price"],
      ]),
    );
    const o = qAlias(Order, "o");
    qb.where(o.price.between(o.floorPrice, o.ceilingPrice));
    const { text } = qb.getSql();
    expect(text).toContain(
      `"o"."price" BETWEEN "o"."floor_price" AND "o"."ceiling_price"`,
    );
  });
});

describe("QueryDSL scalar-to-column comparison (ScalarCondition RHS)", () => {
  it("scalar expression compared against a column binds only the scalar arg", () => {
    const qb = createQb();
    const o = qAlias(Order, "o");
    qb.where(o.price.mul(2).gt(o.cost));
    const { text, values } = qb.getSql();
    expect(text).toContain(`("o"."price" * ?) > "o"."cost"`);
    expect(values).toEqual([2]);
  });

  it("scalar BETWEEN with column bounds binds only the scalar arg", () => {
    const qb = createQb();
    const o = qAlias(Order, "o");
    qb.where(o.price.add(1).between(o.floorPrice, o.ceilingPrice));
    const { text, values } = qb.getSql();
    expect(text).toContain(
      `("o"."price" + ?) BETWEEN "o"."floorPrice" AND "o"."ceilingPrice"`,
    );
    expect(values).toEqual([1]);
  });

  it("scalar IN mixes a column reference with a bound literal", () => {
    const qb = createQb();
    const o = qAlias(Order, "o");
    qb.where(o.price.add(1).in([o.cost, 5]));
    const { text, values } = qb.getSql();
    expect(text).toMatch(/\("o"\."price" \+ \?\) IN \("o"\."cost", \?\)/);
    expect(values).toEqual([1, 5]);
  });

  it("scalar compared against another scalar inlines both sides", () => {
    const qb = createQb();
    const o = qAlias(Order, "o");
    qb.where(o.price.mul(2).gt(o.cost.add(1)));
    const { text, values } = qb.getSql();
    expect(text).toContain(`("o"."price" * ?) > ("o"."cost" + ?)`);
    expect(values).toEqual([2, 1]);
  });
});

describe("QueryDSL aggregate-to-aggregate comparison (AggregateCondition RHS)", () => {
  it("HAVING relates two aggregates without binding either", () => {
    const qb = createQb();
    const o = qAlias(Order, "o");
    qb.groupBy(["o.status"]).having(o.price.sum().gt(o.cost.sum()));
    const { text, values } = qb.getSql();
    expect(text).toContain(`HAVING SUM("o"."price") > SUM("o"."cost")`);
    expect(values).toEqual([]);
  });

  it("HAVING compares an aggregate against a grouped column", () => {
    const qb = createQb();
    const o = qAlias(Order, "o");
    qb.groupBy(["o.price"]).having(o.cost.max().lte(o.price));
    const { text, values } = qb.getSql();
    expect(text).toContain(`HAVING MAX("o"."cost") <= "o"."price"`);
    expect(values).toEqual([]);
  });

  it("aggregate compared against a literal is still bound", () => {
    const qb = createQb();
    const o = qAlias(Order, "o");
    qb.groupBy(["o.status"]).having(o.id.count().gt(10));
    const { text, values } = qb.getSql();
    expect(text).toMatch(/HAVING COUNT\("o"\."id"\) > \?/);
    expect(values).toEqual([10]);
  });
});

describe("QueryDSL comparison — literal RHS regression", () => {
  it("primitive RHS is still bound as a parameter (ColumnExpression)", () => {
    const qb = createQb();
    const o = qAlias(Order, "o");
    qb.where(o.price.gt(50));
    const { text, values } = qb.getSql();
    expect(text).toMatch(/"o"\."price" > \?/);
    expect(values).toEqual([50]);
  });

  it("primitive IN list is still fully bound", () => {
    const qb = createQb();
    const o = qAlias(Order, "o");
    qb.where(o.status.in(["a", "b"]));
    const { text, values } = qb.getSql();
    expect(text).toMatch(/"o"\."status" IN \(\?, \?\)/);
    expect(values).toEqual(["a", "b"]);
  });

  it("primitive RHS is still bound as a parameter (ScalarCondition)", () => {
    const qb = createQb();
    const o = qAlias(Order, "o");
    qb.where(o.price.add(1).eq(10));
    const { text, values } = qb.getSql();
    expect(text).toContain(`("o"."price" + ?) = ?`);
    expect(values).toEqual([1, 10]);
  });
});
