import { ColumnOption, Column } from "./Column";

/**
 * 수동 Primary Key 컬럼을 설정합니다.
 * auto-increment 없이 사용자가 직접 PK 값을 지정하는 컬럼에 사용합니다.
 *
 * 여러 컬럼에 @PrimaryColumn을 지정하면 복합 PK (Composite Primary Key)가 됩니다.
 *
 * @example
 * // 단일 PK
 * class User {
 *   @PrimaryColumn({ type: "varchar", length: 36 })
 *   id!: string;
 * }
 *
 * // 복합 PK
 * class OrderItem {
 *   @PrimaryColumn()
 *   orderId!: number;
 *
 *   @PrimaryColumn()
 *   productId!: number;
 * }
 */
export function PrimaryColumn(option?: ColumnOption): PropertyDecorator {
  return (target, propertyKey) => {
    Column({
      nullable: false,
      primary: true,
      ...option,
    })(target, propertyKey);
  };
}
