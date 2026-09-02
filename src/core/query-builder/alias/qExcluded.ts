/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../../../utils/types";
import { qAlias, type QEntity } from "./qAlias";

/**
 * Reserved alias the INSERT builder uses to mark a column reference as
 * belonging to the *proposed* row of an `ON CONFLICT` statement rather than
 * to the row already stored.
 *
 * Column references travel through the expression layer as `"alias.property"`
 * strings that a {@link ColumnResolver} turns into SQL at build time. The
 * proposed row cannot be modelled as an ordinary alias because the three
 * dialects do not agree on a syntax for it — PostgreSQL and SQLite expose a
 * pseudo-table (`EXCLUDED.col` / `excluded.col`) while MySQL exposes a
 * function (`VALUES(col)`). So the alias is a sentinel: `InsertQueryBuilder`
 * recognizes it and asks the dialect how to spell the reference.
 *
 * The double-underscore name is deliberately unusable as a real alias, so a
 * user alias can never collide with it.
 */
export const EXCLUDED_ALIAS = "__stingerloom_excluded__";

/**
 * A typed reference to the row an INSERT proposed, for use inside
 * `.doUpdate()` on {@link InsertQueryBuilder}.
 *
 * Every property is the same {@link ColumnExpression} / {@link JsonPathExpression}
 * you get from {@link qAlias}, so the whole expression vocabulary composes —
 * the reference just renders as the proposed value instead of the stored one.
 *
 * Renders per dialect:
 *
 * | Dialect | Rendering |
 * |---------|-----------|
 * | PostgreSQL | `EXCLUDED."col"` |
 * | SQLite | `excluded."col"` |
 * | MySQL / MariaDB | `` VALUES(`col`) `` |
 *
 * `.doUpdate()` hands this reference to its callback form, so calling
 * `qExcluded()` directly is only needed when the SET expression is built
 * outside the callback.
 *
 * @example
 * ```ts
 * const m  = qAlias(SyncMarker, "m");
 * const ex = qExcluded(SyncMarker);
 *
 * const accumulated = m.records.add(ex.records);
 *
 * await em.createInsertBuilder(SyncMarker)
 *   .values(rows)
 *   .onConflict(["mac", "bucketStart"])
 *   .doUpdate({ records: accumulated })
 *   .execute();
 * ```
 */
export function qExcluded<T>(entity: ClazzType<T>): QEntity<T> {
  return qAlias(entity, EXCLUDED_ALIAS);
}

/**
 * @internal Split a deferred column reference into its alias and property
 * parts, reporting whether the alias is the {@link EXCLUDED_ALIAS} sentinel.
 *
 * Shared by the INSERT builder's column resolver so the sentinel check lives
 * next to the constant that defines it.
 */
export function splitColumnRef(ref: string): {
  property: string;
  isExcluded: boolean;
} {
  const dot = ref.lastIndexOf(".");
  if (dot < 0) {
    return { property: ref, isExcluded: false };
  }
  return {
    property: ref.substring(dot + 1),
    isExcluded: ref.substring(0, dot) === EXCLUDED_ALIAS,
  };
}
