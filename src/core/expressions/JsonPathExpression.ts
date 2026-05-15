/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { Sql, raw, join } from "sql-template-tag";
import type {
  ColumnJsonMeta,
  DialectExpression,
} from "../../dialects/DialectExpression";
import type { ConditionLike, ColumnResolver } from "./ConditionLike";
import { AliasedExpression } from "./AliasedExpression";
import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";

function jsonPathDialectRequired(feature: string): OrmError {
  return new OrmError(
    OrmErrorCode.INVALID_QUERY,
    `${feature} requires a DialectExpression. Ensure the query builder was ` +
      "created via EntityManager.createQueryBuilder() — JSON path operators " +
      "render different SQL per dialect (`->>`, JSON_EXTRACT, json_extract), so a " +
      "builder without a dialect cannot pick the right form.",
  );
}

/**
 * A segment of a JSON navigation path.
 *
 * Strings navigate object keys (`{"a": {...}}` → `"a"`); numbers navigate array
 * indices (`[{...}, {...}]` → `0`).
 */
export type JsonPathSegment = string | number;

/**
 * The shape of the condition produced by a {@link JsonPathExpression}.
 *
 * @internal
 */
export type JsonConditionKind =
  | "compare"            // extract-as-text compared to a value via binary operator
  | "in"                 // extract-as-text IN (values)
  | "notIn"
  | "isNull"
  | "isNotNull"
  | "between"
  | "contains"           // delegates to DialectExpression.jsonContains
  | "hasKey"             // delegates to DialectExpression.jsonHasKey
  | "arrayLengthCompare" // jsonArrayLength(...) compared to a value
  | "typeOfCompare";     // jsonTypeOf(...) compared to a value

/**
 * Parse a dot-bracket JSON path string like `"profile.tags[0].name"` or
 * `'items["nested key"][2].value'` into individual segments.
 */
