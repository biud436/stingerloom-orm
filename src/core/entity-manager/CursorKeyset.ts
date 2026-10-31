import { Sql } from "../../utils/sqlTag";
import { Conditions } from "../Conditions";
import { DecodedCursorKey, encodeCursorKey } from "../CursorPagination";

export type CursorDirection = "ASC" | "DESC";

/**
 * Everything `findWithCursor` decides about the page position before it
 * builds SQL: the DB order column, the PK tiebreaker, the direction, the
 * page size and the decoded cursor of the previous page. Pure data — the
 * builders below read it and never touch the database.
 */
export interface KeysetPlan {
  /** DB column name the page is ordered by. */
  orderColumn: string;
  /**
   * DB column names of the PK tiebreaker, in declared order; empty when the
   * entity has no PK. A composite key keeps every column, since its first
   * column alone repeats across rows.
   */
  pkColumns: string[];
  /**
   * True when the page is ordered by the PK itself — the order column is
   * its first column — or there is no PK: no NULL region, and the key
   * columns after the first follow it in the ORDER BY.
   */
  isPkOrder: boolean;
  /**
   * DB column that breaks ties after the PK. Set for a TABLE_PER_CLASS root
   * page, where each concrete table numbers its own PKs and the same value can
   * appear once per subtype; the discriminator makes `(pk, discriminator)`
   * unique again. Undefined for every single-table page.
   */
  subKeyColumn?: string;
  direction: CursorDirection;
  pageSize: number;
  /** Decoded cursor of the previous page; null on the first page. */
  cursor: DecodedCursorKey | null;
}

/**
 * The PK part of a cursor for `pkColumns`: the value itself for a
 * single-column key, an array of the values in key order for a composite
 * one.
 */
function pkPart(pkColumns: string[], row: Record<string, unknown>): unknown {
  if (pkColumns.length === 0) return undefined;
  if (pkColumns.length === 1) return row[pkColumns[0]];
  return pkColumns.map((column) => row[column]);
}

/**
 * Whether `cursor` can position a page of `plan`: a composite key's cursor
 * carries one value per key column, a single-column key's a single value.
 * A cursor with no PK part (a pre-keyset cursor) fits any plan.
 */
export function cursorFitsKeyset(
  plan: Pick<KeysetPlan, "pkColumns">,
  cursor: DecodedCursorKey,
): boolean {
  const { pk } = cursor;
  if (pk === undefined) return true;
  if (plan.pkColumns.length > 1) {
    return !Array.isArray(pk) || pk.length === plan.pkColumns.length;
  }
  return !Array.isArray(pk);
}

/**
 * The tiebreak keys a cursor positions on, with its value for each: every
 * PK column, then the sub key. The list stops at the first value the cursor
 * does not carry — a cursor minted before the sub key existed, or one whose
 * composite key held only its first column — so that page compares the keys
 * it has.
 */
function tiebreakKeys(
  plan: KeysetPlan,
  cursor: DecodedCursorKey,
): Array<{ column: string; value: unknown }> {
  const { pkColumns, subKeyColumn } = plan;
  const values =
    pkColumns.length > 1 && Array.isArray(cursor.pk) ? cursor.pk : [cursor.pk];
  const keys: Array<{ column: string; value: unknown }> = [];
  for (let i = 0; i < pkColumns.length; i++) {
    if (values[i] === undefined) return keys;
    keys.push({ column: pkColumns[i], value: values[i] });
  }
  if (subKeyColumn && cursor.subKey !== undefined && cursor.subKey !== null) {
    keys.push({ column: subKeyColumn, value: cursor.subKey });
  }
  return keys;
}

/**
 * Keyset pagination predicate for the previous page's cursor, or undefined
 * on the first page.
 *
 * The PK tiebreaker keeps rows that share the same order value from being
 * skipped at page boundaries, and the NULL region is addressed explicitly
 * so it pages the same way on every dialect (see {@link buildKeysetOrderBy}).
 * A legacy scalar cursor (no PK part) or an entity without a PK keeps the
 * old strict-compare shape for that one transition page.
 */
