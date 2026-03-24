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

export interface AdvancedIndexOptions {
  /** Partial index WHERE clause (e.g., "active = true"). PostgreSQL/SQLite only. */
  where?: string;
  /** Expression index — replaces column list (e.g., "LOWER(email)"). */
  expression?: string;
  /** Index method: btree, hash, gist, gin, brin. MySQL only supports btree/hash. */
  using?: "btree" | "hash" | "gist" | "gin" | "brin";
  /** Covering index INCLUDE columns. PostgreSQL only. */
  include?: string[];
  /** Custom index name. Overrides auto-generated name. */
  name?: string;
}

export interface CompositeIndexMetadata {
  columns: string[];
  name?: string;
  options?: AdvancedIndexOptions;
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
/**
 * Class-level decorator to create a composite index with advanced options.
 *
 * @param columns - Column names to include in the index.
 * @param options - Advanced index options (where, expression, using, include, name).
 *
 * @example
 * ```ts
 * @Entity()
 * @Index(["email"], { where: "active = true", using: "btree" })
 * class User {
 *   @PrimaryGeneratedColumn()
 *   id!: number;
 *
 *   @Column()
 *   email!: string;
 *
 *   @Column()
 *   active!: boolean;
 * }
 * ```
 */
export function Index(columns: string[], options: AdvancedIndexOptions): ClassDecorator;
export function Index(
  columns?: string[],
  nameOrOptions?: string | AdvancedIndexOptions,
): PropertyDecorator | ClassDecorator {
  if (columns) {
    // Class-level composite index
    const isAdvanced = typeof nameOrOptions === "object" && nameOrOptions !== null;
    const name = typeof nameOrOptions === "string" ? nameOrOptions : (isAdvanced ? nameOrOptions.name : undefined);
    const options = isAdvanced ? nameOrOptions : undefined;

    return (target: any) => {
      const existing: CompositeIndexMetadata[] =
        Reflect.getMetadata(COMPOSITE_INDEX_TOKEN, target) ?? [];

      Reflect.defineMetadata(
        COMPOSITE_INDEX_TOKEN,
        [...existing, { columns, name, options }],
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
