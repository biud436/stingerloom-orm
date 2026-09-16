import sql from "../../src/utils/sqlTag";
import {
  assertScalarBindValue,
  classifyBindValue,
} from "../../src/core/BindValueGuard";
import { p } from "../../src/core/CompiledQuery";
import { InvalidQueryError } from "../../src/errors/InvalidQueryError";

/**
 * `classifyBindValue` decides which values no driver binds as one scalar
 * parameter. The exempt side matters as much as the rejected one: Date,
 * Buffer, `sql` fragments, placeholders and self-serializing class instances
 * (Decimal, Luxon, Temporal) are bound correctly today and must stay legal.
 */
describe("BindValueGuard", () => {
  describe("classifyBindValue", () => {
    it("classifies arrays", () => {
      expect(classifyBindValue([])).toBe("array");
      expect(classifyBindValue(["a", "b"])).toBe("array");
    });

    it("classifies plain, null-prototype and collection objects", () => {
      expect(classifyBindValue({ k: 1 })).toBe("object");
      expect(classifyBindValue(Object.create(null))).toBe("object");
      expect(classifyBindValue(new Map())).toBe("object");
      expect(classifyBindValue(new Set([1]))).toBe("object");
      expect(classifyBindValue(new ArrayBuffer(2))).toBe("object");
    });

    it("classifies a class instance with no serialization hook", () => {
      class MetaDto {
        k = 1;
      }
      expect(classifyBindValue(new MetaDto())).toBe("object");
    });

    it("exempts primitives, Date and binary views", () => {
      for (const value of [null, undefined, "s", 1, 10n, true, Symbol("x")]) {
        expect(classifyBindValue(value)).toBeNull();
      }
      expect(classifyBindValue(new Date())).toBeNull();
      expect(classifyBindValue(Buffer.from("x"))).toBeNull();
      expect(classifyBindValue(new Uint8Array([1]))).toBeNull();
    });

    it("exempts sql fragments and placeholders", () => {
      expect(classifyBindValue(sql`NOW()`)).toBeNull();
      expect(classifyBindValue(sql`id = ${1}`)).toBeNull();
      expect(classifyBindValue(p("id"))).toBeNull();
    });

    /**
     * The CJS and ESM builds each resolve their own sql-template-tag copy, so
     * a fragment built by one fails `instanceof` in the other and is matched
     * on its shape instead.
     */
    it("exempts a fragment from another copy of sql-template-tag", () => {
      class ForeignSql {
        constructor(
          readonly strings: string[],
          readonly values: unknown[],
        ) {}
      }
      expect(classifyBindValue(new ForeignSql(["NOW()"], []))).toBeNull();
      expect(classifyBindValue(new ForeignSql(["id = ", ""], [1]))).toBeNull();
    });

    /**
     * A value that passes the fragment check is spliced into the statement as
     * SQL instead of being bound, so plain data that happens to carry those
     * two keys must stay data.
     */
    it("classifies a plain object shaped like a fragment as an object", () => {
      expect(classifyBindValue({ strings: ["x"], values: [1] })).toBe("object");
      expect(classifyBindValue({ strings: ["NOW()"], values: [] })).toBe("object");
      expect(classifyBindValue({ strings: [1], values: [] })).toBe("object");
      expect(
        classifyBindValue(Object.assign(Object.create(null), { strings: ["x"], values: [] })),
      ).toBe("object");
    });

    it("exempts class instances that serialize themselves", () => {
      class WithToString {
        toString() {
          return "1.50";
        }
      }
      class WithToJson {
        toJSON() {
          return "2026-01-01";
        }
      }
      class WithToPostgres {
        toPostgres() {
          return "(1,2)";
        }
      }
      class WithToSqlString {
        toSqlString() {
          return "POINT(1 2)";
        }
      }
      class WithToPrimitive {
        [Symbol.toPrimitive]() {
          return 42;
        }
      }
      for (const Ctor of [
        WithToString,
        WithToJson,
        WithToPostgres,
        WithToSqlString,
        WithToPrimitive,
      ]) {
        expect(classifyBindValue(new Ctor())).toBeNull();
      }
    });
  });

  describe("assertScalarBindValue", () => {
    it("names the entity key and the driver consequence", () => {
      let caught: unknown;
      try {
        assertScalarBindValue("Doc", "ownerId", [1, 2], () => "sqlite");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(InvalidQueryError);
      expect((caught as Error).message).toContain("Doc.ownerId received an array");
      expect((caught as Error).message).toContain("better-sqlite3 would spread it over 2 values");
    });

    it("names the operation that produced the value", () => {
      let caught: unknown;
      try {
        assertScalarBindValue("Doc", "ownerId", [1], () => "mysql", "updateMany()");
      } catch (err) {
        caught = err;
      }
      expect((caught as Error).message).toContain(
        "Doc.ownerId: updateMany() received an array",
      );
    });

    it("passes scalars without resolving the dialect", () => {
      const dialect = jest.fn(() => "mysql" as const);
      assertScalarBindValue("Doc", "ownerId", 7, dialect);
      assertScalarBindValue("Doc", "ownerId", null, dialect);
      assertScalarBindValue("Doc", "ownerId", new Date(), dialect);
      expect(dialect).not.toHaveBeenCalled();
    });
  });
});
