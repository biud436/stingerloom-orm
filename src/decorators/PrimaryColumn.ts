import { ColumnOption, Column } from "./Column";

/**
 * Declares a manual Primary Key column.
 * Used when the PK value is supplied by the user rather than auto-generated.
 *
 * Applying @PrimaryColumn to multiple properties creates a composite primary key.
 *
 * @example
 * // Single PK
 * class User {
 *   @PrimaryColumn({ type: "varchar", length: 36 })
 *   id!: string;
 * }
 *
 * // Composite PK
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
