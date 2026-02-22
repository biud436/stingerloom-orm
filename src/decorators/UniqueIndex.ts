export interface UniqueIndexMetadata {
  columns: string[];
  name?: string;
}

export const UNIQUE_INDEX_TOKEN = Symbol.for("STG_ORM_UNIQUE_INDEX");

/**
 * Class-level decorator to declare composite unique indexes on an entity.
 *
 * @param columns - Column names to include in the unique index.
 * @param name - Optional index name. Auto-generated if not provided.
 *
 * @example
 * ```ts
 * @Entity()
 * @UniqueIndex(["email", "tenantId"])
 * class User {
 *   @PrimaryGeneratedColumn()
 *   id!: number;
 *
 *   @Column()
 *   email!: string;
 *
 *   @Column()
 *   tenantId!: number;
 * }
 * ```
 */
export function UniqueIndex(
  columns: string[],
  name?: string,
): ClassDecorator {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (target: any) => {
    const existing: UniqueIndexMetadata[] =
      Reflect.getMetadata(UNIQUE_INDEX_TOKEN, target) ?? [];

    Reflect.defineMetadata(
      UNIQUE_INDEX_TOKEN,
      [...existing, { columns, name }],
      target,
    );
  };
}
