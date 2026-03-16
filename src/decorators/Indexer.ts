/* eslint-disable @typescript-eslint/no-explicit-any */

import { ReflectManager } from "../utils/ReflectManager";

export interface IndexOption {
  name?: string;
}

export interface IndexMetadata {
  target: any;
  name: string;
  type: any;
}

export const INDEX_TOKEN = Symbol.for("STG_ORM_INDEX");

export interface CompositeIndexMetadata {
  columns: string[];
  name?: string;
}

export const COMPOSITE_INDEX_TOKEN = Symbol.for("STG_ORM_COMPOSITE_INDEX");

/**
 * Property-level decorator to create a single-column index.
 */
export function Index(): PropertyDecorator;
/**
 * Class-level decorator to create a composite (multi-column) non-unique index.
 *
 * @param columns - Column names to include in the index.
 * @param name - Optional index name. Auto-generated if not provided.
 *
 * @example
 * ```ts
 * @Entity()
 * @Index(["tenantId", "status"])
 * class Order {
 *   @PrimaryGeneratedColumn()
 *   id!: number;
 *
 *   @Column()
 *   tenantId!: number;
 *
 *   @Column()
 *   status!: string;
 * }
 * ```
 */
export function Index(columns: string[], name?: string): ClassDecorator;
export function Index(
  columns?: string[],
  name?: string,
): PropertyDecorator | ClassDecorator {
  if (columns) {
    // Class-level composite index
    return (target: any) => {
      const existing: CompositeIndexMetadata[] =
        Reflect.getMetadata(COMPOSITE_INDEX_TOKEN, target) ?? [];

      Reflect.defineMetadata(
        COMPOSITE_INDEX_TOKEN,
        [...existing, { columns, name }],
        target,
      );
    };
  }

  // Property-level single-column index
  return (target: any, propertyKey?: string | symbol) => {
    if (propertyKey === undefined) {
      throw new Error("@Index() without columns must be used as a PropertyDecorator");
    }
    const injectParam = ReflectManager.getType<any>(target, propertyKey);

    const indexes = Reflect.getMetadata(INDEX_TOKEN, target);

    Reflect.defineMetadata(
      INDEX_TOKEN,
      [
        ...(indexes || []),
        {
          target,
          name: propertyKey.toString(),
          type: injectParam,
        },
      ],
      target,
    );
  };
}
