import { Sql, raw } from "sql-template-tag";
import type { ClazzType } from "../utils";
import { camelToSnakeCase } from "../utils/camelToSnakeCase";
import { ENTITY_TOKEN, EntityMetadata } from "../decorators/Entity";
import { COLUMN_TOKEN } from "../decorators/Column";
import type { ColumnMetadata } from "../scanner";
import { EntityMetadataNotFoundError } from "../errors/EntityMetadataNotFoundError";

/**
 * Typed reference to an entity for use inside `sql\`\`` templates.
 *
 * Interpolating the ref itself (`${Issue}`) renders the wrapped (and,
 * for PostgreSQL, tenant-qualified) table identifier. Property access
 * (`${Issue.id}`) renders the bare wrapped column identifier — never
 * with a table prefix, so callers stay free to add `c.` aliases
 * literally in the SQL when disambiguation is needed.
 *
 * `.as(prop, asName?)` produces `"col" AS "asName"` for SELECT lists.
 */
export type SqlRef<T> = Sql & {
  [K in keyof T as T[K] extends Function ? never : K]: Sql;
} & {
  /**
   * Project a column with an outbound alias: `"col" AS "asName"`.
   * Defaults to the property's own name when `asName` is omitted.
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
 * Internal factory. Most callers should use `EntityManager.ref()` instead,
 * which wires the wrap/wrapTable helpers and the FK-property resolver
 * automatically.
 */
export function createEntitySqlRef<T>(
  entity: ClazzType<T>,
  deps: SqlRefDeps,
): SqlRef<T> {
  const meta = Reflect.getMetadata(ENTITY_TOKEN, entity) as
    | EntityMetadata
    | undefined;
  if (!meta) {
    throw new EntityMetadataNotFoundError(entity.name);
  }

  const colMap = buildColumnMap(entity as ClazzType<unknown>, deps);
  const tableSql = raw(deps.wrapTable(meta.name));

  const resolveColumn = (prop: string): string => {
    const dbCol = colMap.get(prop) ?? camelToSnakeCase(prop);
    return deps.wrap(dbCol);
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
          const wrappedCol = resolveColumn(col);
          const out = deps.wrap(asName ?? col);
          return raw(`${wrappedCol} AS ${out}`);
        };
      }
      return raw(resolveColumn(prop));
    },
  }) as unknown as SqlRef<T>;
}
