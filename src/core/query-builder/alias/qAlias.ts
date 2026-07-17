/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../../../utils/types";
import { COLUMN_TOKEN } from "../../../decorators/Column";
import type { ColumnMetadata } from "../../../scanner/ColumnScanner";
import type { ColumnJsonMeta } from "../../../dialects/DialectExpression";
import {
  makeJsonPathExpression,
  type JsonPathExpression,
} from "../../expressions/JsonPathExpression";
import { ColumnExpression } from "../expression/ColumnExpression";
import type { EntityRef } from "./EntityRef";

/**
 * Mapped type: transforms entity properties into `ColumnExpression` accessors,
 * with JSON-typed properties surfaced as `JsonPathExpression` for deep navigation.
 */
export type QEntity<T> = {
  readonly [K in keyof T & string]: T[K] extends
    | string
    | number
    | boolean
    | bigint
    | Date
    | null
    | undefined
    ? ColumnExpression
    : // Primitive-element arrays are PostgreSQL `type: "array"` columns —
      // map them to ColumnExpression (which carries arrayContains / overlaps
      // / containedBy), matching the runtime proxy that returns a plain
      // ColumnExpression for any non-json/jsonb column. Arrays of objects
      // (JSONB documents) fall through to the JSON-path expression below.
      NonNullable<T[K]> extends readonly (
          | string
          | number
          | boolean
          | bigint
          | Date
        )[]
      ? ColumnExpression
      : T[K] extends object
        ? JsonPathExpression
        : ColumnExpression;
} & EntityRef<T> & QEntityDynamicAccess;

/**
 * Dynamic field access for `qAlias()` proxies. Use these when the column
 * name is only known at runtime (e.g. user-supplied filter DSLs). Always
 * pass values from a server-side allowlist — these methods do not validate
 * the name themselves.
 */
export interface QEntityDynamicAccess {
  /**
   * Type-erased dynamic column accessor. Returns a {@link ColumnExpression}
   * for the given property name without requiring the call site to cast
   * through `unknown` / `Record<string, any>`.
   *
   * Use after allowlist validation when the column name is dynamic:
   *
   * ```ts
   * const i = qAlias(Issue, "i");
   * if (!ALLOWED_FIELDS.has(name)) throw new Error("…");
   * i.field(name).eq(value);
   * ```
   */
  field(name: string): ColumnExpression;
  /**
   * Type-erased dynamic JSON column accessor. Returns a
   * {@link JsonPathExpression} for the given JSON-typed property name.
   *
   * Only valid for columns declared with `@Column({ type: "json" | "jsonb" })`.
   * If the column is not registered as JSON, calls fall back to a
   * `ColumnExpression`-style proxy without dialect-aware path operators.
   */
  jsonField(name: string): JsonPathExpression;
}

/**
 * @internal Collect a map of TypeScript property keys → JSON column metadata
 * (`dbType`, `nullable`) for `@Column({ type: "json" | "jsonb" })` declarations.
 *
 * Needed so `qAlias()` can thread storage-type information into
 * {@link JsonPathExpression} proxies; {@link DialectExpression} implementations
 * can then branch on `json` vs `jsonb` (relevant for PostgreSQL, which exposes
 * native operators/GIN only on `jsonb`).
 */
function collectJsonColumnMeta(
  entity: ClazzType<any>,
): Map<string, ColumnJsonMeta> {
  const columns: ColumnMetadata[] =
    Reflect.getMetadata(COLUMN_TOKEN, entity.prototype) ??
    Reflect.getMetadata(COLUMN_TOKEN, entity) ??
    [];
  const out = new Map<
    string,
    ColumnJsonMeta
  >();
  for (const col of columns) {
    const type = col.options?.type;
    if (type === "json" || type === "jsonb") {
      const key = col.propertyKey ?? col.name;
      if (key) {
        out.set(key, {
          dbType: type as "json" | "jsonb",
          nullable: col.options?.nullable === true,
        });
      }
    }
  }
  return out;
}

