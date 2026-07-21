import { ClazzType } from "../utils";

/**
 * @deprecated Removal target: 2.0. Public callers should use `T[]` for `find()`
 * and `T` for `save()`; this union is still the internal return type of the
 * `findInternal` read path, so the type itself survives as an internal detail
 * and only the public export goes away.
 */
export type EntityResult<T> =
  | InstanceType<ClazzType<T>>
  | InstanceType<ClazzType<T>>[]
  | undefined;
