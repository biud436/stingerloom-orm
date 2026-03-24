export const FULLTEXT_INDEX_TOKEN = Symbol.for("STG_FULLTEXT_INDEX");

export interface FullTextIndexMetadata {
  columns: string[];
  name?: string;
  /** PostgreSQL text search configuration (default: 'english'). */
  language?: string;
}

/**
 * Class-level decorator to declare a full-text search index on an entity.
 *
 * - PostgreSQL: Creates a GIN index using `to_tsvector`.
 * - MySQL: Creates a FULLTEXT index.
 * - SQLite: Not supported (no DDL generated).
 *
 * @param columns - Column names to include in the full-text index.
 * @param options - Optional index name and language configuration.
 *
 * @example
 * ```ts
 * @Entity()
 * @FullTextIndex(["title", "content"])
 * class Post {
 *   @PrimaryGeneratedColumn()
 *   id!: number;
 *
 *   @Column()
 *   title!: string;
 *
 *   @Column({ type: "text" })
 *   content!: string;
 * }
 * ```
 */
export function FullTextIndex(
  columns: string[],
  options?: { name?: string; language?: string },
): ClassDecorator {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (target: any) => {
    const existing: FullTextIndexMetadata[] =
      Reflect.getMetadata(FULLTEXT_INDEX_TOKEN, target) ?? [];

    Reflect.defineMetadata(
      FULLTEXT_INDEX_TOKEN,
      [
        ...existing,
        {
          columns,
          name: options?.name,
          language: options?.language,
        },
      ],
      target,
    );
  };
}
