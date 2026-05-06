import "reflect-metadata";
import { SelectQueryBuilder, qAlias } from "../../src/core/SelectQueryBuilder";
import { Entity, PrimaryGeneratedColumn, Column } from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { createDialectExpression } from "../../src/dialects/DialectExpression";

@Entity()
class IssueDoc {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  title!: string;

  @Column({ type: "int" })
  priority!: number;

  @Column({ type: "json", nullable: true })
  customFields!: Record<string, unknown> | null;
}

function createQb(dbType: "mysql" | "postgresql" = "postgresql") {
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
  const qb = new SelectQueryBuilder<IssueDoc>(IssueDoc, "i", em);
  const meta = resolver.resolveEntityMetadata(IssueDoc);
  if (meta) {
    const map = new Map<string, string>();
    for (const c of meta.columns) {
      map.set((c as any).propertyKey ?? c.name!, c.name!);
    }
    qb.setPropertyToColumnMap(map);
  }
  qb.setDialectExpression(
    createDialectExpression(dbType === "mysql" ? "mysql" : "postgres"),
  );
  return qb;
}

describe("qAlias dynamic field accessors", () => {
  it("field(name) returns a typed ColumnExpression callable like a static prop", () => {
    const i = qAlias(IssueDoc, "i");
    const qb = createQb("postgresql");

    const built = qb.where(i.field("priority").eq(3)).toSql();
    expect(built.text).toMatch(/"i"\."priority" = \$\d+/);
    expect(built.values).toContain(3);
  });

  it("field(name) supports comparison operators (lt/gte/in)", () => {
    const i = qAlias(IssueDoc, "i");
    const qb = createQb("postgresql");

    const built = qb
      .where(i.field("priority").gte(2))
      .andWhere(i.field("id").in([1, 2, 3]))
      .toSql();
    expect(built.text).toContain('"i"."priority" >=');
    expect(built.text).toContain('"i"."id" IN');
    expect(built.values).toEqual(expect.arrayContaining([2, 1, 2, 3]));
  });

  it("jsonField(name) returns a JsonPathExpression that supports path traversal", () => {
    const i = qAlias(IssueDoc, "i");
    const qb = createQb("postgresql");

    let json = i.jsonField("customFields");
    json = json["category"];
    const built = qb.where(json.eq("backend")).toSql();
    // Postgres uses ->/->> operators on json/jsonb columns. Path segments
    // and the comparison value are both parameterized.
    expect(built.text).toContain('"i"."customFields"');
    expect(built.text).toContain("->>");
    expect(built.values).toEqual(expect.arrayContaining(["category", "backend"]));
  });

  it("jsonField(name) on an unknown column still yields a usable expression", () => {
    const i = qAlias(IssueDoc, "i");
    // Unknown column name — proxy falls back to a default JSON path.
    expect(() => i.jsonField("notARealColumn")).not.toThrow();
  });

  it("static property access still works alongside field()", () => {
    const i = qAlias(IssueDoc, "i");
    const qb = createQb("postgresql");

    const built = qb
      .where(i.priority.eq(1))
      .andWhere(i.field("title").like("%bug%"))
      .toSql();
    expect(built.text).toContain('"i"."priority" =');
    expect(built.text).toContain('"i"."title" LIKE');
  });
});
