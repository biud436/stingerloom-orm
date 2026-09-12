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
  /** DB column name of the PK tiebreaker; undefined when the entity has no PK. */
  pkColumn: string | undefined;
  /** True when the order column is the PK itself (or there is no PK): single-key ORDER BY. */
  isPkOrder: boolean;
  direction: CursorDirection;
  pageSize: number;
  /** Decoded cursor of the previous page; null on the first page. */
  cursor: DecodedCursorKey | null;
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
  const { cursor, direction, orderColumn, pkColumn, isPkOrder } = plan;
  if (cursor === null) return undefined;

  const { order: cOrder, pk: cPk } = cursor;
  const wCol = wrap(orderColumn);

  if (cPk === undefined || !pkColumn) {
    // Legacy scalar cursor (pre-keyset) or no PK to tiebreak on: keep
    // the old strict-compare shape for this one transition page.
    if (cOrder === null) return undefined;
    return direction === "ASC"
      ? Conditions.or([Conditions.gt(wCol, cOrder), Conditions.isNull(wCol)])
      : Conditions.or([Conditions.lt(wCol, cOrder), Conditions.isNull(wCol)]);
  }

  if (isPkOrder) {
    return direction === "ASC" ? Conditions.gt(wCol, cPk) : Conditions.lt(wCol, cPk);
  }

  const wPk = wrap(pkColumn);
  if (cOrder === null) {
    // Cursor sits inside the NULL region: ASC = the tail (only
    // later NULL rows remain), DESC = the head (later NULL rows,
    // then every non-NULL row).
    return direction === "ASC"
      ? Conditions.and([Conditions.isNull(wCol), Conditions.gt(wPk, cPk)])
      : Conditions.or([
          Conditions.and([Conditions.isNull(wCol), Conditions.lt(wPk, cPk)]),
          Conditions.isNotNull(wCol),
        ]);
  }

  return direction === "ASC"
    ? Conditions.or([
        Conditions.gt(wCol, cOrder),
        Conditions.and([
          Conditions.equals(wCol, cOrder),
          Conditions.gt(wPk, cPk),
        ]),
        Conditions.isNull(wCol),
      ])
    : Conditions.or([
        Conditions.lt(wCol, cOrder),
        Conditions.and([
          Conditions.equals(wCol, cOrder),
          Conditions.lt(wPk, cPk),
        ]),
      ]);
}

/**
 * ORDER BY keys for a keyset page. A PK order is a single key; any other
 * column gets the explicit `(col IS NULL)` key that pins the NULL region to
 * the tail (ASC) / head (DESC) uniformly across dialects — SQLite/MySQL
 * natively sort NULLs first in ASC while PostgreSQL sorts them last — plus
 * the PK tiebreaker.
 */
export function buildKeysetOrderBy(
  plan: KeysetPlan,
  wrap: (column: string) => string,
): Array<{ column: string; direction: CursorDirection }> {
  const { direction, orderColumn, pkColumn, isPkOrder } = plan;
  const wCol = wrap(orderColumn);
  if (isPkOrder) {
    return [{ column: wCol, direction }];
  }
  return [
    { column: `(${wCol} IS NULL)`, direction },
    { column: wCol, direction },
    { column: wrap(pkColumn!), direction },
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
 * Cursor for the page after `lastRow` (a raw row keyed by DB column name).
 * The PK rides along as the keyset tiebreaker; a NULL order value is a
 * valid cursor position (the NULL region), not an error.
 */
export function encodeNextCursor(
  plan: KeysetPlan,
  lastRow: Record<string, unknown>,
): string {
  return encodeCursorKey(
    lastRow[plan.orderColumn] ?? null,
    plan.pkColumn ? lastRow[plan.pkColumn] : undefined,
  );
}
