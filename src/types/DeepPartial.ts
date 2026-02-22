/**
 * 엔티티의 모든 프로퍼티를 재귀적으로 optional로 만드는 유틸리티 타입입니다.
 * save() / update() 인자 타입으로 사용됩니다.
 *
 * @example
 * ```ts
 * interface User {
 *   id: number;
 *   profile: { name: string; age: number };
 * }
 *
 * // DeepPartial<User> = { id?: number; profile?: { name?: string; age?: number } }
 * ```
 */
export type DeepPartial<T> = T extends object
  ? T extends Array<infer U>
    ? Array<DeepPartial<U>>
    : { [K in keyof T]?: DeepPartial<T[K]> }
  : T;
