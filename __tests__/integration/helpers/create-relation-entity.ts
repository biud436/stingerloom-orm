/**
 * 통합 테스트용 관계(OneToMany / ManyToOne) 동적 엔티티 생성 유틸리티
 *
 * ## 설계 원칙
 *
 * ### FK 컬럼 이중 선언
 * 이 ORM은 `@ManyToOne` 데코레이터가 ManyToOneScanner에만 메타데이터를 등록하고,
 * ColumnScanner(createTable 대상)에는 등록하지 않습니다.
 * 따라서 `synchronize: true`로 DB 컬럼을 자동 생성하려면
 * FK 컬럼을 `@Column`으로도 별도 선언해야 합니다.
 *
 * ### Eager 로딩 alias 충돌 방지
 * Eager 로딩 시 관련 엔티티 컬럼은 `{propertyName}_{columnName}` 형태로 alias됩니다.
 * 예: `@ManyToOne` 프로퍼티명 "parent", 관련 엔티티의 "id" 컬럼 →  alias "parent_id"
 *
 * FK @Column 프로퍼티명으로 "parentFk"(camelCase)를 사용하면
 * DB 컬럼명도 "parentFk"이 되어, eager alias "parent_id"와 충돌하지 않습니다.
 *
 * @example
 * ```ts
 * const entities = createOneToManyTestEntities();
 * conn = await createTestConnection({ synchronize: true }, () => {
 *   return { entities: [entities.ParentClass, entities.ChildClass] };
 * });
 * ```
 */

import "reflect-metadata";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  OneToMany,
} from "../../../src";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import {
  ColumnScanner,
  ManyToOneScanner,
  OneToManyScanner,
} from "../../../src/scanner";
// ─────────────────────────────────────────────────────────────────────────────
// 타입 정의
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MySQL FK 이름 길이 제한(64자)을 고려한 짧은 테이블명 생성기.
 *
 * FK 이름 공식: `fk_{childTable}_{parentTable}_{column}`
 * column = "parentFk"(8자)이면 childTable + parentTable ≤ 51자
 *
 * @param prefix 1~2자 접두어 (예: "rp", "rc")
 */
function shortTableName(prefix: string): string {
  // 타임스탬프 마지막 7자리 사용
  const ts = String(Date.now()).slice(-7);
  return `${prefix}_${ts}`;
}

