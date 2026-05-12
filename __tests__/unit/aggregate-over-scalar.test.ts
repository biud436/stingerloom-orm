import "reflect-metadata";
import { Expressions } from "../../src/core/expressions/LogicalCondition";
import { aggregateOver } from "../../src/core/expressions/AggregateExpression";
import { ScalarExpression } from "../../src/core/expressions/ScalarExpression";
import { ColumnExpression } from "../../src/core/SelectQueryBuilder";
import { createDialectExpression } from "../../src/dialects/DialectExpression";
import sql from "sql-template-tag";

const resolvePg = (ref: string): string => {
  if (ref === "*") return "*";
  if (!ref.includes(".")) return `"${ref}"`;
  const [alias, col] = ref.split(".");
  return `"${alias}"."${col}"`;
};

const pg = createDialectExpression("postgres");

describe("aggregateOver / Expressions.{avg,sum,min,max,count}", () => {
  it("wraps a ScalarExpression argument and preserves its bindings", () => {
    const scalar = new ScalarExpression(() => sql`(${42} + 1)`);
    const agg = Expressions.avg(scalar);
    const rendered = agg.renderFunction(resolvePg, pg);
    expect(rendered.sql).toBe("AVG((? + 1))");
    expect(rendered.values).toEqual([42]);
  });

  it("wraps a ColumnExpression as a qualified ref", () => {
    const col = new ColumnExpression("u.score");
    const rendered = Expressions.sum(col).renderFunction(resolvePg, pg);
    expect(rendered.sql).toBe(`SUM("u"."score")`);
    expect(rendered.values).toEqual([]);
  });

  it("wraps a 'alias.col' string", () => {
    const rendered = Expressions.min("u.score").renderFunction(resolvePg, pg);
    expect(rendered.sql).toBe(`MIN("u"."score")`);
  });

  it("count('*') renders COUNT(*) verbatim", () => {
    const rendered = Expressions.count("*").renderFunction(resolvePg, pg);
    expect(rendered.sql).toBe("COUNT(*)");
  });

  // Regression: SelectQueryBuilder's resolveColumn qualifies bare names
  // with the entity alias (`*` → `i."*"`), which MySQL rejected with
  // "Unknown column 'i.*' in 'SELECT'". The wildcard must short-circuit
  // the resolver and emit verbatim regardless of dialect.
  it("count('*') ignores an aliasing resolver", () => {
    const aliasing = (ref: string): string =>
      ref === "*" ? `"i"."*"` : `"i"."${ref}"`;
    const rendered = Expressions.count("*").renderFunction(aliasing, pg);
    expect(rendered.sql).toBe("COUNT(*)");
  });

  it("max takes any expression", () => {
    const cycle = Expressions.dateDiff(
      new ColumnExpression("i.completedAt"),
      new ColumnExpression("i.createdAt"),
      "second",
    );
    const rendered = Expressions.max(cycle).renderFunction(resolvePg, pg);
    expect(rendered.sql).toContain("MAX(");
    expect(rendered.sql).toContain("EXTRACT");
  });

  it("aggregateOver supports DISTINCT", () => {
    const rendered = aggregateOver("COUNT", new ColumnExpression("u.email"), {
      distinct: true,
    }).renderFunction(resolvePg, pg);
    expect(rendered.sql).toBe(`COUNT(DISTINCT "u"."email")`);
  });

  it("argRenderer aggregates carry the .argRenderer marker (used by SelectQueryBuilder routing)", () => {
    const scalar = new ScalarExpression(() => sql`${1}`);
    const agg = Expressions.avg(scalar);
    expect(typeof agg.argRenderer).toBe("function");
  });

  it("aggregateOver().as() returns an alias-bearing AggregateExpression", () => {
    const agg = Expressions.avg("u.score").as("mean");
    expect(agg.alias).toBe("mean");
    expect(typeof agg.argRenderer).toBe("function");
  });
});

describe("AggregateExpression.asc() / .desc() carry a renderer", () => {
  it("aggregate.asc() OrderExpression renders the full FUNC(col) DIR inside windows", () => {
    const u = new ColumnExpression("u.id");
    const order = u.count().desc();
    expect(typeof order.renderer).toBe("function");
    const rendered = order.renderer!(resolvePg, pg);
    expect(rendered.sql).toBe(`COUNT("u"."id")`);
  });
});
