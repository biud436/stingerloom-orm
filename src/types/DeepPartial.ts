/**
 * Utility type that recursively makes all properties of an entity optional.
 * Used as the argument type for save() / update().
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
