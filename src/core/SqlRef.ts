import { Sql, raw } from "../utils/sqlTag";
import type { ClazzType } from "../utils";
import { camelToSnakeCase } from "../utils/camelToSnakeCase";
import { ENTITY_TOKEN, EntityMetadata } from "../decorators/Entity";
import { COLUMN_TOKEN } from "../decorators/Column";
import type { ColumnMetadata } from "../scanner";
import { EntityMetadataNotFoundError } from "../errors/EntityMetadataNotFoundError";

/**
 * Typed reference to an entity for use inside `sql\`\`` templates.
 *
 * **Without alias** — `em.ref(Issue)`:
 *   - `${ref}`        → `"issue"`
 *   - `${ref.id}`     → `"id"`               (bare column)
 *   - `${ref.as("deletedAt")}` → `"deleted_at" AS "deletedAt"`
 *
 * **With alias** — `em.ref(Issue, "i")`:
 *   - `${ref}`        → `"issue" AS i`        (suitable for FROM/JOIN)
 *   - `${ref.id}`     → `i."id"`              (alias-qualified column)
 *   - `${ref.as("deletedAt")}` → `i."deleted_at" AS "deletedAt"`
 *
 * The alias is passed verbatim — it is the caller's responsibility to
 * use a valid SQL identifier. Quote/escape if you need exotic chars.
 */
export type SqlRef<T> = Sql & {
  [K in keyof T as T[K] extends Function ? never : K]: Sql;
} & {
  /**
   * Project a column with an outbound alias.
   *
   * Without alias: `"col" AS "asName"`. With alias: `"a"."col" AS "asName"`.
   * `asName` defaults to the property name when omitted.
   */
  as<K extends Exclude<keyof T, "as">>(prop: K, asName?: string): Sql;
};

const SQL_PASSTHROUGH = new Set<PropertyKey>([
  "values",
  "strings",
  "sql",
  "text",
  "inspect",
  "constructor",
  "toJSON",
  "toString",
  "valueOf",
  "then",
  // sql-template-tag's instanceof Sql check looks up Symbol.hasInstance / proto
  Symbol.toPrimitive,
  Symbol.iterator,
]);

interface SqlRefDeps {
  wrap(name: string): string;
  wrapTable(name: string): string;
  /**
   * Optional. When provided, FK backing properties (e.g. `parentId` of a
   * `parent!: Issue` relation) resolve to the FK column name even
   * without an explicit `@Column` decorator. Falls back to
   * `camelToSnakeCase(prop)` when the property is unknown.
   */
  collectFkPropertyMappings?(entity: ClazzType<unknown>): Map<string, string>;
}

/**
 * Build the property → DB column lookup. `@Column`s win; FK backing
 * properties from relations fill in unmapped names. Unknown properties
 * fall back to `camelToSnakeCase` at lookup time.
 */
function buildColumnMap(
  entity: ClazzType<unknown>,
  deps: SqlRefDeps,
): Map<string, string> {
  const map = new Map<string, string>();
  const cols: ColumnMetadata[] =
    Reflect.getMetadata(COLUMN_TOKEN, entity.prototype) ?? [];
  for (const col of cols) {
    if (col.propertyKey && col.name) {
      map.set(col.propertyKey, col.name);
    }
  }
  if (deps.collectFkPropertyMappings) {
    const fkMap = deps.collectFkPropertyMappings(entity);
    for (const [prop, col] of fkMap) {
      if (!map.has(prop)) map.set(prop, col);
    }
  }
  return map;
}

/**
 * Alias-only reference for CTEs, derived tables, and other constructs
 * that have no entity to bind against.
 *
 * - `${ref}`     → bare alias name (e.g. `t`), unquoted
 * - `${ref.col}` → `alias."col"` — property name is run through
 *   `camelToSnakeCase` and then wrapped with the dialect quoter
 *
 * Use this for recursive-CTE column refs that don't correspond to an
 * entity (e.g. a `depth` or `path` synthesized inside the CTE body).
 * For entity-bound aliases, use `em.ref(Entity, alias)`.
 */
export type AliasRef = Sql & {
  readonly [col: string]: Sql;
};

/**
 * Internal factory. Most callers should use `EntityManager.aliasRef()`.
 */
export function createAliasRef(
  alias: string,
  wrap: (name: string) => string,
): AliasRef {
  const aliasSql = raw(alias);
  return new Proxy(aliasSql, {
    get(target, prop, receiver) {
      if (SQL_PASSTHROUGH.has(prop)) {
        return Reflect.get(target, prop, receiver);
      }
      if (typeof prop !== "string") {
        return Reflect.get(target, prop, receiver);
      }
      const dbCol = camelToSnakeCase(prop);
      return raw(`${alias}.${wrap(dbCol)}`);
    },
  }) as unknown as AliasRef;
}

/**
 * Internal factory. Most callers should use `EntityManager.ref()` instead,
 * which wires the wrap/wrapTable helpers and the FK-property resolver
 * automatically.
 */
export function createEntitySqlRef<T>(
  entity: ClazzType<T>,
  deps: SqlRefDeps,
  alias?: string,
): SqlRef<T> {
  const meta = Reflect.getMetadata(ENTITY_TOKEN, entity) as
    | EntityMetadata
    | undefined;
  if (!meta) {
    throw new EntityMetadataNotFoundError(entity.name);
  }

  const colMap = buildColumnMap(entity as ClazzType<unknown>, deps);
  const tableName = deps.wrapTable(meta.name);
  // With an alias, ${ref} declares the table-and-alias for FROM/JOIN.
  // Aliases are emitted unquoted, matching standard `tbl AS a` convention.
  const tableSql = raw(alias ? `${tableName} AS ${alias}` : tableName);

  const resolveColumn = (prop: string): string => {
    const dbCol = colMap.get(prop) ?? camelToSnakeCase(prop);
    const wrapped = deps.wrap(dbCol);
    return alias ? `${alias}.${wrapped}` : wrapped;
  };

  return new Proxy(tableSql, {
    get(target, prop, receiver) {
      if (SQL_PASSTHROUGH.has(prop)) {
        return Reflect.get(target, prop, receiver);
      }
      if (typeof prop !== "string") {
        return Reflect.get(target, prop, receiver);
      }
      if (prop === "as") {
        return (col: string, asName?: string): Sql => {
          const qualified = resolveColumn(col);
          const out = deps.wrap(asName ?? col);
          return raw(`${qualified} AS ${out}`);
        };
      }
      return raw(resolveColumn(prop));
    },
  }) as unknown as SqlRef<T>;
}
