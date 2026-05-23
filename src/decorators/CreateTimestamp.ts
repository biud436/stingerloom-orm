/* eslint-disable @typescript-eslint/no-explicit-any */
import { Column } from "./Column";

export const CREATE_TIMESTAMP_TOKEN = Symbol.for("STG_CREATE_TIMESTAMP");

/** Date/time column types allowed for timestamp decorators. */
export type TimestampColumnType =
  | "datetime"
  | "timestamp"
  | "timestamptz"
  | "date";

export interface TimestampOptions {
  /** Column type override. Defaults to `"datetime"`. */
  type?: TimestampColumnType;
  /**
   * Explicit DB column name. Defaults to the decorated property name. Use
   * when the underlying column doesn't match the property's camelCase name
   * (e.g. `created_at` vs `createdAt`).
   */
  name?: string;
}

/**
 * Declares a column automatically set to the current time on INSERT.
 * Not modified on UPDATE.
 *
 * @example
 * @CreateTimestamp()
 * createdAt!: Date;
 *
 * @example
 * @CreateTimestamp({ type: "timestamptz" })
 * createdAt!: Date;
 */
export function CreateTimestamp(options?: TimestampOptions): PropertyDecorator {
  return (target, propertyKey) => {
    Reflect.defineMetadata(
      CREATE_TIMESTAMP_TOKEN,
      propertyKey.toString(),
      target.constructor,
    );

    return Column({
      type: options?.type ?? "datetime",
      nullable: false,
      ...(options?.name ? { name: options.name } : {}),
    })(target, propertyKey);
  };
}
