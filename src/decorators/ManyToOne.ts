import { ClazzType, ReflectManager } from "../utils";
import { getScannerInstance } from "../scanner/ScannerContainer";
import { ManyToOneScanner } from "../scanner";
import { CascadeOption } from "../types/CascadeType";
import { ReferentialAction } from "../types/ReferentialAction";

/* eslint-disable @typescript-eslint/no-explicit-any */
export const MANY_TO_ONE_TOKEN = Symbol.for("STG_MANY_TO_ONE");

export type EntityLike<T = any> = ClazzType<T>;
export type RetrieveEntity<T> = () => T;
export type SetRelatedEntity<T extends EntityLike> = (
  entity: InstanceType<T>,
) => void;

export type ManyToOneOption = {
  /**
   * 데이터베이스에서 컬럼의 값을 가져올 때, 오브젝트에 매핑되는 컬럼의 타입을 변환할 수 있는 함수입니다.
   */
  transform?: <T = any>(raw: unknown) => T;
  joinColumn?: string;
  /**
   * 참조 대상 엔티티의 컬럼 이름입니다.
   * 생략 시 대상 엔티티의 Primary Key를 참조합니다.
   */
  references?: string;
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
   * true일 경우, 관계 엔티티에 처음 접근할 때 별도 쿼리로 로드합니다 (Proxy 기반 지연 로딩).
   * eager와 동시에 사용할 수 없습니다. eager가 우선됩니다.
   */
  lazy?: boolean;
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
   * The column will still be created but without a FOREIGN KEY constraint.
   * @default true
   */
  createForeignKeyConstraints?: boolean;
};

export type ManyToOneMetadata<T> = {
  target: ClazzType<unknown>;
  type: EntityLike;

  columnName: string;

  joinColumn?: string;

  /**
   * 참조 대상 엔티티의 컬럼 이름입니다.
   * 생략 시 대상 엔티티의 PK를 참조합니다.
   */
  references?: string;

  /**
   * 연관관계의 엔티티를 가져오는 함수입니다
   */
  getMappingEntity: RetrieveEntity<T>;

  /**
   * 매핑할 엔티티를 가져오는 함수입니다
   */
  getMappingProperty: SetRelatedEntity<EntityLike>;

  option?: ManyToOneOption;
};

/**
 * ManyToOne 관계를 설정합니다.
 * 연관관계에서 주인이 되는 엔티티에 설정해야 합니다.
 *
 * @example
 *
 * @ManyToOne(() => User, (entity) => entity.user)
 * user: User;
 */
export function ManyToOne<T extends EntityLike>(
  getMappingEntity: RetrieveEntity<T>,
  getMappingProperty: SetRelatedEntity<T>,
  option?: ManyToOneOption,
): PropertyDecorator {
  return (target, propertyKey) => {
    const cls = target.constructor;

    const injectParam = ReflectManager.getType<any>(cls, propertyKey);

    const scanner = getScannerInstance(ManyToOneScanner);

    const columnName = propertyKey.toString();
    const metadata = <ManyToOneMetadata<T>>{
      target: cls,
      type: injectParam,
      columnName,
      joinColumn: option?.joinColumn,
      references: option?.references,
      getMappingEntity,
      getMappingProperty,
      option,
    };

    const columns: ManyToOneMetadata<T>[] = Reflect.getMetadata(MANY_TO_ONE_TOKEN, cls) || [];
    const filtered = columns.filter((c) => c.columnName !== metadata.columnName);

    Reflect.defineMetadata(
      MANY_TO_ONE_TOKEN,
      [...filtered, metadata],
      cls,
    );

    const uniqueKey = scanner.createUniqueKey();
    scanner.set<ManyToOneMetadata<T>>(uniqueKey, metadata);
  };
}
