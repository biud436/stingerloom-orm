import { ClazzType, Logger } from "../utils";
import { getScannerInstance } from "../scanner/ScannerContainer";
import { OneToOneScanner } from "../scanner/OneToOneScanner";
import { CascadeOption } from "../types/CascadeType";
import { ReferentialAction } from "../types/ReferentialAction";

/* eslint-disable @typescript-eslint/no-explicit-any */
export const ONE_TO_ONE_TOKEN = Symbol.for("STG_ONE_TO_ONE");

const logger = new Logger("OneToOne");

export type OneToOneOption<T = any> = {
  /**
   * FK 컬럼 이름입니다. 소유측(owning side)에서 설정합니다.
   * @deprecated `@RelationColumn({ name: "..." })` 데코레이터를 대신 사용하세요.
   */
  joinColumn?: string;

  /**
   * 역방향(inverse side)에서 소유측의 프로퍼티 이름을 가리킵니다.
   * 타입 추론을 통해 대상 엔티티의 프로퍼티 이름만 허용됩니다.
   */
  inverseSide?: Extract<keyof T, string> | (string & {});

  /**
   * true일 경우, find/findOne 시 자동으로 LEFT JOIN을 수행하여 관계 엔티티를 함께 로드합니다.
   */
  eager?: boolean;

  /**
   * Cascade 작업 유형입니다.
   * true이면 모든 cascade(insert, update, delete) 적용.
   * 배열이면 선택적 적용. 예: ["insert", "delete"]
   */
  cascade?: CascadeOption;
  /**
   * Referential action for ON DELETE clause.
   * @default 'NO ACTION'
   */
  onDelete?: ReferentialAction;
  /**
   * Referential action for ON UPDATE clause.
   * @default 'NO ACTION'
   */
  onUpdate?: ReferentialAction;
  /**
   * Set to false to skip creating FK constraint in DDL.
   * @default true
   */
  createForeignKeyConstraints?: boolean;
};

export type OneToOneMetadata<T> = {
  target: ClazzType<unknown>;
  propertyKey: string;

  /**
   * 대상 엔티티를 반환하는 함수입니다.
   */
  getRelatedEntity: () => ClazzType<T>;

  /**
   * FK 컬럼 이름 (소유측에서만 설정)
   */
  joinColumn?: string;

  /**
   * 역방향 참조 시 소유측 프로퍼티 이름
   */
  inverseSide?: string;

  /**
   * 옵션
   */
  option?: OneToOneOption;
};

/**
 * OneToOne 관계를 설정합니다.
 * 두 엔티티 간의 일대일 관계를 표현합니다.
 *
 * @example
 * // 소유측 (@RelationColumn으로 FK 컬럼 지정)
 * @OneToOne(() => Profile)
 * @RelationColumn({ name: "profile_id" })
 * profile: Profile;
 *
 * @example
 * // 역방향 (inverseSide 설정)
 * @OneToOne(() => User, { inverseSide: "profile" })
 * user: User;
 */
export function OneToOne<T>(
  getRelatedEntity: () => ClazzType<T>,
  option?: OneToOneOption<T>,
): PropertyDecorator {
  return (target, propertyKey) => {
    const cls = target.constructor;

    if (option?.joinColumn) {
      logger.warn(
        `@OneToOne '${propertyKey.toString()}' on ${cls.name}: 'joinColumn' option is deprecated. Use @RelationColumn({ name: "${option.joinColumn}" }) instead.`,
      );
    }

    const scanner = getScannerInstance(OneToOneScanner);

    const metadata = <OneToOneMetadata<T>>{
      target: cls,
      propertyKey: propertyKey.toString(),
      getRelatedEntity,
      joinColumn: option?.joinColumn,
      inverseSide: option?.inverseSide,
      option,
    };

    const existing = Reflect.getMetadata(ONE_TO_ONE_TOKEN, cls);

    Reflect.defineMetadata(
      ONE_TO_ONE_TOKEN,
      [...(existing || []), metadata],
      cls,
    );

    const uniqueKey = scanner.createUniqueKey();
    scanner.set<OneToOneMetadata<T>>(uniqueKey, metadata);
  };
}
