import { ColumnTypeRegistry } from "../../src/core/ColumnTypeRegistry";
import { normalizeDecimalValue } from "../../src/core/DecimalColumnTransformer";
import { assertNumericOptions } from "../../src/dialects/BaseColumnDefinitionBuilder";
import { MySqlColumnDefinitionBuilder } from "../../src/dialects/mysql/MySqlColumnDefinitionBuilder";
import { PostgresColumnDefinitionBuilder } from "../../src/dialects/postgres/PostgresColumnDefinitionBuilder";
import { SqliteColumnDefinitionBuilder } from "../../src/dialects/sqlite/SqliteColumnDefinitionBuilder";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";
import { t } from "../../src/schema";

const at = "Invoice.total";

describe("decimal reads in number mode", () => {
  it.each([
    ["19.90", 19.9],
    ["0.10", 0.1],
    ["100", 100],
    ["-42.50", -42.5],
    ["0.00", 0],
    ["0.0000001", 0.0000001],
    ["99999999.99", 99999999.99],
    ["123456789012345.6", 123456789012345.6],
  ])("reads %s as %s", (text, expected) => {
    expect(normalizeDecimalValue(text, "number", 2, at)).toBe(expected);
  });

  it.each(["12345678901234567.89", "0.12345678901234567890", "1234567890123456789"])(
    "refuses to round %s",
    (text) => {
      expect(() => normalizeDecimalValue(text, "number", 2, at)).toThrow(
        expect.objectContaining({
          code: OrmErrorCode.DECIMAL_PRECISION_LOSS,
          message: expect.stringContaining(`Invoice.total holds ${text}`),
        }),
      );
    },
  );

  it("passes numbers, NULL and non-decimal text through", () => {
    expect(normalizeDecimalValue(19.9, "number", 2, at)).toBe(19.9);
    expect(normalizeDecimalValue(null, "number", 2, at)).toBeNull();
    expect(normalizeDecimalValue(undefined, "number", 2, at)).toBeUndefined();
    expect(normalizeDecimalValue("NaN", "number", 2, at)).toBe("NaN");
  });
});

describe("decimal reads in string mode", () => {
  it("keeps driver text as it is", () => {
    expect(normalizeDecimalValue("12345678901234567.89", "string", 2, at)).toBe(
      "12345678901234567.89",
    );
  });

  it.each([
    [19.9, 2, "19.90"],
    [3, 2, "3.00"],
    [7.5, 4, "7.5000"],
    [1.2345, 2, "1.2345"],
    [-0.5, 2, "-0.50"],
    [42, 0, "42"],
  ])("pads the SQLite number %s to scale %s without rounding", (value, scale, expected) => {
    expect(normalizeDecimalValue(value, "string", scale, at)).toBe(expected);
  });
});

describe("double and decimal DDL", () => {
  const ctx = { tableName: "invoices", columnName: "amount" };
  const builders = [
    ["mysql", new MySqlColumnDefinitionBuilder(), "DOUBLE", "DECIMAL(12, 4)"],
    ["postgres", new PostgresColumnDefinitionBuilder(), "DOUBLE PRECISION", "NUMERIC(12, 4)"],
    ["sqlite", new SqliteColumnDefinitionBuilder(), "REAL", "NUMERIC(12, 4)"],
  ] as const;

  it.each(builders)("%s: double is a float, decimal keeps its precision and scale", (_d, builder, double, decimal) => {
    expect(builder.buildColumnTypeExpr({ type: "double" }, ctx)).toBe(double);
    expect(builder.buildColumnTypeExpr({ type: "decimal", precision: 12, scale: 4 }, ctx)).toBe(decimal);
  });

  it.each(builders)("%s: rejects precision or scale on a double", (_d, builder) => {
    expect(() =>
      builder.buildColumnTypeExpr({ type: "double", precision: 10, scale: 2 }, ctx),
    ).toThrow(
      expect.objectContaining({
        code: OrmErrorCode.INVALID_CONFIG,
        message: expect.stringContaining(
          'Column invoices.amount declares precision 10 and scale 2 on type "double"',
        ),
      }),
    );
    expect(() => builder.buildColumnTypeExpr({ type: "double", scale: 2 }, ctx)).toThrow(
      /declares scale 2 on type "double"/,
    );
  });

  it("rejects precision on an array of doubles", () => {
    expect(() =>
      assertNumericOptions({ type: "array", arrayElementType: "double", precision: 8 }, "t.c"),
    ).toThrow(/declares precision 8 on type "double"/);
  });

  it("leaves a double registered with ColumnTypeRegistry to its registrant", () => {
    const registry = ColumnTypeRegistry.getInstance();
    registry.register("double", { mysql: "DECIMAL(12, 4)", postgres: "NUMERIC(12, 4)", sqlite: "REAL" });
    try {
      expect(() => assertNumericOptions({ type: "double", precision: 12, scale: 4 }, "t.c")).not.toThrow();
    } finally {
      registry.unregister("double");
    }
  });
});

describe("t.decimal()", () => {
  it("declares a decimal column with its precision, scale and mode", () => {
    expect(t.decimal()._def).toMatchObject({ type: "decimal" });
    expect(t.decimal(12, 4)._def).toMatchObject({ type: "decimal", precision: 12, scale: 4 });
    expect(t.decimal(10, 2, { mode: "string" })._def).toMatchObject({
      type: "decimal",
      precision: 10,
      scale: 2,
      decimalMode: "string",
    });
  });
});
