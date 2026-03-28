import { ColumnOption, Column } from "./Column";

/**
 * Auto-generated primary key generation strategy.
 *
 * - `"increment"` (default): auto-increment integer (INT AUTO_INCREMENT / SERIAL)
 * - `"uuid"`: UUIDv4 — PG: `DEFAULT gen_random_uuid()`, MySQL/SQLite: app-side `crypto.randomUUID()`
 * - `"uuid-v7"`: UUIDv7 time-sortable — app-side generation on all drivers (RFC 9562)
 */
export type GenerationStrategy = "increment" | "uuid" | "uuid-v7";

/**
 * Marks a property as an auto-generated primary key column.
 *
 * @example
 * // Auto-increment integer (default)
 * @PrimaryGeneratedColumn()
 * id!: number;
 *
 * // UUIDv4
 * @PrimaryGeneratedColumn("uuid")
 * id!: string;
 *
 * // UUIDv7 (time-sortable)
 * @PrimaryGeneratedColumn("uuid-v7")
 * id!: string;
 *
 * // With additional options
 * @PrimaryGeneratedColumn("uuid", { name: "pk_id" })
 * id!: string;
 */
export function PrimaryGeneratedColumn(
  strategyOrOption?: GenerationStrategy | ColumnOption,
  option?: ColumnOption,
): PropertyDecorator {
  return (target, propertyKey) => {
    let strategy: GenerationStrategy = "increment";
    let opts: ColumnOption = {};

    if (typeof strategyOrOption === "string") {
      strategy = strategyOrOption;
      opts = option ?? {};
    } else if (strategyOrOption) {
      opts = strategyOrOption;
    }

    if (strategy === "uuid" || strategy === "uuid-v7") {
      Column({
        type: "uuid",
        length: 36,
        nullable: false,
        primary: true,
        autoIncrement: false,
        generationStrategy: strategy,
        ...opts,
      })(target, propertyKey);
    } else {
      // increment (default)
      Column({
        primary: true,
        length: 11,
        nullable: false,
        autoIncrement: true,
        type: "int",
        generationStrategy: "increment",
        ...opts,
      })(target, propertyKey);
    }
  };
}
