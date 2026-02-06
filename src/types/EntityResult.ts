import { ClazzType } from "../utils";

export type EntityResult<T> =
  | InstanceType<ClazzType<T>>
  | InstanceType<ClazzType<T>>[]
  | undefined;
