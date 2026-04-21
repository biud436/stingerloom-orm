/* eslint-disable @typescript-eslint/no-explicit-any */
import { Column } from "./Column";

export const VERSION_TOKEN = Symbol.for("STG_VERSION");

/**
 * Declares a version column used for optimistic locking.
 *
 * - On INSERT, the version is automatically initialized to 1.
 * - On UPDATE, the current version is added to the WHERE clause and version is incremented by 1.
 * - When a concurrent modification is detected (affectedRows === 0), OptimisticLockError is thrown.
 *
 * @example
 * @Version()
 * version!: number;
 */
export function Version(): PropertyDecorator {
  return (target, propertyKey) => {
    Reflect.defineMetadata(
      VERSION_TOKEN,
      propertyKey.toString(),
      target.constructor,
    );

    /**
     * Using int because a bigint handler is not yet available.
     */
    return Column({
      type: "int",
      nullable: false,
      length: 11,
    })(target, propertyKey);
  };
}