/**
 * Create a QueryDSL-style typed entity reference with property-level expressions.
 *
 * Unlike `alias()` which requires `.col("name")`, `qAlias()` exposes entity
 * properties directly — each one is a `ColumnExpression` with `.eq()`, `.like()`,
 * `.gte()`, etc. Methods return `ColumnCondition` objects that the query builder
 * resolves through its alias registry (respecting SnakeNamingStrategy).
 *
 * @example
 * ```ts
 * const u = qAlias(User, "u");
 * const p = qAlias(Post, "p");
 *
 * em.createQueryBuilder(Post, "p")
 *   .leftJoin(User, "u", (j) => j.on(p.col("authorId"), "=", u.col("id")))
 *   .where(u.firstName.eq("Alice"))           // auto-complete ✓
 *   .where(u.age.gte(18))                     // auto-complete ✓
 *   .where(p.status.in(["active", "draft"]))  // auto-complete ✓
 *   .where(u.deletedAt.isNull())              // auto-complete ✓
 *   .getRawMany();
 * ```
 */
/**
 * @internal Root-proxy cache for `qAlias()`. Keyed first by entity class via
 * a WeakMap (entries auto-collect when the class is GC'd), then by alias
 * name. Safe because the root proxy is immutable: the `get` trap branches
 * purely on `(entity, name, prop)` and forwards to fresh `ColumnExpression`
 * / `JsonPathExpression` objects on every property access. Child proxies
 * are not cached — they carry path state and are path-unique per chain.
 */
const qAliasProxyCache = new WeakMap<
  ClazzType<any>,
  Map<string, QEntity<any>>
>();

/**
 * @internal Memoized JSON-column-meta lookup. `collectJsonColumnMeta` scans
 * Reflect metadata on every call; caching it per entity drops the scan from
 * the qAlias hot path.
 */
const qAliasJsonMetaCache = new WeakMap<
  ClazzType<any>,
  Map<string, ColumnJsonMeta>
>();

export function qAlias<T>(entity: ClazzType<T>, name: string): QEntity<T> {
  let byName = qAliasProxyCache.get(entity);
  if (byName) {
    const cached = byName.get(name);
    if (cached) return cached as QEntity<T>;
  } else {
    byName = new Map();
    qAliasProxyCache.set(entity, byName);
  }

  let jsonMeta = qAliasJsonMetaCache.get(entity);
  if (!jsonMeta) {
    jsonMeta = collectJsonColumnMeta(entity);
    qAliasJsonMetaCache.set(entity, jsonMeta);
  }

  const proxy = new Proxy({} as any, {
    get(_target: any, prop: string | symbol): any {
      if (typeof prop === "symbol") return undefined;
      if (prop === "_alias") return name;
      if (prop === "_entity") return entity;
      if (prop === "col") {
        return (column: string) => `${name}.${column}`;
      }
      if (prop === "field") {
        return (column: string): ColumnExpression => {
          const m = jsonMeta!.get(column);
          // jsonField() is the dialect-aware accessor for JSON columns;
          // field() always returns a plain ColumnExpression so dynamic
          // call sites can compare a JSON column for equality, IS NULL,
          // etc. without a path traversal.
          if (m) return new ColumnExpression(`${name}.${column}`);
          return new ColumnExpression(`${name}.${column}`);
        };
      }
      if (prop === "jsonField") {
        return (column: string): JsonPathExpression => {
          const m = jsonMeta!.get(column);
          if (m) {
            return makeJsonPathExpression(`${name}.${column}`, [], m);
          }
          // Column was not registered as JSON. Fall back to a JSON
          // expression with a default `json` dbType so callers still
          // get a usable path-traversal API; downstream dialect rendering
          // will surface a clearer error if the column is not actually
          // JSON-typed in the database.
          return makeJsonPathExpression(`${name}.${column}`, [], {
            dbType: "json",
            nullable: true,
          });
        };
      }
      if (prop === "toString" || prop === "valueOf") {
        return () => name;
      }
      const meta = jsonMeta!.get(prop);
      if (meta) {
        return makeJsonPathExpression(`${name}.${prop}`, [], meta);
      }
      return new ColumnExpression(`${name}.${prop}`);
    },
  }) as QEntity<T>;

  byName.set(name, proxy);
  return proxy;
}

/**
 * @internal Drop cached qAlias proxies + JSON-column metadata for a single
 * entity. Exposed for testing environments that redefine entity columns
 * between suites (the scanners already offer `.clear()` for the same
 * purpose); production code does not need this.
 */
export function __clearQAliasCache(entity?: ClazzType<any>): void {
  if (entity) {
    qAliasProxyCache.delete(entity);
    qAliasJsonMetaCache.delete(entity);
    return;
  }
  // No full-wipe helper available on WeakMap; callers that want a fresh
  // table should pass entity references individually.
}
