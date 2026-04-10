import { KnownColumnType } from "./Column";

export interface DiscriminatorColumnOptions {
  /** Column name in the database. Default: "dtype" */
  name?: string;
  /** Column type. Default: "varchar" */
  type?: KnownColumnType;
  /** Column length (for varchar). Default: 31 */
  length?: number;
}

export const DISCRIMINATOR_COLUMN_TOKEN = Symbol.for(
  "STG_DISCRIMINATOR_COLUMN",
);

/**
 * Configures the discriminator column on the root entity of an inheritance hierarchy.
 * Must be used together with @Inheritance().
 *
 * For STI, this column lives in the single table.
 * For TPT/JOINED, this column lives in the root table.
 * For TPC, this decorator is ignored (no discriminator needed).
 *
 * @example
 * @Entity()
 * @Inheritance({ strategy: "SINGLE_TABLE" })
 * @DiscriminatorColumn({ name: "payment_type", type: "varchar", length: 50 })
 * class Payment { ... }
 */
export function DiscriminatorColumn(
  options?: DiscriminatorColumnOptions,
): ClassDecorator {
  return function (target) {
    const resolved = {
      name: options?.name ?? "dtype",
      type: options?.type ?? "varchar",
      length: options?.length ?? 31,
    };
    Reflect.defineMetadata(DISCRIMINATOR_COLUMN_TOKEN, resolved, target);
  };
}
