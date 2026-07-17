/**
 * Validator function that can be attached to a SelectQueryBuilder.
 *
 * Called on each row returned by getMany()/getOne(). If it throws,
 * the entire query result is rejected with the validation error.
 *
 * Supports three patterns:
 * 1. **Plain function**: `(row: TResult) => TResult` — validate and return
 * 2. **Zod-style**: any object with a `.parse(data)` method
 * 3. **Array-level**: `(rows: TResult[]) => TResult[]` via `validateArray()`
 */
export type RowValidator<TResult> =
  | ((row: TResult) => TResult)
  | { parse(data: unknown): TResult };

/**
 * Array-level validator: validates the entire result array at once.
 */
export type ArrayValidator<TResult> =
  | ((rows: TResult[]) => TResult[])
  | { parse(data: unknown): TResult[] };

/**
 * Allowed comparison operators for type-safe WHERE conditions.
 * Using any other string literal will produce a compile-time error.
 */
export type WhereOperator =
  | "="
  | "!="
  | "<>"
  | "<"
  | ">"
  | "<="
  | ">="
  | "LIKE"
  | "NOT LIKE"
  | "ILIKE"
  | "IN"
  | "NOT IN"
  | "IS NULL"
  | "IS NOT NULL"
  | "BETWEEN";
