import { ClazzType } from "../utils";
import { ColumnType } from "./Column";

export const RELATION_COLUMN_TOKEN = Symbol.for("STG_RELATION_COLUMN");

/**
 * @RelationColumn 데코레이터 옵션.
 *
 * @ManyToOne / @OneToOne 프로퍼티에 부착하여
 * FK 컬럼의 이름·타입·nullable 등을 선언합니다.
 */
export type RelationColumnOption = {
  /** FK 컬럼명. 생략 시 `{propertyName}Id`로 자동 추론 (warn 로그 출력). */
  name?: string;
  /** FK 컬럼 타입. 생략 시 대상 PK 타입 추론, 최종 fallback "int". */
  type?: ColumnType;
  /** nullable 여부. 기본값 true. */
  nullable?: boolean;
  /** 대상 테이블의 참조 컬럼명. 생략 시 대상 PK. */
  referencedColumn?: string;
};

export type RelationColumnMetadata = {
  target: ClazzType<unknown>;
  /** 관계 프로퍼티명 (e.g., "author") */
  propertyKey: string;
  /** 명시된 FK 컬럼명 */
  name?: string;
  /** FK 컬럼 타입 */
  type?: ColumnType;
  /** nullable 여부 */
  nullable?: boolean;
  /** 대상 테이블 참조 컬럼명 */
  referencedColumn?: string;
};

/**
 * @RelationColumn 데코레이터.
 *
 * `@ManyToOne` 또는 `@OneToOne` 프로퍼티에 부착하여
 * FK 컬럼 메타데이터를 선언합니다.
 *
 * @example
 * ```typescript
 * // 명시적 FK 컬럼명
 * @ManyToOne(() => User, u => u.posts)
 * @RelationColumn({ name: "author_id" })
 * author!: User;
 *
 * // 자동 추론 (warn 로그 출력)
 * @ManyToOne(() => User, u => u.posts)
 * @RelationColumn()
 * author!: User;
 *
 * // @Column 병행 — o.userId로 직접 접근 가능
 * @Column({ type: "int", name: "user_id" })
 * userId!: number;
 *
 * @ManyToOne(() => User, u => u.posts)
 * @RelationColumn({ name: "user_id" })
 * author!: User;
 * ```
 */
export function RelationColumn(
  option?: RelationColumnOption,
): PropertyDecorator {
  return (target, propertyKey) => {
    const cls = target.constructor as ClazzType<unknown>;
    const metadata: RelationColumnMetadata = {
      target: cls,
      propertyKey: propertyKey.toString(),
      name: option?.name,
      type: option?.type,
      nullable: option?.nullable,
      referencedColumn: option?.referencedColumn,
    };

    const existing: RelationColumnMetadata[] =
      Reflect.getMetadata(RELATION_COLUMN_TOKEN, cls) || [];
    const filtered = existing.filter(
      (m) => m.propertyKey !== metadata.propertyKey,
    );
    Reflect.defineMetadata(
      RELATION_COLUMN_TOKEN,
      [...filtered, metadata],
      cls,
    );
  };
}
