/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../../../utils/types";

/**
 * A typed reference to an aliased entity, providing auto-complete for column names.
 *
 * @example
 * ```ts
 * const u = alias(User, "u");
 * u.col("firstName")  // autocomplete! returns "u.firstName"
 * ```
 */
export interface EntityRef<T> {
  /** The table alias string. */
  readonly _alias: string;
  /** The entity class. */
  readonly _entity: ClazzType<T>;
  /**
   * Create a qualified column reference string: `"alias.property"`.
   * TypeScript auto-completes the column parameter from `keyof T`.
   */
  col<K extends keyof T & string>(column: K): string;
}

/**
 * Create a typed entity reference for use with SelectQueryBuilder.
 *
 * The returned `EntityRef` provides **auto-complete** for column names
 * via the `.col()` method. At runtime, `.col("firstName")` simply
 * returns `"u.firstName"` — which `resolveColumn()` translates to
 * the actual DB column name (e.g. `"u"."first_name"` with SnakeNamingStrategy).
 *
 * @example
 * ```ts
 * const u = alias(User, "u");
 * const p = alias(Post, "p");
 *
 * em.createQueryBuilder(Post, "p")
 *   .leftJoin(User, "u", (j) => j.on(p.col("authorId"), "=", u.col("id")))
 *   .where(u.col("firstName"), "LIKE", "%John%")   // auto-complete ✓
 *   .where(p.col("status"), "published")             // auto-complete ✓
 *   .addOrderBy(u.col("lastName"), "ASC")            // auto-complete ✓
 *   .getRawMany();
 * ```
 */
export function alias<T>(entity: ClazzType<T>, name: string): EntityRef<T> {
  return {
    _alias: name,
    _entity: entity,
    col: <K extends keyof T & string>(column: K): string =>
      `${name}.${column}`,
  };
}

/**
 * Type guard: returns `true` if the value is an `EntityRef` (or `QEntity`).
 */
export function isEntityRef<T = any>(value: unknown): value is EntityRef<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as any)._alias === "string" &&
    typeof (value as any)._entity === "function"
  );
}
