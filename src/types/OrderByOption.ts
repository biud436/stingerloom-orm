/**
 * Sort direction.
 */
export type SortDirection = "ASC" | "DESC";

/**
 * Order-by option keyed by entity fields.
 * Only fields present on the entity can be used as sort keys.
 *
 * @template T - the entity type
 *
 * @example
 * ```ts
 * const orderBy: OrderByOption<User> = {
 *   name: "ASC",
 *   createdAt: "DESC",
 * };
 * ```
 */
export type OrderByOption<T> = {
  [K in keyof T]?: SortDirection;
};
