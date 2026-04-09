/* eslint-disable @typescript-eslint/no-explicit-any */
import { Column } from "./Column";
import { TimestampOptions } from "./CreateTimestamp";

export const UPDATE_TIMESTAMP_TOKEN = Symbol.for("STG_UPDATE_TIMESTAMP");

/**
 * INSERT 및 UPDATE 시 자동으로 현재 시각이 설정되는 컬럼을 정의합니다.
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