export function buildKeysetPredicate(
  plan: KeysetPlan,
  wrap: (column: string) => string,
): Sql | undefined {
  const { cursor, direction, orderColumn, pkColumns, isPkOrder } = plan;
  if (cursor === null) return undefined;

  const { order: cOrder, pk: cPk } = cursor;
  const wCol = wrap(orderColumn);

  if (cPk === undefined || pkColumns.length === 0) {
    // Legacy scalar cursor (pre-keyset) or no PK to tiebreak on: keep
    // the old strict-compare shape for this one transition page.
    if (cOrder === null) return undefined;
    return direction === "ASC"
      ? Conditions.or([Conditions.gt(wCol, cOrder), Conditions.isNull(wCol)])
      : Conditions.or([Conditions.lt(wCol, cOrder), Conditions.isNull(wCol)]);
  }

  // "The row's key is past the cursor": the lexicographic compare of the
  // tiebreak keys, expanded so every dialect reads it the same —
  // `k1 > v1 OR (k1 = v1 AND k2 > v2) OR …` — a plain compare for one key.
  const keys = tiebreakKeys(plan, cursor);
  const keyAfter = (dir: CursorDirection): Sql => {
    const cmp = dir === "ASC" ? Conditions.gt : Conditions.lt;
    const branches = keys.map(({ column, value }, i) => {
      const after = cmp(wrap(column), value);
      if (i === 0) return after;
      return Conditions.and([
        ...keys.slice(0, i).map((key) => Conditions.equals(wrap(key.column), key.value)),
        after,
      ]);
    });
    return branches.length === 1 ? branches[0] : Conditions.or(branches);
  };

  if (isPkOrder) {
    return keyAfter(direction);
  }

  if (cOrder === null) {
    // Cursor sits inside the NULL region: ASC = the tail (only
    // later NULL rows remain), DESC = the head (later NULL rows,
    // then every non-NULL row).
    return direction === "ASC"
      ? Conditions.and([Conditions.isNull(wCol), keyAfter("ASC")])
      : Conditions.or([
          Conditions.and([Conditions.isNull(wCol), keyAfter("DESC")]),
          Conditions.isNotNull(wCol),
        ]);
  }

  return direction === "ASC"
    ? Conditions.or([
        Conditions.gt(wCol, cOrder),
        Conditions.and([Conditions.equals(wCol, cOrder), keyAfter("ASC")]),
        Conditions.isNull(wCol),
      ])
    : Conditions.or([
        Conditions.lt(wCol, cOrder),
        Conditions.and([Conditions.equals(wCol, cOrder), keyAfter("DESC")]),
      ]);
}

/**
 * ORDER BY keys for a keyset page. A PK order is the key's own columns;
 * any other column gets the explicit `(col IS NULL)` key that pins the NULL
 * region to the tail (ASC) / head (DESC) uniformly across dialects —
 * SQLite/MySQL natively sort NULLs first in ASC while PostgreSQL sorts them
 * last — plus every PK column as the tiebreaker. A sub key (TPC
 * discriminator) always trails the PK.
 */
export function buildKeysetOrderBy(
  plan: KeysetPlan,
  wrap: (column: string) => string,
): Array<{ column: string; direction: CursorDirection }> {
  const { direction, orderColumn, pkColumns, isPkOrder, subKeyColumn } = plan;
  const wCol = wrap(orderColumn);
  const key = (column: string) => ({ column: wrap(column), direction });
  const subKey = subKeyColumn ? [key(subKeyColumn)] : [];
  if (isPkOrder) {
    return [{ column: wCol, direction }, ...pkColumns.slice(1).map(key), ...subKey];
  }
  return [
    { column: `(${wCol} IS NULL)`, direction },
    { column: wCol, direction },
    ...pkColumns.map(key),
    ...subKey,
  ];
}

/**
 * Splits the `pageSize + 1` probe rows into the page and the has-next flag.
 */
export function sliceCursorPage<R>(
  rows: R[],
  pageSize: number,
): { pageRows: R[]; hasNextPage: boolean } {
  const hasNextPage = rows.length > pageSize;
  return { pageRows: hasNextPage ? rows.slice(0, pageSize) : rows, hasNextPage };
}

/**
 * The cursor position of `lastRow` (a raw row keyed by DB column name): its
 * order value, its PK — every column of a composite key — and its sub key.
 * A NULL order value is a valid position (the NULL region), not an error.
 */
export function cursorKeyOf(
  plan: Omit<KeysetPlan, "cursor">,
  lastRow: Record<string, unknown>,
): DecodedCursorKey {
  return {
    order: lastRow[plan.orderColumn] ?? null,
    pk: pkPart(plan.pkColumns, lastRow),
    subKey: plan.subKeyColumn ? lastRow[plan.subKeyColumn] : undefined,
  };
}

/**
 * Cursor for the page after `lastRow` — {@link cursorKeyOf}, encoded.
 */
export function encodeNextCursor(
  plan: KeysetPlan,
  lastRow: Record<string, unknown>,
): string {
  const { order, pk, subKey } = cursorKeyOf(plan, lastRow);
  return encodeCursorKey(order, pk, subKey);
}
