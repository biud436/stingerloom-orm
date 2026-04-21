/* eslint-disable @typescript-eslint/no-explicit-any */
import { Column } from "./Column";
import { TimestampOptions } from "./CreateTimestamp";

export const UPDATE_TIMESTAMP_TOKEN = Symbol.for("STG_UPDATE_TIMESTAMP");

/**
 * Declares a column automatically set to the current time on INSERT and UPDATE.
 *
 * @example
 * @UpdateTimestamp()
 * updatedAt!: Date;
 *
 * @example
 * @UpdateTimestamp({ type: "timestamptz" })
 * updatedAt!: Date;
 */
export function UpdateTimestamp(options?: TimestampOptions): PropertyDecorator {
  return (target, propertyKey) => {
    Reflect.defineMetadata(
      UPDATE_TIMESTAMP_TOKEN,
      propertyKey.toString(),
      target.constructor,
    );

    return Column({
      type: options?.type ?? "datetime",
      nullable: false,
    })(target, propertyKey);
  };
}
