/**
 * 통합 테스트용 동적 엔티티 생성 유틸리티
 *
 * 테스트 간 테이블명 충돌을 방지하기 위해 타임스탬프 기반의
 * 고유한 테이블명을 가진 엔티티 클래스를 동적으로 생성합니다.
 *
 * @example
 * ```ts
 * const { Entity, tableName } = createCrudTestEntity();
 * // tableName = "crud_test_1708123456789"
 * // Entity는 id(PK), name(varchar), age(int) 컬럼을 가짐
 * ```
 */

import "reflect-metadata";
import { Entity, Column, PrimaryGeneratedColumn } from "../../../src";
import { ColumnOption } from "../../../src/decorators/Column";
import Container from "typedi";
import { ColumnScanner } from "../../../src/scanner";

/**
 * 타임스탬프 기반의 고유한 테이블명을 생성합니다.
 *
 * @param baseName 테이블 기본 이름
 * @returns "baseName_<timestamp>" 형태의 고유 이름
 */
export function generateTableName(baseName: string): string {
  const timestamp = Date.now();
  return `${baseName}_${timestamp}`;
}

/** 동적으로 생성된 엔티티 클래스와 메타정보 */
export interface DynamicEntityResult {
  /** 생성된 엔티티 클래스 */
  EntityClass: new () => any;
  /** 실제 DB 테이블명 (snake_case + timestamp) */
  tableName: string;
}

/**
 * 컬럼 정의 인터페이스
 */
export interface TestColumnDef {
  /** 프로퍼티/컬럼 이름 */
  name: string;
  /** TypeScript 원시 타입 (Number, String, Boolean, Date) */
  designType: any;
  /** Column 데코레이터 옵션 */
  options?: ColumnOption;
  /** PrimaryGeneratedColumn 여부 */
  primary?: boolean;
}

/**
 * 동적 엔티티 클래스를 생성합니다.
 *
 * - 클래스명에 타임스탬프가 포함되어 테이블명 충돌을 방지합니다.
 * - design:type 메타데이터를 수동 설정하여 데코레이터가 정상 동작합니다.
 * - ColumnScanner를 사전 클리어하여 이전 테스트의 메타데이터 오염을 방지합니다.
 *
 * @param baseName 테이블 기본 이름 (snake_case 권장)
 * @param columns 컬럼 정의 배열
 */
export function createDynamicEntity(
  baseName: string,
  columns: TestColumnDef[],
): DynamicEntityResult {
  const tableName = generateTableName(baseName);

  // 동적 클래스 생성
  const DynamicClass = class {} as any;
  Object.defineProperty(DynamicClass, "name", {
    value: tableName,
    writable: false,
  });

  // ColumnScanner 클리어 (이전 테스트의 잔여 메타데이터 방지)
  const columnScanner = Container.get(ColumnScanner);
  columnScanner.clear();

  // 컬럼 데코레이터 프로그래밍 방식 적용
  for (const col of columns) {
    // design:type 메타데이터 수동 설정 (TS 컴파일러의 emitDecoratorMetadata 대체)
    Reflect.defineMetadata(
      "design:type",
      col.designType,
      DynamicClass.prototype,
      col.name,
    );

    if (col.primary) {
      PrimaryGeneratedColumn(col.options)(DynamicClass.prototype, col.name);
    } else {
      Column(col.options)(DynamicClass.prototype, col.name);
    }
  }

  // Entity 데코레이터 적용 (반드시 Column들이 모두 등록된 후 호출)
  Entity()(DynamicClass);

  return {
    EntityClass: DynamicClass,
    tableName,
  };
}

/**
 * CRUD 테스트에 사용할 기본 엔티티를 생성합니다.
 *
 * 컬럼 구성:
 * - id: PrimaryGeneratedColumn (AUTO_INCREMENT)
 * - name: VARCHAR(255)
 * - age: INT
 * - email: VARCHAR(255), nullable
 *
 * @param baseName 테이블 기본 이름 (기본값: "crud_test")
 */
export function createCrudTestEntity(
  baseName: string = "crud_test",
): DynamicEntityResult {
  return createDynamicEntity(baseName, [
    { name: "id", designType: Number, primary: true },
    { name: "name", designType: String },
    { name: "age", designType: Number, options: { type: "int" } },
    {
      name: "email",
      designType: String,
      options: { type: "varchar", length: 255, nullable: true },
    },
  ]);
}
