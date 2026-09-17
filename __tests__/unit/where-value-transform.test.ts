import "reflect-metadata";
import { resolveWhereClause } from "../../src/core/WhereResolver";
import {
  attachWhereValueTransform,
  buildWhereValueTransform,
  aggregateFromStored,
} from "../../src/core/WhereValueTransform";
import sql from "../../src/utils/sqlTag";
import type { ColumnMetadata } from "../../src/scanner/ColumnScanner";

class T {}
const col = (over: Partial<ColumnMetadata>): ColumnMetadata =>
  ({ target: T, name: "c", type: String, ...over }) as ColumnMetadata;

const wrapColumn = (n: string) => `"${n}"`;

describe("where value transform", () => {
  const columns = [
    col({
      propertyKey: "unitPrice",
      name: "unit_price",
      transformer: { to: (v: number) => v * 100, from: (v: number) => v / 100 },
    }),
    col({ propertyKey: "meta", name: "meta", options: { type: "json" } as any }),
  ];

  it("is undefined when no column has a write transformer", () => {
    expect(buildWhereValueTransform([columns[1]])).toBeUndefined();
    expect(buildWhereValueTransform(undefined)).toBeUndefined();
  });

  it("resolves by property name and by column name; json default takes no part", () => {
    const t = buildWhereValueTransform(columns)!;
    expect(t("unitPrice", 2)).toBe(200);
    expect(t("unit_price", 2)).toBe(200);
    expect(t("meta", "x")).toBe("x");
  });

  it("reaches the resolver through the attached property map", () => {
    const map = new Map([["unitPrice", "unit_price"]]);
    attachWhereValueTransform(map, columns);
    const [clause] = resolveWhereClause<any>(
      { unitPrice: { gt: 1, in: [1, 2], between: [1, 2], like: "1%" } },
      { wrapColumn, propertyToColumn: map },
    );
    expect(clause.values).toEqual([100, 100, 200, 100, 200, "1%"]);
  });

  it("leaves null, sql fragments and explicit opt-out untouched", () => {
    const map = new Map([["unitPrice", "unit_price"]]);
    attachWhereValueTransform(map, columns);
    const frag = sql`"unit_price" = ${5}`;
    const clauses = resolveWhereClause<any>(
      { AND: [{ unitPrice: null }, { unitPrice: frag }, { unitPrice: { ne: null } }] },
      { wrapColumn, propertyToColumn: map },
    );
    expect(clauses[0].values).toEqual([5]);
    const [plain] = resolveWhereClause<any>(
      { unitPrice: 3 },
      { wrapColumn, propertyToColumn: map, transformValue: (_f, v) => v },
    );
    expect(plain.values).toEqual([3]);
  });

  it("maps aggregates through from, except COUNT and non-numeric results", () => {
    const map = new Map([["unitPrice", "unit_price"]]);
    attachWhereValueTransform(map, columns);
    expect(aggregateFromStored(map, "SUM", "unitPrice", 1250)).toBe(12.5);
    expect(aggregateFromStored(map, "COUNT", "unitPrice", 3)).toBe(3);
    expect(aggregateFromStored(map, "MAX", "meta", 7)).toBe(7);
    const objMap = new Map([["m", "m"]]);
    attachWhereValueTransform(objMap, [
      col({ propertyKey: "m", name: "m", transformer: { to: (v: any) => v, from: (v: any) => ({ v }) } }),
    ]);
    expect(aggregateFromStored(objMap, "MAX", "m", 7)).toBe(7);
  });
});
