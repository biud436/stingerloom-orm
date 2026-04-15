import { parseJsonPath } from "../core/expressions/JsonPathExpression";

export const JSON_INDEX_TOKEN = Symbol.for("STG_ORM_JSON_INDEX");

/**
 * Options for {@link JsonIndex}.
 */
export interface JsonIndexOptions {
  /**
   * Dot-bracket JSON path inside the column (e.g. `"tags"`, `"contact.email"`,
   * `"tags[0]"`). Omit to index the whole column.
   */
  path?: string;

  /**
   * Index access method. Defaults to `"gin"` on PostgreSQL, which is the
   * standard choice for jsonb containment (`@>`) / key-existence (`?`) queries.
   *
   * `"btree"` is useful for leaf scalar paths (`"contact.email"`) where the
   * expression resolves to text and you want equality / range scans.
   */
  using?: "gin" | "btree";

  /**
   * PostgreSQL jsonb opclass.
   *
   * - `"jsonb_ops"` (default) — supports all jsonb operators, larger index.
   * - `"jsonb_path_ops"` — `@>` only, smaller and faster lookups. Preferred
   *   when the index exists solely to accelerate containment queries.
   *
   * Ignored on non-jsonb columns and non-PostgreSQL dialects.
   */
  opclass?: "jsonb_ops" | "jsonb_path_ops";

  /**
   * Partial-index `WHERE` clause (PostgreSQL only). Kept as a raw SQL
   * fragment — caller is responsible for identifier wrapping and parameter
   * safety.
   */
  where?: string;

  /** Custom index name. Auto-generated from table/column/path if omitted. */
  name?: string;
}

/**
 * @internal Persisted metadata for each `@JsonIndex` declaration.
 */
export interface JsonIndexMetadata {
  /** The JS property the index is declared on (not the DB column name). */
  propertyKey: string;
  /** Parsed path segments. `[]` when no `path` option was provided. */
  pathSegments: ReadonlyArray<string | number>;
  options: JsonIndexOptions;
}

/**
 * Property-level decorator that declares an expression index over a JSON
 * column or a specific JSON path. Pair it with `@Column({ type: "jsonb" })`
 * so QueryDSL operations (`u.profile.tags.contains("x")`) get matched to
 * the index.
 *
 * Dialect behavior:
 *
 * - **PostgreSQL**: emits `CREATE INDEX ... USING gin ((col -> 'path')
 *   [jsonb_path_ops])`. Whole-column indexes use `USING gin (col)`; leaf
 *   `btree` indexes use `((col #>> '{path}'))`.
 * - **MySQL**: no DDL is emitted. MySQL 8 supports functional indexes on
 *   JSON only via virtual generated columns, which is a structural schema
 *   change beyond the scope of an index declaration; users should create
 *   those columns explicitly. A warning is logged at DDL generation time.
 * - **SQLite**: no DDL is emitted; SQLite has no GIN equivalent.
 *
 * @example Single-path GIN index (containment queries).
 * ```ts
 * @Entity()
 * class User {
 *   @Column({ type: "jsonb" })
 *   @JsonIndex({ path: "tags", using: "gin", opclass: "jsonb_path_ops" })
 *   profile!: UserProfile;
 * }
 * ```
 *
 * @example Whole-column GIN (all @> / ? queries).
 * ```ts
 * @Column({ type: "jsonb" })
 * @JsonIndex({ using: "gin" })
 * profile!: UserProfile;
 * ```
 *
 * @example Leaf btree on a text path.
 * ```ts
 * @Column({ type: "jsonb" })
 * @JsonIndex({ path: "contact.email", using: "btree" })
 * profile!: UserProfile;
 * ```
 */
export function JsonIndex(options: JsonIndexOptions = {}): PropertyDecorator {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (target: any, propertyKey: string | symbol) => {
    if (typeof propertyKey === "symbol") {
      throw new Error("@JsonIndex must be used on a named property.");
    }
    const cls = target.constructor;
    const existing: JsonIndexMetadata[] =
      Reflect.getMetadata(JSON_INDEX_TOKEN, cls) ?? [];

    const pathSegments = options.path ? parseJsonPath(options.path) : [];
    existing.push({
      propertyKey,
      pathSegments,
      options,
    });
    Reflect.defineMetadata(JSON_INDEX_TOKEN, existing, cls);
  };
}
