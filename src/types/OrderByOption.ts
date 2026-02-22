/**
 * 정렬 방향을 나타내는 타입입니다.
 */
export type SortDirection = "ASC" | "DESC";

/**
 * 엔티티 필드 기반의 정렬 옵션 타입입니다.
 * 엔티티에 존재하는 필드만 정렬 키로 사용할 수 있습니다.
 *
 * @template T - 엔티티 타입
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
