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
}

/**
 * INSERT 시 자동으로 현재 시각이 설정되는 컬럼을 정의합니다.
 * UPDATE 시에는 값이 변경되지 않습니다.
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
    })(target, propertyKey);
  };
}