export function parseJsonPath(path: string): JsonPathSegment[] {
  const segs: JsonPathSegment[] = [];
  // Identifier chunk | [index] | ["quoted string"]
  const re = /([^.[\]"]+)|\[(\d+)\]|\["((?:[^"\\]|\\.)*)"\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    if (m[1] !== undefined) {
      segs.push(m[1]);
    } else if (m[2] !== undefined) {
      segs.push(Number(m[2]));
    } else if (m[3] !== undefined) {
      segs.push(m[3].replace(/\\(.)/g, "$1"));
    }
  }
  return segs;
}

/**
 * A deferred WHERE condition over a JSON path.
 *
 * Created by {@link JsonPathExpression} methods (`.eq()`, `.contains()`, etc.)
 * and resolved at build time by the query builder, which supplies both the
 * qualified column name and the target driver's {@link DialectExpression}.
 */
export class JsonPathCondition implements ConditionLike {
  readonly __isCondition = true as const;
  readonly __jsonPathCondition = true as const;
  constructor(
    readonly ref: string,
    readonly path: ReadonlyArray<JsonPathSegment>,
    readonly kind: JsonConditionKind,
    readonly operator?: string,
    readonly value?: unknown,
    readonly meta?: ColumnJsonMeta,
  ) {}

  /** @internal Resolve against a column resolver and dialect expression. */
  resolve(
    resolveColumn: ColumnResolver,
    dialectExpression?: DialectExpression,
  ): Sql {
    if (!dialectExpression) {
      throw jsonPathDialectRequired("JsonPathCondition.resolve()");
    }
    const column = resolveColumn(this.ref);
    const m = this.meta;
    switch (this.kind) {
      case "isNull": {
        const extract = dialectExpression.jsonExtract(column, this.path, true, m);
        return sql`${extract} IS NULL`;
      }
      case "isNotNull": {
        const extract = dialectExpression.jsonExtract(column, this.path, true, m);
        return sql`${extract} IS NOT NULL`;
      }
      case "compare": {
        const extract = dialectExpression.jsonExtract(column, this.path, true, m);
        return sql`${extract} ${raw(this.operator!)} ${this.value as any}`;
      }
      case "in":
      case "notIn": {
        const extract = dialectExpression.jsonExtract(column, this.path, true, m);
        const values = (this.value as unknown[]) ?? [];
        if (values.length === 0) {
          return this.kind === "in" ? sql`1 = 0` : sql`1 = 1`;
        }
        const op = this.kind === "in" ? "IN" : "NOT IN";
        const placeholders = values.map((v) => sql`${v as any}`);
        return sql`${extract} ${raw(op)} (${join(placeholders, ", ")})`;
      }
      case "between": {
        const extract = dialectExpression.jsonExtract(column, this.path, true, m);
        const [a, b] = this.value as [unknown, unknown];
        return sql`${extract} BETWEEN ${a as any} AND ${b as any}`;
      }
      case "contains":
        return dialectExpression.jsonContains(column, this.path, this.value, m);
      case "hasKey":
        return dialectExpression.jsonHasKey(column, this.path, this.value as string, m);
      case "arrayLengthCompare": {
        const lenExpr = dialectExpression.jsonArrayLength(column, this.path, m);
        return sql`${lenExpr} ${raw(this.operator!)} ${this.value as any}`;
      }
      case "typeOfCompare": {
        const typeExpr = dialectExpression.jsonTypeOf(column, this.path, m);
        return sql`${typeExpr} ${raw(this.operator!)} ${this.value as any}`;
      }
    }
  }
}

/**
 * Type guard — true if `value` is a {@link JsonPathCondition}.
 */
export function isJsonPathCondition(value: unknown): value is JsonPathCondition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as any).__jsonPathCondition === true
  );
}

/**
 * A scalar subexpression produced by `arrayLength()` or `typeOf()`.
 *
 * Exposes comparison operators that return {@link JsonPathCondition}s tagged
 * with the appropriate kind so the query builder can render the right
 * dialect-specific function call.
 */
export class JsonScalarExpression {
  constructor(
    private readonly ref: string,
    private readonly path: ReadonlyArray<JsonPathSegment>,
    private readonly scalarKind: "arrayLength" | "typeOf",
    private readonly meta?: ColumnJsonMeta,
  ) {}

  private get compareKind(): JsonConditionKind {
    return this.scalarKind === "arrayLength" ? "arrayLengthCompare" : "typeOfCompare";
  }

  private make(operator: string, value: unknown): JsonPathCondition {
    return new JsonPathCondition(
      this.ref,
      this.path,
      this.compareKind,
      operator,
      value,
      this.meta,
    );
  }

  eq(value: number | string): JsonPathCondition { return this.make("=", value); }
  neq(value: number | string): JsonPathCondition { return this.make("!=", value); }
  gt(value: number): JsonPathCondition { return this.make(">", value); }
  gte(value: number): JsonPathCondition { return this.make(">=", value); }
  lt(value: number): JsonPathCondition { return this.make("<", value); }
  lte(value: number): JsonPathCondition { return this.make("<=", value); }
}

/** @internal The set of method names that a JsonPathExpression proxy exposes. */
const JSON_EXPR_METHODS = new Set<string>([
  "_ref",
  "_path",
  "_meta",
  "_isJsonPathExpression",
  "path",
  "eq",
  "neq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "notLike",
  "in",
  "notIn",
  "isNull",
  "isNotNull",
  "between",
  "contains",
  "hasKey",
  "arrayLength",
  "typeOf",
  "as",
  "toString",
  "valueOf",
  "constructor",
]);

/**
 * Backing class for {@link JsonPathExpression}. Users interact with a `Proxy`
 * wrapping one of these; property access on the proxy that is not a method
 * name is treated as a JSON path segment extension.
 */
class JsonPathExpressionBase {
  readonly _isJsonPathExpression = true as const;
  constructor(
    readonly _ref: string,
    readonly _path: ReadonlyArray<JsonPathSegment>,
    readonly _meta?: ColumnJsonMeta,
  ) {}

  /** Append a dot-bracket path string (e.g. `"a.b[0].c"`). */
  path(str: string): JsonPathExpression {
    return makeJsonPathExpression(
      this._ref,
      [...this._path, ...parseJsonPath(str)],
      this._meta,
    );
  }

  eq(value: unknown): JsonPathCondition {
    return new JsonPathCondition(this._ref, this._path, "compare", "=", value, this._meta);
  }
  neq(value: unknown): JsonPathCondition {
    return new JsonPathCondition(this._ref, this._path, "compare", "!=", value, this._meta);
  }
  ne(value: unknown): JsonPathCondition {
    return new JsonPathCondition(this._ref, this._path, "compare", "!=", value, this._meta);
  }
  gt(value: unknown): JsonPathCondition {
    return new JsonPathCondition(this._ref, this._path, "compare", ">", value, this._meta);
  }
  gte(value: unknown): JsonPathCondition {
    return new JsonPathCondition(this._ref, this._path, "compare", ">=", value, this._meta);
  }
  lt(value: unknown): JsonPathCondition {
    return new JsonPathCondition(this._ref, this._path, "compare", "<", value, this._meta);
  }
  lte(value: unknown): JsonPathCondition {
    return new JsonPathCondition(this._ref, this._path, "compare", "<=", value, this._meta);
  }
  like(pattern: string): JsonPathCondition {
    return new JsonPathCondition(this._ref, this._path, "compare", "LIKE", pattern, this._meta);
  }
  notLike(pattern: string): JsonPathCondition {
    return new JsonPathCondition(
      this._ref,
      this._path,
      "compare",
      "NOT LIKE",
      pattern,
      this._meta,
    );
  }

  in(values: unknown[]): JsonPathCondition {
    return new JsonPathCondition(this._ref, this._path, "in", undefined, values, this._meta);
  }
  notIn(values: unknown[]): JsonPathCondition {
    return new JsonPathCondition(this._ref, this._path, "notIn", undefined, values, this._meta);
  }
  isNull(): JsonPathCondition {
    return new JsonPathCondition(this._ref, this._path, "isNull", undefined, undefined, this._meta);
  }
  isNotNull(): JsonPathCondition {
    return new JsonPathCondition(
      this._ref,
      this._path,
      "isNotNull",
      undefined,
      undefined,
      this._meta,
    );
  }
  between(min: unknown, max: unknown): JsonPathCondition {
    return new JsonPathCondition(
      this._ref,
      this._path,
      "between",
      undefined,
      [min, max],
      this._meta,
    );
  }

  /** JSON containment: does the sub-document at this path contain `value`? */
  contains(value: unknown): JsonPathCondition {
    return new JsonPathCondition(
      this._ref,
      this._path,
      "contains",
      undefined,
      value,
      this._meta,
    );
  }

  /** Does the object at this path have the given key? */
  hasKey(key: string): JsonPathCondition {
    return new JsonPathCondition(
      this._ref,
      this._path,
      "hasKey",
      undefined,
      key,
      this._meta,
    );
  }

  /** Length of the array at this path, as a comparable scalar. */
  arrayLength(): JsonScalarExpression {
    return new JsonScalarExpression(this._ref, this._path, "arrayLength", this._meta);
  }

  /** JSON type at this path (`'object'`, `'array'`, `'string'`, …), as a comparable scalar. */
  typeOf(): JsonScalarExpression {
    return new JsonScalarExpression(this._ref, this._path, "typeOf", this._meta);
  }

  /**
   * Tag this JSON extraction for SELECT with a result alias.
   *
   * Emits a dialect-specific extraction (`JSON_UNQUOTE(JSON_EXTRACT(…))`
   * on MySQL, `#>>` on PostgreSQL, `json_extract()` on SQLite) returned
   * as text, followed by `AS <alias>`. Only meaningful when passed to
   * `select()` / `addSelect()`.
   *
   * @example
   * ```ts
   * qb.select([u.metadata.profile.email.as("contact")]).getRawMany();
   * ```
   */
  as(alias: string): AliasedExpression {
    const ref = this._ref;
    const path = this._path;
    const meta = this._meta;
    return new AliasedExpression(alias, (resolveColumn, dialect) => {
      if (!dialect) {
        throw jsonPathDialectRequired("JsonPathExpression.as()");
      }
      return dialect.jsonExtract(resolveColumn(ref), path, true, meta);
    });
  }

  toString(): string {
    if (this._path.length === 0) return this._ref;
    return `${this._ref}:${this._path.join(".")}`;
  }
}

/**
 * A typed JSON-column navigator with condition builders.
 *
 * @example
 * ```ts
 * const u = qAlias(User, "u");
 * qb.where(u.metadata.profile.email.eq("alice@example.com"))
 *   .andWhere(u.metadata.path("tags[0].name").like("%admin%"))
 *   .andWhere(u.metadata.hasKey("profile"))
 *   .andWhere(u.metadata.tags.arrayLength().gt(3));
 * ```
 */
export type JsonPathExpression = JsonPathExpressionBase & {
  readonly [key: string]: JsonPathExpression;
} & {
  readonly [index: number]: JsonPathExpression;
};

/**
 * @internal Build a proxy-wrapped {@link JsonPathExpression} for the given
 * column reference and initial path.
 */
export function makeJsonPathExpression(
  ref: string,
  path: ReadonlyArray<JsonPathSegment> = [],
  meta?: ColumnJsonMeta,
): JsonPathExpression {
  const base = new JsonPathExpressionBase(ref, path, meta);
  return new Proxy(base, {
    get(target: JsonPathExpressionBase, prop: string | symbol): unknown {
      if (typeof prop === "symbol") return (target as any)[prop];
      if (JSON_EXPR_METHODS.has(prop)) {
        return (target as any)[prop];
      }
      const seg: JsonPathSegment = /^-?\d+$/.test(prop) ? Number(prop) : prop;
      return makeJsonPathExpression(target._ref, [...target._path, seg], target._meta);
    },
  }) as JsonPathExpression;
}

/** Type guard — true if `value` is a `JsonPathExpression`. */
export function isJsonPathExpression(value: unknown): value is JsonPathExpression {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as any)._isJsonPathExpression === true
  );
}
