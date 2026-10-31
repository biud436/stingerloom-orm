/**
 * CursorKeyset — a composite primary key as the keyset tiebreaker.
 *
 * The first column of a composite key repeats across rows, so a keyset on it
 * alone skipped every row sharing the boundary value. The plan carries every
 * key column: the ORDER BY lists them all and the predicate is the
 * lexicographic compare of the whole tuple.
 */

import {
  buildKeysetOrderBy,
  buildKeysetPredicate,
  cursorFitsKeyset,
  cursorKeyOf,
  encodeNextCursor,
  type KeysetPlan,
} from "../../src/core/entity-manager/CursorKeyset";
import { decodeCursorKey } from "../../src/core/CursorPagination";

const wrap = (n: string) => `"${n}"`;
const flat = (sql: string) => sql.replace(/\s+/g, " ");

function plan(overrides: Partial<KeysetPlan>): KeysetPlan {
  return {
    orderColumn: "order_id",
    pkColumns: ["order_id", "line_no"],
    isPkOrder: true,
    direction: "ASC",
    pageSize: 2,
    cursor: null,
    ...overrides,
  };
}

describe("CursorKeyset composite primary key", () => {
  it("encodes every key column of the last row, in key order", () => {
    const row = { order_id: 1, line_no: 3, sku: "x" };
    expect(cursorKeyOf(plan({}), row)).toEqual({ order: 1, pk: [1, 3], subKey: undefined });
    expect(decodeCursorKey(encodeNextCursor(plan({}), row))).toEqual({
      order: 1,
      pk: [1, 3],
      subKey: undefined,
    });
  });

  it("keeps a single-column key's cursor a scalar", () => {
    const single = plan({ orderColumn: "id", pkColumns: ["id"] });
    expect(cursorKeyOf(single, { id: 7 })).toEqual({ order: 7, pk: 7, subKey: undefined });
  });

  it("PK order: ORDER BY every key column, predicate over the whole tuple", () => {
    expect(buildKeysetOrderBy(plan({}), wrap)).toEqual([
      { column: '"order_id"', direction: "ASC" },
      { column: '"line_no"', direction: "ASC" },
    ]);

    const predicate = buildKeysetPredicate(
      plan({ cursor: { order: 1, pk: [1, 2] } }),
      wrap,
    )!;
    expect(flat(predicate.sql)).toBe(
      '("order_id" > ? OR ("order_id" = ? AND "line_no" > ?))',
    );
    expect(predicate.values).toEqual([1, 1, 2]);

    const desc = buildKeysetPredicate(
      plan({ direction: "DESC", cursor: { order: 3, pk: [3, 1] } }),
      wrap,
    )!;
    expect(flat(desc.sql)).toBe('("order_id" < ? OR ("order_id" = ? AND "line_no" < ?))');
  });

  it("non-PK order: the whole key breaks ties inside the equal-order branch", () => {
    const nonPk = plan({ orderColumn: "sku", isPkOrder: false, cursor: { order: "b", pk: [2, 1] } });

    expect(buildKeysetOrderBy(nonPk, wrap)).toEqual([
      { column: '("sku" IS NULL)', direction: "ASC" },
      { column: '"sku"', direction: "ASC" },
      { column: '"order_id"', direction: "ASC" },
      { column: '"line_no"', direction: "ASC" },
    ]);
    const predicate = buildKeysetPredicate(nonPk, wrap)!;
    expect(flat(predicate.sql)).toBe(
      '("sku" > ? OR ("sku" = ? AND ("order_id" > ? OR ("order_id" = ? AND "line_no" > ?))) OR "sku" IS NULL)',
    );
    expect(predicate.values).toEqual(["b", "b", 2, 2, 1]);
  });

  it("puts a sub key after the last key column", () => {
    const tpc = plan({ subKeyColumn: "dtype", cursor: { order: 1, pk: [1, 2], subKey: "bt" } });

    expect(buildKeysetOrderBy(tpc, wrap).map((key) => key.column)).toEqual([
      '"order_id"',
      '"line_no"',
      '"dtype"',
    ]);
    expect(flat(buildKeysetPredicate(tpc, wrap)!.sql)).toBe(
      '("order_id" > ? OR ("order_id" = ? AND "line_no" > ?) OR ("order_id" = ? AND "line_no" = ? AND "dtype" > ?))',
    );
  });

  it("compares the first column alone for a cursor minted with only that column", () => {
    const legacy = buildKeysetPredicate(plan({ cursor: { order: 1, pk: 1 } }), wrap)!;
    expect(legacy.sql).toBe('"order_id" > ?');
    expect(legacy.values).toEqual([1]);
  });

  it("accepts only cursors that carry the plan's key shape", () => {
    const composite = { pkColumns: ["order_id", "line_no"] };
    const single = { pkColumns: ["id"] };

    expect(cursorFitsKeyset(composite, { order: 1, pk: [1, 2] })).toBe(true);
    expect(cursorFitsKeyset(composite, { order: 1, pk: 1 })).toBe(true);
    expect(cursorFitsKeyset(composite, { order: 1, pk: [1, 2, 3] })).toBe(false);
    expect(cursorFitsKeyset(single, { order: 1, pk: 1 })).toBe(true);
    expect(cursorFitsKeyset(single, { order: 1, pk: [1, 2] })).toBe(false);
    expect(cursorFitsKeyset(single, { order: 1, pk: undefined })).toBe(true);
  });
});
