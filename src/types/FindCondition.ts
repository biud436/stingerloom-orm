/**
 * WHERE 조건에 사용할 수 있는 비교 연산자 타입입니다.
 *
 * @example
 * ```ts
 * // age > 18
 * { age: { $gt: 18 } }
 *
 * // name LIKE '%john%'
 * { name: { $like: '%john%' } }
 *
 * // status IN ('active', 'pending')
 * { status: { $in: ['active', 'pending'] } }
 * ```
 */
export interface FindOperator<T> {
  $eq?: T;
  $ne?: T;
  $gt?: T;
  $gte?: T;
  $lt?: T;
  $lte?: T;
  $like?: string;
  $in?: T[];
  $notIn?: T[];
  $isNull?: boolean;
}

/**
 * 엔티티 필드 기반의 WHERE 조건 타입입니다.
 * 각 필드에 직접 값을 지정하거나 FindOperator를 사용할 수 있습니다.
 *
 * @template T - 엔티티 타입
 *
 * @example
 * ```ts
 * // 단순 매칭
 * const where: FindCondition<User> = { name: "Alice" };
 *
 * // 연산자 사용
 * const where2: FindCondition<User> = {
 *   age: { $gte: 18, $lt: 65 },
 *   name: { $like: '%alice%' },
 * };
 * ```
 */
export type FindCondition<T> = {
  [K in keyof T]?: T[K] | FindOperator<T[K]>;
};
