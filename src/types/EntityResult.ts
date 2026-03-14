import { ClazzType } from "../utils";

/**
 * @deprecated Use `T[]` directly. This type will be removed in a future version.
 * Kept for backward compatibility.
 */
export type EntityResult<T> =
  | InstanceType<ClazzType<T>>
  | InstanceType<ClazzType<T>>[]
  | undefined;
