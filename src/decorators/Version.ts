/* eslint-disable @typescript-eslint/no-explicit-any */
import { Column } from "./Column";

export const VERSION_TOKEN = Symbol.for("STG_VERSION");

/**
 * 낙관적 락(Optimistic Locking)을 위한 버전 컬럼을 설정합니다.
 *
 * - INSERT 시 version 값이 자동으로 1로 초기화됩니다.
 * - UPDATE 시 WHERE 절에 현재 version 조건이 추가되고, version이 +1 증가합니다.
 * - 동시 수정이 감지되면 (affectedRows === 0) OptimisticLockError가 발생합니다.
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
     * bigint 핸들러가 아직 없어서 int로 설정합니다.
     */
    return Column({
      type: "int",
      nullable: false,
      length: 11,
    })(target, propertyKey);
  };
}
