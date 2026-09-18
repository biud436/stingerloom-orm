/**
 * CursorKeyset — the (pk, subKey) tiebreaker a TABLE_PER_CLASS root page
 * carries. Each concrete table numbers its own PKs, so (order, pk) alone
 * is not unique across the UNION ALL; the discriminator literal restores
 * uniqueness in both the ORDER BY and the keyset predicate.
 */

import {
  buildKeysetOrderBy,
  buildKeysetPredicate,
  encodeNextCursor,
  type KeysetPlan,
} from "../../src/core/entity-manager/CursorKeyset";
import { decodeCursorKey, encodeCursorKey } from "../../src/core/CursorPagination";

const wrap = (n: string) => `"${n}"`;

function plan(overrides: Partial<KeysetPlan>): KeysetPlan {
  return {
    orderColumn: "id",
    pkColumn: "id",
    isPkOrder: true,
    direction: "ASC",
    pageSize: 2,
    cursor: null,
    ...overrides,
  };
}

describe("CursorKeyset sub key (TPC discriminator)", () => {
  it("encodes the sub key as `d` and decodes it back; plain cursors are unchanged", () => {
    const withSub = encodeCursorKey(7, 7, "cc");
    expect(decodeCursorKey(withSub)).toEqual({ order: 7, pk: 7, subKey: "cc" });

    const plain = encodeCursorKey(7, 7);
    expect(JSON.parse(Buffer.from(plain, "base64").toString("utf-8"))).toEqual({ v: 7, p: 7 });
    expect(decodeCursorKey(plain)).toEqual({ order: 7, pk: 7, subKey: undefined });
  });

  it("encodeNextCursor carries the discriminator of the last row only when the plan has a sub key", () => {
    const row = { id: 3, dtype: "bt" };
    expect(decodeCursorKey(encodeNextCursor(plan({ subKeyColumn: "dtype" }), row))).toEqual({
      order: 3,
      pk: 3,
      subKey: "bt",
    });
    expect(decodeCursorKey(encodeNextCursor(plan({}), row))).toEqual({
      order: 3,
      pk: 3,
      subKey: undefined,
    });
  });

  it("appends the sub key after the PK in ORDER BY for both order shapes", () => {
    expect(buildKeysetOrderBy(plan({ subKeyColumn: "dtype" }), wrap)).toEqual([
      { column: '"id"', direction: "ASC" },
      { column: '"dtype"', direction: "ASC" },
    ]);
    expect(
      buildKeysetOrderBy(
        plan({ orderColumn: "amount", isPkOrder: false, direction: "DESC", subKeyColumn: "dtype" }),
        wrap,
      ),
    ).toEqual([
      { column: '("amount" IS NULL)', direction: "DESC" },
      { column: '"amount"', direction: "DESC" },
      { column: '"id"', direction: "DESC" },
      { column: '"dtype"', direction: "DESC" },
    ]);
    // No sub key: unchanged single-table shape.
    expect(buildKeysetOrderBy(plan({}), wrap)).toEqual([{ column: '"id"', direction: "ASC" }]);
  });

  it("PK order: the predicate is the lexicographic (pk, subKey) compare", () => {
    const predicate = buildKeysetPredicate(
      plan({ subKeyColumn: "dtype", cursor: { order: 1, pk: 1, subKey: "bt" } }),
      wrap,
    )!;
    expect(predicate.sql.replace(/\s+/g, " ")).toBe(
      '("id" > ? OR ("id" = ? AND "dtype" > ?))',
    );
    expect(predicate.values).toEqual([1, 1, "bt"]);

    const desc = buildKeysetPredicate(
      plan({ direction: "DESC", subKeyColumn: "dtype", cursor: { order: 2, pk: 2, subKey: "cc" } }),
      wrap,
    )!;
    expect(desc.sql.replace(/\s+/g, " ")).toBe(
      '("id" < ? OR ("id" = ? AND "dtype" < ?))',
    );
  });

  it("non-PK order: the sub key extends the PK tiebreaker inside the equal-order branch", () => {
    const predicate = buildKeysetPredicate(
      plan({
        orderColumn: "amount",
        isPkOrder: false,
        subKeyColumn: "dtype",
        cursor: { order: 30, pk: 1, subKey: "bt" },
      }),
      wrap,
    )!;
    expect(predicate.sql.replace(/\s+/g, " ")).toBe(
      '("amount" > ? OR ("amount" = ? AND ("id" > ? OR ("id" = ? AND "dtype" > ?))) OR "amount" IS NULL)',
    );
    expect(predicate.values).toEqual([30, 30, 1, 1, "bt"]);
  });

  it("falls back to the plain PK compare when the cursor carries no sub key", () => {
    const legacy = buildKeysetPredicate(
      plan({ subKeyColumn: "dtype", cursor: { order: 1, pk: 1, subKey: undefined } }),
      wrap,
    )!;
    expect(legacy.sql).toBe('"id" > ?');
    expect(legacy.values).toEqual([1]);
  });
});
