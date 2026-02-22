/* eslint-disable @typescript-eslint/no-explicit-any */
import { Column } from "./Column";

export const DELETED_AT_TOKEN = Symbol.for("STG_DELETED_AT");

/**
 * Soft Delete를 위한 삭제 시각 컬럼을 설정합니다.
 * 이 데코레이터가 붙은 엔티티는 delete 대신 UPDATE deleted_at = NOW()로 처리되며,
 * find/findOne 시 자동으로 WHERE deleted_at IS NULL 조건이 추가됩니다.
 */
export function DeletedAt(): PropertyDecorator {
  return (target, propertyKey) => {
    // DELETED_AT_TOKEN에 컬럼 이름을 저장
    Reflect.defineMetadata(
      DELETED_AT_TOKEN,
      propertyKey.toString(),
      target.constructor,
    );

    // datetime 타입의 nullable 컬럼으로 등록
    return Column({
      type: "datetime",
      nullable: true,
    })(target, propertyKey);
  };
}
