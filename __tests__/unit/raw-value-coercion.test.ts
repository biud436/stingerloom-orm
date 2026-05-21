/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import {
  coerceRow,
  coerceRows,
  type CoerceType,
} from "../../src/core/RawValueCoercion";

/** Coerce a single value through the public coerceRow API. */
function coerce(value: unknown, type: CoerceType): unknown {
  return (coerceRow({ v: value }, { v: type }) as { v: unknown }).v;
}

describe("RawValueCoercion", () => {
  // ── number ────────────────────────────────────────────────────────────
  describe('coerce "number"', () => {
    it("converts a mysql2 BIGINT-as-string to a number", () => {
      // mysql2 surfaces BIGINT columns as strings.
      expect(coerce("9007199254740", "number")).toBe(9007199254740);
    });

    it("converts a pg DECIMAL/NUMERIC-as-string to a number", () => {
      // both the pg and mysql2 drivers return DECIMAL/NUMERIC as strings.
      expect(coerce("12.50", "number")).toBe(12.5);
      expect(coerce("0.00", "number")).toBe(0);
      expect(coerce("-3.75", "number")).toBe(-3.75);
    });

    it("passes an existing number through unchanged", () => {
      expect(coerce(42, "number")).toBe(42);
      expect(coerce(0, "number")).toBe(0);
    });

    it("coerces an integer string", () => {
      expect(coerce("100", "number")).toBe(100);
    });
  });

  // ── bigint ────────────────────────────────────────────────────────────
  describe('coerce "bigint"', () => {
    it("converts an integer string to a bigint", () => {
      expect(coerce("9007199254740993", "bigint")).toBe(9007199254740993n);
    });

    it("converts a number to a bigint", () => {
      expect(coerce(123, "bigint")).toBe(123n);
    });

    it("passes an existing bigint through unchanged", () => {
      expect(coerce(10n, "bigint")).toBe(10n);
    });

    it("throws a column-named error on an invalid bigint value", () => {
      expect(() => coerceRow({ id: "not-a-number" }, { id: "bigint" })).toThrow(
        /column "id".*bigint/,
      );
    });
  });

  // ── string ────────────────────────────────────────────────────────────
  describe('coerce "string"', () => {
    it("converts a number to a string", () => {
      expect(coerce(7, "string")).toBe("7");
    });

    it("passes an existing string through unchanged", () => {
      expect(coerce("hello", "string")).toBe("hello");
    });
  });

  // ── date ──────────────────────────────────────────────────────────────
  describe('coerce "date"', () => {
    it("wraps an ISO date string in a Date", () => {
      const out = coerce("2026-05-21T00:00:00.000Z", "date");
      expect(out).toBeInstanceOf(Date);
      expect((out as Date).toISOString()).toBe("2026-05-21T00:00:00.000Z");
    });

    it("passes an existing Date through unchanged", () => {
      const d = new Date("2026-01-01T00:00:00.000Z");
      expect(coerce(d, "date")).toBe(d);
    });

    it("wraps a numeric epoch timestamp in a Date", () => {
      const out = coerce(0, "date");
      expect(out).toBeInstanceOf(Date);
      expect((out as Date).getTime()).toBe(0);
    });
  });

  // ── json ──────────────────────────────────────────────────────────────
  describe('coerce "json"', () => {
    it("parses a JSON string into an object", () => {
      expect(coerce('{"a":1,"b":[2,3]}', "json")).toEqual({ a: 1, b: [2, 3] });
    });

    it("passes an already-parsed object through (pg jsonb path)", () => {
      const obj = { a: 1 };
      expect(coerce(obj, "json")).toBe(obj);
    });

    it("throws a column-named error on malformed JSON", () => {
      expect(() => coerceRow({ payload: "{bad" }, { payload: "json" })).toThrow(
        /column "payload".*json/,
      );
    });
  });

  // ── boolean ───────────────────────────────────────────────────────────
  describe('coerce "boolean"', () => {
    it("normalizes MySQL/SQLite TINYINT 0/1", () => {
      expect(coerce(1, "boolean")).toBe(true);
      expect(coerce(0, "boolean")).toBe(false);
    });

    it("normalizes string 0/1", () => {
      expect(coerce("1", "boolean")).toBe(true);
      expect(coerce("0", "boolean")).toBe(false);
    });

    it("normalizes string true/false (case-insensitive)", () => {
      expect(coerce("true", "boolean")).toBe(true);
      expect(coerce("TRUE", "boolean")).toBe(true);
      expect(coerce("false", "boolean")).toBe(false);
    });

    it("passes a real boolean through unchanged", () => {
      expect(coerce(true, "boolean")).toBe(true);
      expect(coerce(false, "boolean")).toBe(false);
    });
  });

  // ── null / undefined passthrough ──────────────────────────────────────
  describe("null / undefined passthrough", () => {
    const types: CoerceType[] = [
      "number",
      "bigint",
      "string",
      "date",
      "json",
      "boolean",
    ];

    it.each(types)("preserves null for type %s", (type) => {
      expect(coerce(null, type)).toBeNull();
    });

    it.each(types)("preserves undefined for type %s", (type) => {
      expect(coerce(undefined, type)).toBeUndefined();
    });
  });

  // ── coerceRow semantics ───────────────────────────────────────────────
  describe("coerceRow", () => {
    it("leaves columns not present in the coerce map untouched", () => {
      const out = coerceRow(
        { id: "1", name: "Alice", raw: { keep: true } },
        { id: "number" },
      );
      expect(out).toEqual({ id: 1, name: "Alice", raw: { keep: true } });
    });

    it("does not mutate the input row", () => {
      const input = { id: "1" };
      coerceRow(input, { id: "number" });
      expect(input.id).toBe("1");
    });

    it("skips coerce keys absent from the row without error", () => {
      const out = coerceRow({ id: "1" }, { id: "number", missing: "date" });
      expect(out).toEqual({ id: 1 });
    });
  });

  // ── coerceRows over a result set ──────────────────────────────────────
  describe("coerceRows", () => {
    it("applies the coerce map to every row", () => {
      const rows = [
        { day: "2026-05-01T00:00:00.000Z", completedCount: "3" },
        { day: "2026-05-02T00:00:00.000Z", completedCount: "0" },
      ];
      const out = coerceRows<{ day: Date; completedCount: number }>(rows, {
        day: "date",
        completedCount: "number",
      });
      expect(out[0].day).toBeInstanceOf(Date);
      expect(out[0].completedCount).toBe(3);
      expect(out[1].completedCount).toBe(0);
    });

    it("returns an empty array for an empty result set", () => {
      expect(coerceRows([], { id: "number" })).toEqual([]);
    });
  });
});