/** 동적으로 생성된 OneToMany/ManyToOne 엔티티 쌍 */
export interface RelatedEntitiesResult {
  /** 부모 엔티티 클래스 (OneToMany 보유) */
  ParentClass: new () => any;
  /** 자식 엔티티 클래스 (ManyToOne 보유, FK 컬럼 포함) */
  ChildClass: new () => any;
  /** 부모 테이블명 (타임스탬프 포함) */
  parentTableName: string;
  /** 자식 테이블명 (타임스탬프 포함) */
  childTableName: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 내부 헬퍼
// ─────────────────────────────────────────────────────────────────────────────

/** 스캐너 초기화 (방어적 클리어) */
function clearRelationScanners(): void {
  getScannerInstance(ColumnScanner).clear();
  getScannerInstance(ManyToOneScanner).clear();
  getScannerInstance(OneToManyScanner).clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// 엔티티 팩토리
// ─────────────────────────────────────────────────────────────────────────────

/**
 * OneToMany / ManyToOne 기본 관계 엔티티 쌍을 생성합니다. (cascade 없음)
 *
 * 구조:
 * - ParentClass: id, name, children (OneToMany)
 * - ChildClass:  id, title, parentFk (Column int), parent (ManyToOne eager)
 *
 * FK 컬럼명: "parentFk" (camelCase → eager alias "parent_id" 와 충돌 없음)
 *
 * @param baseName 테이블 기본 이름 (기본값: "rel_test")
 */
export function createOneToManyTestEntities(
  _baseName = "rel_test",
): RelatedEntitiesResult {
  // FK명 길이 제한(64자)을 위해 짧은 prefix 사용
  // FK 형식: fk_{child}_{parent}_{col} → "rp_1234567" + "rc_1234567" + "parentFk" = 35자
  const parentTableName = shortTableName("rp");
  const childTableName = shortTableName("rc");

  clearRelationScanners();

  // ── ParentClass 정의 ────────────────────────────────────────────────────────
  const ParentClass = class {} as any;
  Object.defineProperty(ParentClass, "name", {
    value: parentTableName,
    writable: false,
  });

  Reflect.defineMetadata("design:type", Number, ParentClass.prototype, "id");
  PrimaryGeneratedColumn()(ParentClass.prototype, "id");

  Reflect.defineMetadata("design:type", String, ParentClass.prototype, "name");
  Column()(ParentClass.prototype, "name");

  // children: OneToMany → ChildClass.parent
  // (cascade 없음 — 기본 관계 테스트용)
  Reflect.defineMetadata(
    "design:type",
    Array,
    ParentClass.prototype,
    "children",
  );
  // ChildClass는 아직 미정의이지만, 클로저로 참조하므로 런타임에 바인딩됩니다.
  OneToMany(() => ChildClass, { mappedBy: "parent" })(
    ParentClass.prototype,
    "children",
  );

  // Entity() 호출 시 현재 ColumnScanner 스냅샷 → metadata.columns
  // Entity() 이후 ColumnScanner가 비워집니다.
  Entity()(ParentClass);

  // ── ChildClass 정의 (Entity(ParentClass) 이후 ColumnScanner 비어있음) ────────
  const ChildClass = class {} as any;
  Object.defineProperty(ChildClass, "name", {
    value: childTableName,
    writable: false,
  });

  Reflect.defineMetadata("design:type", Number, ChildClass.prototype, "id");
  PrimaryGeneratedColumn()(ChildClass.prototype, "id");

  Reflect.defineMetadata("design:type", String, ChildClass.prototype, "title");
  Column()(ChildClass.prototype, "title");

  // FK 컬럼: parentFk (camelCase → DB 컬럼명 "parentFk")
  // @Column 선언 필수 — createTable에서 FK 컬럼 생성을 위해 필요
  // eager alias "parent_id" 와 이름이 달라 충돌 없음
  Reflect.defineMetadata(
    "design:type",
    Number,
    ChildClass.prototype,
    "parentFk",
  );
  Column({ type: "int", nullable: true })(ChildClass.prototype, "parentFk");

  // ManyToOne 관계: parent (joinColumn: "parentFk", eager: true)
  Reflect.defineMetadata(
    "design:type",
    ParentClass,
    ChildClass.prototype,
    "parent",
  );
  ManyToOne(() => ParentClass, (e: any) => e.parent, {
    joinColumn: "parentFk",
    eager: true,
  })(ChildClass.prototype, "parent");

  Entity()(ChildClass);

  return { ParentClass, ChildClass, parentTableName, childTableName };
}

/**
 * OneToMany cascade insert 테스트용 엔티티 쌍을 생성합니다.
 *
 * 구조:
 * - CascadeParentClass: id, name, children (OneToMany, cascade: ["insert"])
 * - CascadeChildClass:  id, title, parentFk (Column int), parent (ManyToOne)
 *
 * @param baseName 테이블 기본 이름 (기본값: "cascade_rel")
 */
export function createCascadeRelationEntities(
  _baseName = "cascade_rel",
): RelatedEntitiesResult {
  // FK명 길이 제한을 위해 짧은 prefix 사용 (cp=cascade parent, cc=cascade child)
  const parentTableName = shortTableName("cp");
  const childTableName = shortTableName("cc");

  clearRelationScanners();

  // ── CascadeParentClass ──────────────────────────────────────────────────────
  const ParentClass = class {} as any;
  Object.defineProperty(ParentClass, "name", {
    value: parentTableName,
    writable: false,
  });

  Reflect.defineMetadata("design:type", Number, ParentClass.prototype, "id");
  PrimaryGeneratedColumn()(ParentClass.prototype, "id");

  Reflect.defineMetadata("design:type", String, ParentClass.prototype, "name");
  Column()(ParentClass.prototype, "name");

  Reflect.defineMetadata(
    "design:type",
    Array,
    ParentClass.prototype,
    "children",
  );
  OneToMany(() => ChildClass, { mappedBy: "parent", cascade: ["insert"] })(
    ParentClass.prototype,
    "children",
  );

  Entity()(ParentClass);

  // ── CascadeChildClass ───────────────────────────────────────────────────────
  const ChildClass = class {} as any;
  Object.defineProperty(ChildClass, "name", {
    value: childTableName,
    writable: false,
  });

  Reflect.defineMetadata("design:type", Number, ChildClass.prototype, "id");
  PrimaryGeneratedColumn()(ChildClass.prototype, "id");

  Reflect.defineMetadata("design:type", String, ChildClass.prototype, "title");
  Column()(ChildClass.prototype, "title");

  Reflect.defineMetadata(
    "design:type",
    Number,
    ChildClass.prototype,
    "parentFk",
  );
  Column({ type: "int", nullable: true })(ChildClass.prototype, "parentFk");

  Reflect.defineMetadata(
    "design:type",
    ParentClass,
    ChildClass.prototype,
    "parent",
  );
  // cascade 없음 — OneToMany 쪽에만 cascade: ["insert"]
  ManyToOne(() => ParentClass, (e: any) => e.parent, {
    joinColumn: "parentFk",
  })(ChildClass.prototype, "parent");

  Entity()(ChildClass);

  return { ParentClass, ChildClass, parentTableName, childTableName };
}

/**
 * cascade DELETE 검증용 엔티티 쌍 (#414).
 *
 * `createCascadeRelationEntities`와 동일한 구조에 더해:
 * - OneToMany cascade: true (delete 포함)
 * - 부모에 다중-부모 criteria 매칭용 `grp` 컬럼
 */
export function createCascadeDeleteTestEntities(
  _baseName = "cascade_del",
): RelatedEntitiesResult {
  // cdp=cascade-delete parent, cdc=cascade-delete child
  const parentTableName = shortTableName("cdp");
  const childTableName = shortTableName("cdc");

  clearRelationScanners();

  // ── Parent ──────────────────────────────────────────────────────────────
  const ParentClass = class {} as any;
  Object.defineProperty(ParentClass, "name", {
    value: parentTableName,
    writable: false,
  });

  Reflect.defineMetadata("design:type", Number, ParentClass.prototype, "id");
  PrimaryGeneratedColumn()(ParentClass.prototype, "id");

  Reflect.defineMetadata("design:type", String, ParentClass.prototype, "name");
  Column()(ParentClass.prototype, "name");

  Reflect.defineMetadata("design:type", String, ParentClass.prototype, "grp");
  Column()(ParentClass.prototype, "grp");

  Reflect.defineMetadata(
    "design:type",
    Array,
    ParentClass.prototype,
    "children",
  );
  OneToMany(() => ChildClass, { mappedBy: "parent", cascade: true })(
    ParentClass.prototype,
    "children",
  );

  Entity()(ParentClass);

  // ── Child ───────────────────────────────────────────────────────────────
  const ChildClass = class {} as any;
  Object.defineProperty(ChildClass, "name", {
    value: childTableName,
    writable: false,
  });

  Reflect.defineMetadata("design:type", Number, ChildClass.prototype, "id");
  PrimaryGeneratedColumn()(ChildClass.prototype, "id");

  Reflect.defineMetadata("design:type", String, ChildClass.prototype, "title");
  Column()(ChildClass.prototype, "title");

  Reflect.defineMetadata(
    "design:type",
    Number,
    ChildClass.prototype,
    "parentFk",
  );
  Column({ type: "int", nullable: true })(ChildClass.prototype, "parentFk");

  Reflect.defineMetadata(
    "design:type",
    ParentClass,
    ChildClass.prototype,
    "parent",
  );
  ManyToOne(() => ParentClass, (e: any) => e.parent, {
    joinColumn: "parentFk",
  })(ChildClass.prototype, "parent");

  Entity()(ChildClass);

  return { ParentClass, ChildClass, parentTableName, childTableName };
}
