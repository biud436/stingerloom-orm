/* eslint-disable @typescript-eslint/no-explicit-any */
import { ReflectManager } from "../utils";
import { ColumnMetadata, ColumnScanner } from "../scanner/ColumnScanner";
import Container from "typedi";

/**
 * 데이터베이스 독립적인 추상 컬럼 타입입니다.
 *
 * 각 DB Driver의 `castType()` 메서드에서 실제 데이터베이스 타입으로 변환됩니다.
 *
 * 예시:
 * - `"datetime"` → MySQL: `DATETIME`, PostgreSQL: `TIMESTAMP`
 * - `"boolean"` → MySQL: `TINYINT(1)`, PostgreSQL: `BOOLEAN`
 * - `"blob"` → MySQL: `BLOB`, PostgreSQL: `BYTEA`
 *
 * 이를 통해 동일한 엔티티 정의로 여러 데이터베이스를 지원할 수 있습니다.
 */
export type ColumnType =
  | "int"
  | "number"
  | "float"
  | "double"
  /** Date */
  | "timestamp"
  | "date"
  | "datetime"
  /** Buffer */
  | "blob"
  /** String */
  | "text"
  | "varchar"
  | "char"
  | "boolean"
  | "enum"
  | "json"
  | "jsonb"
  | "array"
  | "bigint"
  | "longtext";

export interface ColumnOption {
  name?: string;
  length?: number;
  nullable?: boolean;

  /**
   * ColumnType에 속하면 ColumnType을 사용하고, 아니면 string을 사용합니다.
   * 생략 시 TypeScript의 design:type 메타데이터로부터 자동 추론됩니다.
   */
  type?: ColumnType;
  primary?: boolean;
  autoIncrement?: boolean;

  /**
   * 데이터베이스에서 컬럼의 값을 가져올 때, 오브젝트에 매핑되는 컬럼의 타입을 변환할 수 있는 함수입니다.
   */
  transform?: <T = any>(raw: unknown) => T;

  precision?: number;
  scale?: number;

  /**
   * PostgreSQL ENUM 타입에 포함될 값 목록입니다.
   * `type: "enum"` 과 함께 사용합니다.
   *
   * @example
   * @Column({ type: "enum", enumName: "user_role", enumValues: ["admin", "user", "guest"] })
   * role: string;
   */
  enumValues?: string[];

  /**
   * PostgreSQL 사용자 정의 ENUM 타입 이름입니다.
   * 생략 시 `${tableName}_${columnName}_enum` 형식으로 자동 생성됩니다.
   */
  enumName?: string;
}

/**
 * 해석이 완료된 ColumnOption으로, type/length/nullable이 항상 존재합니다.
 * Column 데코레이터 내부에서 기본값이 적용된 후의 타입입니다.
 */
export type ResolvedColumnOption = Required<
  Pick<ColumnOption, "type" | "length" | "nullable">
> &
  Omit<ColumnOption, "type" | "length" | "nullable">;

/**
 * TypeScript의 design:type 메타데이터로부터 컬럼의 기본 설정을 추론합니다.
 *
 * 반환되는 type은 **추상적인 ColumnType**이며, 각 DB Driver의 castType()에서
 * 실제 데이터베이스 타입으로 변환됩니다.
 *
 * ## TypeScript → ColumnType 매핑
 * | TS 타입   | ColumnType | 기본 길이 | nullable |
 * |-----------|-----------|----------|----------|
 * | String    | varchar   | 255      | false    |
 * | Number    | int       | 11       | false    |
 * | Boolean   | boolean   | 1        | false    |
 * | Date      | datetime  | 0        | false    |
 * | Buffer    | blob      | 0        | true     |
 * | (기타)    | text      | 0        | true     |
 *
 * ## ColumnType → DB 실제 타입 변환 (Driver별)
 *
 * **MySQL/MariaDB:**
 * - `varchar` → `VARCHAR(n)`
 * - `int` → `INT(n)` (기본 타입, 변환 없음)
 * - `boolean` → `TINYINT(1)`
 * - `datetime` → `DATETIME`
 * - `blob` → `BLOB`
 * - `text` → `TEXT`
 *
 * **PostgreSQL:**
 * - `varchar` → `VARCHAR(n)`
 * - `int` / `number` → `INTEGER`
 * - `boolean` → `BOOLEAN` (네이티브)
 * - `datetime` → `TIMESTAMP`
 * - `blob` → `BYTEA`
 * - `text` → `TEXT`
 */
export function inferColumnDefaults(
  designType: any,
): Pick<ResolvedColumnOption, "type" | "length" | "nullable"> {
  switch (designType) {
    case String:
      return { type: "varchar", length: 255, nullable: false };
    case Number:
      return { type: "int", length: 11, nullable: false };
    case Boolean:
      return { type: "boolean", length: 1, nullable: false };
    case Date:
      return { type: "datetime", length: 0, nullable: false };
    case Buffer:
      return { type: "blob", length: 0, nullable: true };
    default:
      return { type: "text", length: 0, nullable: true };
  }
}

export const COLUMN_TOKEN = Symbol.for("STG_COLUMN");

/**
 * 컬럼 데코레이터에서는 컬럼에 대한 메타데이터를 설정합니다.
 * 메타데이터는 컬럼의 이름, 옵션, 타입을 설정합니다.
 * 자바스크립트에서 제공되는 원시 타입은 기본적으로 설정됩니다.
 *
 * 하지만 커스텀 타입을 사용할 경우, 추후 오브젝트가 매핑될 때 ColumnTypeFactory를 참고하여 타입을 가져와야 합니다.
 *
 * @param option
 * @returns
 */
export function Column(option?: ColumnOption): PropertyDecorator {
  return (target, propertyKey) => {
    const injectParam = ReflectManager.getType<any>(target, propertyKey);

    // design:type으로부터 기본값을 추론한 뒤, 사용자 옵션으로 덮어씁니다.
    const defaults = inferColumnDefaults(injectParam);
    const resolvedOption: ResolvedColumnOption = {
      ...defaults,
      ...option,
    };

    const name = resolvedOption.name || propertyKey.toString();
    const metadata = <ColumnMetadata>{
      target,
      name,
      options: resolvedOption,
      type: injectParam,
      transform: resolvedOption.transform,
    };

    const columns = Reflect.getMetadata(COLUMN_TOKEN, target);

    Reflect.defineMetadata(
      COLUMN_TOKEN,
      [...(columns || []), metadata],
      target,
    );

    const scanner = Container.get(ColumnScanner);
    const uniqueKey = scanner.createUniqueKey();

    scanner.set<ColumnMetadata>(uniqueKey, metadata);
  };
}
