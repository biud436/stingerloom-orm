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
  const { cursor, direction, orderColumn, pkColumn, isPkOrder, subKeyColumn } = plan;
  if (cursor === null) return undefined;

  const { order: cOrder, pk: cPk, subKey: cSub } = cursor;
  const wCol = wrap(orderColumn);

  // "The row's key is past the cursor": a plain PK compare, or the
  // lexicographic (pk, subKey) compare when the page carries a second
  // tiebreaker. A cursor minted before the sub key existed (or one whose
  // sub key is missing) falls back to the plain compare for that page.
  const pkAfter = (wPk: string, dir: CursorDirection): Sql => {
    const cmp = dir === "ASC" ? Conditions.gt : Conditions.lt;
    if (!subKeyColumn || cSub === undefined || cSub === null) {
      return cmp(wPk, cPk);
    }
    const wSub = wrap(subKeyColumn);
    return Conditions.or([
      cmp(wPk, cPk),
      Conditions.and([Conditions.equals(wPk, cPk), cmp(wSub, cSub)]),
    ]);
  };

  if (cPk === undefined || !pkColumn) {
    // Legacy scalar cursor (pre-keyset) or no PK to tiebreak on: keep
    // the old strict-compare shape for this one transition page.
    if (cOrder === null) return undefined;
    return direction === "ASC"
      ? Conditions.or([Conditions.gt(wCol, cOrder), Conditions.isNull(wCol)])
      : Conditions.or([Conditions.lt(wCol, cOrder), Conditions.isNull(wCol)]);
  }

  if (isPkOrder) {
    return pkAfter(wCol, direction);
  }

  const wPk = wrap(pkColumn);
  if (cOrder === null) {
    // Cursor sits inside the NULL region: ASC = the tail (only
    // later NULL rows remain), DESC = the head (later NULL rows,
    // then every non-NULL row).
    return direction === "ASC"
      ? Conditions.and([Conditions.isNull(wCol), pkAfter(wPk, "ASC")])
      : Conditions.or([
          Conditions.and([Conditions.isNull(wCol), pkAfter(wPk, "DESC")]),
          Conditions.isNotNull(wCol),
        ]);
  }

  return direction === "ASC"
    ? Conditions.or([
        Conditions.gt(wCol, cOrder),
        Conditions.and([
          Conditions.equals(wCol, cOrder),
          pkAfter(wPk, "ASC"),
        ]),
        Conditions.isNull(wCol),
      ])
    : Conditions.or([
        Conditions.lt(wCol, cOrder),
        Conditions.and([
          Conditions.equals(wCol, cOrder),
          pkAfter(wPk, "DESC"),
        ]),
      ]);
}

/**
 * ORDER BY keys for a keyset page. A PK order is a single key; any other
 * column gets the explicit `(col IS NULL)` key that pins the NULL region to
 * the tail (ASC) / head (DESC) uniformly across dialects — SQLite/MySQL
 * natively sort NULLs first in ASC while PostgreSQL sorts them last — plus
 * the PK tiebreaker. A sub key (TPC discriminator) always trails the PK.
 */
export function buildKeysetOrderBy(
  plan: KeysetPlan,
  wrap: (column: string) => string,
): Array<{ column: string; direction: CursorDirection }> {
  const { direction, orderColumn, pkColumn, isPkOrder, subKeyColumn } = plan;
  const wCol = wrap(orderColumn);
  const subKey = subKeyColumn
    ? [{ column: wrap(subKeyColumn), direction }]
    : [];
  if (isPkOrder) {
    return [{ column: wCol, direction }, ...subKey];
  }
  return [
    { column: `(${wCol} IS NULL)`, direction },
    { column: wCol, direction },
    { column: wrap(pkColumn!), direction },
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
    plan.subKeyColumn ? lastRow[plan.subKeyColumn] : undefined,
  );
}
