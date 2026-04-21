/* eslint-disable @typescript-eslint/no-explicit-any */
import { Column } from "./Column";
import { TimestampOptions } from "./CreateTimestamp";

export const DELETED_AT_TOKEN = Symbol.for("STG_DELETED_AT");

/**
 * Declares a deletion-timestamp column for soft delete.
 * Entities annotated with this decorator are processed with UPDATE deleted_at = NOW() instead of DELETE,
 * and find/findOne automatically adds a WHERE deleted_at IS NULL condition.
 *
 * @example
 * @DeletedAt()
 * deletedAt!: Date | null;
 *
 * @example
 * @DeletedAt({ type: "timestamptz" })
 * deletedAt!: Date | null;
 */
export function DeletedAt(options?: TimestampOptions): PropertyDecorator {
  return (target, propertyKey) => {
    // Store the column name in DELETED_AT_TOKEN
    Reflect.defineMetadata(
      DELETED_AT_TOKEN,
      propertyKey.toString(),
      target.constructor,
    );

    return Column({
      type: options?.type ?? "datetime",
      nullable: true,
    })(target, propertyKey);
  };
}
