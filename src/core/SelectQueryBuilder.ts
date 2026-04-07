/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { Sql, raw, join } from "sql-template-tag";
import { Conditions } from "./Conditions";
import { EntityManager } from "./EntityManager";
import { ClazzType } from "../utils/types";
import { RawQueryBuilder } from "./RawQueryBuilder";
import { RawQueryBuilderFactory } from "./RawQueryBuilderFactory";
import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";
import { EntityNotFoundError } from "../errors/EntityNotFoundError";
import { DeserializerRegistry } from "./deserializer/DeserializerRegistry";
import { COLUMN_TOKEN } from "../decorators/Column";
import type { ColumnMetadata } from "../scanner/ColumnScanner";
import type { DialectExpression } from "../dialects/DialectExpression";
import type { RelationMetadataResolver } from "./RelationMetadataResolver";
import type { EntityScannerMetadata } from "../scanner";

/**
 * Entry in the alias registry: maps a table alias to its entity metadata.
 */
interface AliasEntry {
  entity: ClazzType<any>;
  tableName: string;
  propertyToColumnMap: Map<string, string>;
}

/**
 * Fluent builder for JOIN ON conditions.
 *
 * Used with entity-aware joins to build type-safe ON clauses
 * using entity property names instead of raw column names.
 *
 * @example
 * ```ts
 * qb.leftJoin(User, "u", (join) =>
 *   join.on("p.userId", "=", "u.id")
 * )
 * ```
 */
export class JoinOnBuilder {
  private conditions: Sql[] = [];

  constructor(
    private readonly columnResolver: (ref: string) => string,
  ) {}

  /**
   * Add an ON condition comparing two column references.
   * Both sides are resolved through the alias registry.
   *
   * @example join.on("p.userId", "=", "u.id")
   */
  on(leftRef: string, operator: string, rightRef: string): this {
    const left = this.columnResolver(leftRef);
    const right = this.columnResolver(rightRef);
    this.conditions.push(Conditions.compareColumns(left, operator, right));
    return this;
  }

  /**
   * Alias for `on()` — add additional ON condition with AND semantics.
   */
  andOn(leftRef: string, operator: string, rightRef: string): this {
    return this.on(leftRef, operator, rightRef);
  }

  /**
   * Add an ON condition comparing a column to a literal value.
   *
   * @example join.onVal("p.status", "=", "published")
   */
  onVal(ref: string, operator: string, value: any): this {
    const col = this.columnResolver(ref);
    const op = operator.trim().toUpperCase();
    this.conditions.push(sql`${raw(col)} ${raw(op)} ${value}`);
    return this;
  }

  /** @internal Build the combined ON condition. */
  build(): Sql {
    if (this.conditions.length === 0) {
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        "JOIN ON condition is empty. Use .on() to specify at least one condition.",
      );
    }
    if (this.conditions.length === 1) return this.conditions[0];
    return Conditions.and(this.conditions);
  }
}

/**
 * A typed reference to an aliased entity, providing auto-complete for column names.
 *
 * @example
 * ```ts
 * const u = alias(User, "u");
 * u.col("firstName")  // autocomplete! returns "u.firstName"
 * ```
 */
export interface EntityRef<T> {
  /** The table alias string. */
  readonly _alias: string;
  /** The entity class. */
  readonly _entity: ClazzType<T>;
  /**
   * Create a qualified column reference string: `"alias.property"`.
   * TypeScript auto-completes the column parameter from `keyof T`.
   */
  col<K extends keyof T & string>(column: K): string;
}

/**
 * Create a typed entity reference for use with SelectQueryBuilder.
 *
 * The returned `EntityRef` provides **auto-complete** for column names
 * via the `.col()` method. At runtime, `.col("firstName")` simply
 * returns `"u.firstName"` — which `resolveColumn()` translates to
 * the actual DB column name (e.g. `"u"."first_name"` with SnakeNamingStrategy).
 *
 * @example
 * ```ts
 * const u = alias(User, "u");
 * const p = alias(Post, "p");
 *
 * em.createQueryBuilder(Post, "p")
 *   .leftJoin(User, "u", (j) => j.on(p.col("authorId"), "=", u.col("id")))
 *   .where(u.col("firstName"), "LIKE", "%John%")   // auto-complete ✓
 *   .where(p.col("status"), "published")             // auto-complete ✓
 *   .addOrderBy(u.col("lastName"), "ASC")            // auto-complete ✓
 *   .getRawMany();
 * ```
 */
export function alias<T>(entity: ClazzType<T>, name: string): EntityRef<T> {
  return {
    _alias: name,
    _entity: entity,
    col: <K extends keyof T & string>(column: K): string =>
      `${name}.${column}`,
  };
}

// ── QueryDSL-style expressions ────────────────────────────

/**
 * A deferred WHERE condition that carries the column reference (unresolved)
 * and resolves it through the query builder's alias registry at build time.
 *
 * Created by `ColumnExpression` methods like `.eq()`, `.like()`, etc.
 * Passed directly to `where()`, `andWhere()`, `orWhere()`.
 */
export class ColumnCondition {
  readonly __columnCondition = true as const;
  constructor(
    readonly ref: string,
    readonly operator: string,
    readonly value: any,
  ) {}

  /** @internal Resolve the column reference and produce final SQL. */
  resolve(resolveColumn: (ref: string) => string): Sql {
    const qualified = resolveColumn(this.ref);
    switch (this.operator) {
      case "=":
        if (this.value === null) return Conditions.isNull(qualified);
        if (Array.isArray(this.value)) return Conditions.in(qualified, this.value);
        return Conditions.equals(qualified, this.value);
      case "!=":
      case "<>":
        return Conditions.notEquals(qualified, this.value);
      case ">":
        return Conditions.gt(qualified, this.value);
      case ">=":
        return Conditions.gte(qualified, this.value);
      case "<":
        return Conditions.lt(qualified, this.value);
      case "<=":
        return Conditions.lte(qualified, this.value);
      case "LIKE":
        return Conditions.like(qualified, this.value);
      case "NOT LIKE":
        return Conditions.notLike(qualified, this.value);
      case "IN":
        return Conditions.in(qualified, this.value);
      case "NOT IN":
        return Conditions.notIn(qualified, this.value);
      case "IS NULL":
        return Conditions.isNull(qualified);
      case "IS NOT NULL":
        return Conditions.isNotNull(qualified);
      case "BETWEEN":
        return Conditions.between(qualified, this.value[0], this.value[1]);
      default:
        return sql`${raw(qualified)} ${raw(this.operator)} ${this.value}`;
    }
  }
}

/**
 * A typed column expression providing QueryDSL-style condition builders.
 *
 * Each method returns a `ColumnCondition` that can be passed directly
 * to `where()`, `andWhere()`, or `orWhere()`.
 *
 * @example
 * ```ts
 * const u = qAlias(User, "u");
 * qb.where(u.firstName.eq("Alice"))
 *   .where(u.age.gte(18))
 *   .where(u.name.like("%John%"))
 *   .where(u.status.in(["active", "pending"]))
 *   .where(u.deletedAt.isNull())
 * ```
 */
export class ColumnExpression {
  constructor(private readonly ref: string) {}

  /** `column = value` */
  eq(value: any): ColumnCondition { return new ColumnCondition(this.ref, "=", value); }
  /** `column != value` */
  neq(value: any): ColumnCondition { return new ColumnCondition(this.ref, "!=", value); }
  /** `column > value` */
  gt(value: any): ColumnCondition { return new ColumnCondition(this.ref, ">", value); }
  /** `column >= value` */
  gte(value: any): ColumnCondition { return new ColumnCondition(this.ref, ">=", value); }
  /** `column < value` */
  lt(value: any): ColumnCondition { return new ColumnCondition(this.ref, "<", value); }
  /** `column <= value` */
  lte(value: any): ColumnCondition { return new ColumnCondition(this.ref, "<=", value); }
  /** `column LIKE pattern` */
  like(pattern: string): ColumnCondition { return new ColumnCondition(this.ref, "LIKE", pattern); }
  /** `column NOT LIKE pattern` */
  notLike(pattern: string): ColumnCondition { return new ColumnCondition(this.ref, "NOT LIKE", pattern); }
  /** `column IN (values)` */
  in(values: any[]): ColumnCondition { return new ColumnCondition(this.ref, "IN", values); }
  /** `column NOT IN (values)` */
  notIn(values: any[]): ColumnCondition { return new ColumnCondition(this.ref, "NOT IN", values); }
  /** `column IS NULL` */
  isNull(): ColumnCondition { return new ColumnCondition(this.ref, "IS NULL", undefined); }
  /** `column IS NOT NULL` */
  isNotNull(): ColumnCondition { return new ColumnCondition(this.ref, "IS NOT NULL", undefined); }
  /** `column BETWEEN min AND max` */
  between(min: any, max: any): ColumnCondition { return new ColumnCondition(this.ref, "BETWEEN", [min, max]); }

  /** Returns the `"alias.property"` string (for interop with `col()`-style API). */
  toString(): string { return this.ref; }
}

/**
 * Mapped type: transforms entity properties into `ColumnExpression` accessors.
 */
export type QEntity<T> = {
  readonly [K in keyof T & string]: ColumnExpression;
} & EntityRef<T>;

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
export function qAlias<T>(entity: ClazzType<T>, name: string): QEntity<T> {
  return new Proxy({} as any, {
    get(_target: any, prop: string | symbol): any {
      if (typeof prop === "symbol") return undefined;
      if (prop === "_alias") return name;
      if (prop === "_entity") return entity;
      if (prop === "col") {
        return (column: string) => `${name}.${column}`;
      }
      if (prop === "toString" || prop === "valueOf") {
        return () => name;
      }
      return new ColumnExpression(`${name}.${prop}`);
    },
  }) as QEntity<T>;
}

/**
 * Validator function that can be attached to a SelectQueryBuilder.
 *
 * Called on each row returned by getMany()/getOne(). If it throws,
 * the entire query result is rejected with the validation error.
 *
 * Supports three patterns:
 * 1. **Plain function**: `(row: TResult) => TResult` — validate and return
 * 2. **Zod-style**: any object with a `.parse(data)` method
 * 3. **Array-level**: `(rows: TResult[]) => TResult[]` via `validateArray()`
 */
export type RowValidator<TResult> =
  | ((row: TResult) => TResult)
  | { parse(data: unknown): TResult };

/**
 * Array-level validator: validates the entire result array at once.
 */
export type ArrayValidator<TResult> =
  | ((rows: TResult[]) => TResult[])
  | { parse(data: unknown): TResult[] };

/**
 * Type-safe column reference: entity property keys (string keys only).
 */
type ColumnOf<T> = keyof T & string;

/**
 * Allowed comparison operators for type-safe WHERE conditions.
 * Using any other string literal will produce a compile-time error.
 */
export type WhereOperator =
  | "="
  | "!="
  | "<>"
  | "<"
  | ">"
  | "<="
  | ">="
  | "LIKE"
  | "NOT LIKE"
  | "ILIKE"
  | "IN"
  | "NOT IN"
  | "IS NULL"
  | "IS NOT NULL"
  | "BETWEEN";

/**
 * Type-safe order-by specification.
 */
type OrderBySpec<T> = {
  [K in ColumnOf<T>]?: "ASC" | "DESC";
};

/**
 * Lightweight builder for collecting WHERE conditions into an isolated group.
 *
 * Used by `andWhereGroup()` / `orWhereGroup()` to create parenthesized
 * condition groups: `(a = 1 AND b = 2) OR (c = 3 AND d = 4)`.
 *
 * @example
 * ```ts
 * qb.where("status", "active")
 *   .orWhereGroup(g => g
 *     .where("role", "admin")
 *     .where("verified", true)
 *   )
 * // WHERE "status" = 'active' OR ("role" = 'admin' AND "verified" = true)
 * ```
 */
export class WhereGroupBuilder<T> {
  private conditions: Sql[] = [];

  constructor(
    private readonly columnResolver: (ref: string) => string,
    private readonly wrapFn: (id: string) => string,
  ) {}

  where(condition: Sql): this;
  where(condition: ColumnCondition): this;
  where(column: keyof T & string, value: any): this;
  where(column: keyof T & string, operator: WhereOperator, value: any): this;
  where(column: string, value: any): this;
  where(column: string, operator: WhereOperator, value: any): this;
  where(
    columnOrCondition: string | Sql | ColumnCondition,
    valueOrOperator?: any,
    value?: any,
  ): this {
    if (columnOrCondition instanceof ColumnCondition) {
      this.conditions.push(
        columnOrCondition.resolve((ref) => this.columnResolver(ref)),
      );
      return this;
    }
    if (typeof columnOrCondition === "object" && "sql" in columnOrCondition) {
      this.conditions.push(columnOrCondition as Sql);
      return this;
    }
    const col = this.columnResolver(columnOrCondition as string);
    if (value !== undefined) {
      const op = (valueOrOperator as string).trim().toUpperCase();
      if (op === "IS NULL") {
        this.conditions.push(Conditions.isNull(col));
      } else if (op === "IS NOT NULL") {
        this.conditions.push(Conditions.isNotNull(col));
      } else if (op === "IN") {
        this.conditions.push(Conditions.in(col, value as any[]));
      } else if (op === "NOT IN") {
        this.conditions.push(Conditions.notIn(col, value as any[]));
      } else if (op === "BETWEEN") {
        const [min, max] = value as [any, any];
        this.conditions.push(Conditions.between(col, min, max));
      } else if (op === "LIKE") {
        this.conditions.push(Conditions.like(col, value));
      } else if (op === "NOT LIKE") {
        this.conditions.push(Conditions.notLike(col, value));
      } else {
        this.conditions.push(sql`${raw(col)} ${raw(op)} ${value}`);
      }
    } else {
      this.conditions.push(Conditions.equals(col, valueOrOperator));
    }
    return this;
  }

  whereIn(column: string, values: any[]): this {
    this.conditions.push(Conditions.in(this.columnResolver(column), values));
    return this;
  }

  whereNotIn(column: string, values: any[]): this {
    this.conditions.push(Conditions.notIn(this.columnResolver(column), values));
    return this;
  }

  whereNull(column: string): this {
    this.conditions.push(Conditions.isNull(this.columnResolver(column)));
    return this;
  }

  whereNotNull(column: string): this {
    this.conditions.push(Conditions.isNotNull(this.columnResolver(column)));
    return this;
  }

  whereBetween(column: string, min: any, max: any): this {
    this.conditions.push(Conditions.between(this.columnResolver(column), min, max));
    return this;
  }

  whereLike(column: string, pattern: string): this {
    this.conditions.push(Conditions.like(this.columnResolver(column), pattern));
    return this;
  }

  /** @internal Build the grouped condition wrapped in parentheses. */
  build(): Sql {
    if (this.conditions.length === 0) {
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        "WHERE group is empty. Add at least one condition inside the group.",
      );
    }
    if (this.conditions.length === 1) return this.conditions[0];
    return Conditions.and(this.conditions);
  }
}

/**
 * A type-safe, fluent query builder derived from a repository entity type.
 *
 * Created via `repository.createQueryBuilder("alias")` or
 * `em.createQueryBuilder(Entity, "alias")`.
 *
 * **Type-safe projections:** When you call `select(["id", "name"])`, the
 * return type of `getMany()` narrows from `T[]` to `Pick<T, "id" | "name">[]`.
 * Accessing unselected columns becomes a compile-time error.
 *
 * @template T       The full entity type — used for column references in where/orderBy.
 * @template TResult The projected result type — defaults to `T` (all columns).
 *                   Changes when `select()` is called with specific columns.
 *
 * @example
 * ```ts
 * const users = await repo
 *   .createQueryBuilder("u")
 *   .select(["id", "name"])      // TResult = Pick<User, "id" | "name">
 *   .where("status", "active")   // still references full User columns
 *   .getMany();                  // Promise<Pick<User, "id" | "name">[]>
 *
 * users[0].id;    // ✓ OK
 * users[0].name;  // ✓ OK
 * users[0].email; // ✗ Compile error — "email" not in Pick<User, "id" | "name">
 * ```
 */
export class SelectQueryBuilder<T, TResult = T> {
  protected readonly alias: string;
  protected readonly entity: ClazzType<T>;
  protected readonly em: EntityManager;

  protected selectColumns: string[] | "*" = "*";
  protected distinct = false;
  protected whereClauses: Sql[] = [];
  protected orderByClauses: Array<{
    column: string;
    direction: "ASC" | "DESC";
  }> = [];
  protected groupByCols: string[] = [];
  protected havingClauses: Sql[] = [];
  protected joinClauses: Array<{
    type: "LEFT" | "INNER" | "RIGHT";
    table: string;
    alias: string;
    condition: Sql;
  }> = [];
  protected limitValue: number | [number, number] | undefined;
  protected offsetValue: number | undefined;
  protected lockClause: string | undefined;
  protected withDeletedFlag = false;
  protected extraSegments: Sql[] = [];
  protected rowValidator: RowValidator<any> | undefined;
  protected arrayValidatorFn: ArrayValidator<any> | undefined;
  protected selectedPropertyKeys: string[] | null = null;
  protected indexHints: Array<{
    type: "USE" | "FORCE" | "IGNORE";
    indexName: string;
  }> = [];
  protected pgHints: string[] = [];

  /** Maps TypeScript property names to DB column names (NamingStrategy). */
  protected propertyToColumnMap?: Map<string, string>;

  /** Dialect-specific SQL expression generator (ILIKE, full-text search, etc.). */
  protected dialectExpression?: DialectExpression;

  /**
   * Registry mapping table aliases to their entity metadata.
   * Enables cross-entity column resolution: `"u.firstName"` → `"u"."first_name"`.
   */
  protected aliasRegistry: Map<string, AliasEntry> = new Map();

  /**
   * Parameterized SQL expressions for the SELECT clause.
   * Unlike `selectColumns` (string[]), these preserve `sql-template-tag` parameter bindings.
   * Used by `addSelectSubquery()` and `withCount()` for scalar subqueries in SELECT.
   */
  protected selectExpressions: Sql[] = [];

  constructor(entity: ClazzType<T>, alias: string, em: EntityManager) {
    this.entity = entity;
    this.alias = alias;
    this.em = em;
  }

  /** Set the property-to-column mapping for NamingStrategy support. */
  setPropertyToColumnMap(map: Map<string, string>): this {
    this.propertyToColumnMap = map;
    // Also register main entity in alias registry
    const resolver = (this.em as any).resolver as RelationMetadataResolver | undefined;
    if (resolver) {
      const metadata = resolver.resolveEntityMetadata(this.entity);
      if (metadata) {
        this.aliasRegistry.set(this.alias, {
          entity: this.entity,
          tableName: metadata.name!,
          propertyToColumnMap: map,
        });
      }
    }
    return this;
  }

  /** Set the dialect expression strategy for operator translation. */
  setDialectExpression(expr: DialectExpression): this {
    this.dialectExpression = expr;
    return this;
  }

  // ── Helpers ──────────────────────────────────────────────

  /** Qualify a column with the main alias: `"u"."name"` */
  protected col(column: string): string {
    const dbCol = this.propertyToColumnMap?.get(column) ?? column;
    return `${this.em.wrap(this.alias)}.${this.em.wrap(dbCol)}`;
  }

  /** Qualify a column for a different alias, resolving property names via alias registry. */
  protected qualifiedCol(tableAlias: string, column: string): string {
    const entry = this.aliasRegistry.get(tableAlias);
    if (entry) {
      const dbCol = entry.propertyToColumnMap.get(column) ?? column;
      return `${this.em.wrap(tableAlias)}.${this.em.wrap(dbCol)}`;
    }
    return `${this.em.wrap(tableAlias)}.${this.em.wrap(column)}`;
  }

  /**
   * Resolve a column reference that may use `"alias.property"` notation.
   *
   * - `"u.firstName"` → splits on dot, looks up alias `"u"` in registry,
   *   maps property `"firstName"` → DB column `"first_name"` → `"u"."first_name"`
   * - `"firstName"` → no dot, delegates to `col()` (main entity)
   */
  protected resolveColumn(ref: string): string {
    const dotIndex = ref.indexOf(".");
    if (dotIndex > 0) {
      const alias = ref.substring(0, dotIndex);
      const property = ref.substring(dotIndex + 1);
      return this.qualifiedCol(alias, property);
    }
    return this.col(ref);
  }

  /**
   * Build a property-to-column map from entity metadata.
   * Duplicates EntityManager.buildPropertyToColumnMap logic to avoid
   * depending on its private visibility.
   */
  protected buildPropertyToColumnMapFromMetadata(
    metadata: { columns: ColumnMetadata[] },
  ): Map<string, string> {
    const map = new Map<string, string>();
    for (const col of metadata.columns) {
      const prop = col.propertyKey ?? col.name!;
      map.set(prop, col.name!);
    }
    return map;
  }

  // ── SELECT ───────────────────────────────────────────────

  /**
   * Select specific columns. Receives `keyof T` auto-completion.
   *
   * When specific columns are provided, the result type narrows to
   * `Pick<T, K>` — accessing unselected columns becomes a compile error.
   *
   * @example
   * ```ts
   * qb.select(["id", "name"])   // result type: Pick<User, "id" | "name">
   * qb.select("*")              // result type: T (all columns)
   * ```
   */
  select<K extends ColumnOf<T>>(
    columns: K[],
  ): SelectQueryBuilder<T, Pick<T, K>>;
  select(columns: "*"): SelectQueryBuilder<T, T>;
  select<K extends ColumnOf<T>>(
    columns: K[] | "*",
  ): SelectQueryBuilder<T, any> {
    if (columns === "*") {
      this.selectColumns = "*";
      this.selectedPropertyKeys = null;
    } else {
      this.selectColumns = (columns as string[]).map((c) => this.col(c));
      this.selectedPropertyKeys = columns as string[];
    }
    return this as any;
  }

  /**
   * Add additional select expressions (raw SQL fragments or aggregates).
   *
   * @example
   * ```ts
   * qb.addSelect(Conditions.count("*"), "total")
   * ```
   */
  /**
   * Select columns using alias-prefixed property names for cross-entity queries.
   *
   * Unlike `select()`, this method accepts `"alias.property"` notation and
   * does not perform TypeScript type narrowing.
   *
   * @example
   * ```ts
   * qb.leftJoin(User, "u", (j) => j.on("p.userId", "=", "u.id"))
   *   .selectRaw(["p.title", "u.firstName"])
   * ```
   */
  selectRaw(columns: string[]): this {
    this.selectColumns = columns.map((c) => this.resolveColumn(c));
    this.selectedPropertyKeys = null;
    return this;
  }

  addSelect(expr: Sql | string, alias?: string): this {
    const exprStr = typeof expr === "string" ? this.resolveColumn(expr) : expr.sql;
    const fragment = alias ? `${exprStr} AS ${this.em.wrap(alias)}` : exprStr;
    if (this.selectColumns === "*") {
      this.selectColumns = [`${this.em.wrap(this.alias)}.*`, fragment];
    } else {
      (this.selectColumns as string[]).push(fragment);
    }
    return this;
  }

  /**
   * Enable SELECT DISTINCT.
   */
  setDistinct(value = true): this {
    this.distinct = value;
    return this;
  }

  // ── WHERE ────────────────────────────────────────────────

  /**
   * Add a WHERE condition. Supports multiple call signatures:
   *
   * 1. `where("name", "Alice")` → equals (main entity property)
   * 2. `where("age", ">=", 18)` → operator
   * 3. `where("u.firstName", "LIKE", "%John%")` → cross-entity with alias
   * 4. `where(Conditions.like(...))` → raw Sql
   */
  where(condition: Sql): this;
  where(condition: ColumnCondition): this;
  where(column: ColumnOf<T>, value: T[ColumnOf<T>] | Sql | null): this;
  where(column: ColumnOf<T>, operator: WhereOperator, value: any): this;
  where(column: string, value: any): this;
  where(column: string, operator: WhereOperator, value: any): this;
  where(
    columnOrCondition: string | Sql | ColumnCondition,
    operatorOrValue?: any,
    value?: any,
  ): this {
    this.whereClauses.push(
      this.resolveCondition(columnOrCondition, operatorOrValue, value),
    );
    return this;
  }

  /**
   * Add an AND WHERE condition.
   */
  andWhere(condition: Sql): this;
  andWhere(condition: ColumnCondition): this;
  andWhere(column: ColumnOf<T>, value: T[ColumnOf<T>] | Sql | null): this;
  andWhere(column: ColumnOf<T>, operator: WhereOperator, value: any): this;
  andWhere(column: string, value: any): this;
  andWhere(column: string, operator: WhereOperator, value: any): this;
  andWhere(
    columnOrCondition: string | Sql | ColumnCondition,
    operatorOrValue?: any,
    value?: any,
  ): this {
    this.whereClauses.push(
      this.resolveCondition(columnOrCondition, operatorOrValue, value),
    );
    return this;
  }

  /**
   * Add an OR WHERE condition (wrapped in parentheses with existing conditions).
   */
  orWhere(condition: Sql): this;
  orWhere(condition: ColumnCondition): this;
  orWhere(column: ColumnOf<T>, value: T[ColumnOf<T>] | Sql | null): this;
  orWhere(column: ColumnOf<T>, operator: WhereOperator, value: any): this;
  orWhere(column: string, value: any): this;
  orWhere(column: string, operator: WhereOperator, value: any): this;
  orWhere(
    columnOrCondition: string | Sql | ColumnCondition,
    operatorOrValue?: any,
    value?: any,
  ): this {
    const cond = this.resolveCondition(
      columnOrCondition,
      operatorOrValue,
      value,
    );
    if (this.whereClauses.length === 0) {
      this.whereClauses.push(cond);
    } else {
      // Wrap existing AND clauses and add OR
      const existing = Conditions.and(this.whereClauses);
      this.whereClauses = [Conditions.or([existing, cond])];
    }
    return this;
  }

  /**
   * WHERE column IN (values). Supports `"alias.property"` notation.
   */
  whereIn(column: ColumnOf<T>, values: any[]): this;
  whereIn(column: string, values: any[]): this;
  whereIn(column: string, values: any[]): this {
    this.whereClauses.push(Conditions.in(this.resolveColumn(column), values));
    return this;
  }

  /**
   * WHERE column NOT IN (values). Supports `"alias.property"` notation.
   */
  whereNotIn(column: ColumnOf<T>, values: any[]): this;
  whereNotIn(column: string, values: any[]): this;
  whereNotIn(column: string, values: any[]): this {
    this.whereClauses.push(Conditions.notIn(this.resolveColumn(column), values));
    return this;
  }

  /**
   * WHERE column IS NULL. Supports `"alias.property"` notation.
   */
  whereNull(column: ColumnOf<T>): this;
  whereNull(column: string): this;
  whereNull(column: string): this {
    this.whereClauses.push(Conditions.isNull(this.resolveColumn(column)));
    return this;
  }

  /**
   * WHERE column IS NOT NULL. Supports `"alias.property"` notation.
   */
  whereNotNull(column: ColumnOf<T>): this;
  whereNotNull(column: string): this;
  whereNotNull(column: string): this {
    this.whereClauses.push(Conditions.isNotNull(this.resolveColumn(column)));
    return this;
  }

  /**
   * WHERE column BETWEEN min AND max. Supports `"alias.property"` notation.
   */
  whereBetween(column: ColumnOf<T>, min: any, max: any): this;
  whereBetween(column: string, min: any, max: any): this;
  whereBetween(column: string, min: any, max: any): this {
    this.whereClauses.push(Conditions.between(this.resolveColumn(column), min, max));
    return this;
  }

  /**
   * WHERE column LIKE pattern. Supports `"alias.property"` notation.
   */
  whereLike(column: ColumnOf<T>, pattern: string): this;
  whereLike(column: string, pattern: string): this;
  whereLike(column: string, pattern: string): this {
    this.whereClauses.push(Conditions.like(this.resolveColumn(column), pattern));
    return this;
  }

  // ── JOIN ─────────────────────────────────────────────────

  /**
   * Add a LEFT JOIN.
   *
   * Supports two forms:
   * 1. **String-based** (backward compatible): `leftJoin("posts", "p", "u.id = p.author_id")`
   * 2. **Entity-aware**: `leftJoin(User, "u", (join) => join.on("p.userId", "=", "u.id"))`
   */
  leftJoin(table: string, alias: string, condition: Sql | string): this;
  leftJoin<U>(entity: ClazzType<U>, alias: string, onBuilder: (join: JoinOnBuilder) => JoinOnBuilder): this;
  leftJoin(
    tableOrEntity: string | ClazzType<any>,
    alias: string,
    conditionOrBuilder: Sql | string | ((join: JoinOnBuilder) => JoinOnBuilder),
  ): this {
    if (typeof tableOrEntity === "function" && typeof conditionOrBuilder === "function") {
      return this.addEntityJoin("LEFT", tableOrEntity, alias, conditionOrBuilder as (join: JoinOnBuilder) => JoinOnBuilder);
    }
    return this.addJoin("LEFT", tableOrEntity as string, alias, conditionOrBuilder as Sql | string);
  }

  /**
   * Add an INNER JOIN.
   *
   * Supports both string-based and entity-aware forms.
   */
  innerJoin(table: string, alias: string, condition: Sql | string): this;
  innerJoin<U>(entity: ClazzType<U>, alias: string, onBuilder: (join: JoinOnBuilder) => JoinOnBuilder): this;
  innerJoin(
    tableOrEntity: string | ClazzType<any>,
    alias: string,
    conditionOrBuilder: Sql | string | ((join: JoinOnBuilder) => JoinOnBuilder),
  ): this {
    if (typeof tableOrEntity === "function" && typeof conditionOrBuilder === "function") {
      return this.addEntityJoin("INNER", tableOrEntity, alias, conditionOrBuilder as (join: JoinOnBuilder) => JoinOnBuilder);
    }
    return this.addJoin("INNER", tableOrEntity as string, alias, conditionOrBuilder as Sql | string);
  }

  /**
   * Add a RIGHT JOIN.
   *
   * Supports both string-based and entity-aware forms.
   */
  rightJoin(table: string, alias: string, condition: Sql | string): this;
  rightJoin<U>(entity: ClazzType<U>, alias: string, onBuilder: (join: JoinOnBuilder) => JoinOnBuilder): this;
  rightJoin(
    tableOrEntity: string | ClazzType<any>,
    alias: string,
    conditionOrBuilder: Sql | string | ((join: JoinOnBuilder) => JoinOnBuilder),
  ): this {
    if (typeof tableOrEntity === "function" && typeof conditionOrBuilder === "function") {
      return this.addEntityJoin("RIGHT", tableOrEntity, alias, conditionOrBuilder as (join: JoinOnBuilder) => JoinOnBuilder);
    }
    return this.addJoin("RIGHT", tableOrEntity as string, alias, conditionOrBuilder as Sql | string);
  }

  /**
   * LEFT JOIN and automatically SELECT all columns from the joined entity.
   *
   * Equivalent to `leftJoin()` + `selectRaw()` for all joined entity columns.
   * The result includes both the main entity's and joined entity's columns.
   *
   * @example
   * ```ts
   * const results = await em
   *   .createQueryBuilder(Post, "p")
   *   .leftJoinAndSelect(User, "u", (j) => j.on("p.authorId", "=", "u.id"))
   *   .where("p.status", "published")
   *   .getRawMany();
   * // [{ id: 1, title: "...", u_id: 1, u_name: "Alice", u_email: "..." }, ...]
   * ```
   */
  leftJoinAndSelect<U>(
    entity: ClazzType<U>,
    alias: string,
    onBuilder: (join: JoinOnBuilder) => JoinOnBuilder,
  ): this {
    return this.addEntityJoin("LEFT", entity, alias, onBuilder, true);
  }

  /**
   * INNER JOIN and automatically SELECT all columns from the joined entity.
   * @see leftJoinAndSelect
   */
  innerJoinAndSelect<U>(
    entity: ClazzType<U>,
    alias: string,
    onBuilder: (join: JoinOnBuilder) => JoinOnBuilder,
  ): this {
    return this.addEntityJoin("INNER", entity, alias, onBuilder, true);
  }

  /**
   * Add a LEFT JOIN using a relation property name.
   * Automatically resolves the ON condition from @ManyToOne / @OneToMany / @OneToOne metadata.
   *
   * @example
   * ```ts
   * // Post has @ManyToOne(() => User) user property
   * em.createQueryBuilder(Post, "p")
   *   .leftJoinRelation("user", "u")   // auto: ON p.user_id = u.id
   *   .where("u.firstName", "LIKE", "%John%")
   * ```
   */
  leftJoinRelation(propertyName: string, alias: string): this {
    return this.addRelationJoin("LEFT", propertyName, alias);
  }

  /**
   * Add an INNER JOIN using a relation property name.
   * @see leftJoinRelation
   */
  innerJoinRelation(propertyName: string, alias: string): this {
    return this.addRelationJoin("INNER", propertyName, alias);
  }

  /**
   * LEFT JOIN using a relation property name and auto-SELECT all joined columns.
   *
   * @example
   * ```ts
   * em.createQueryBuilder(Post, "p")
   *   .leftJoinRelationAndSelect("author", "u")
   *   .getRawMany();
   * ```
   */
  leftJoinRelationAndSelect(propertyName: string, alias: string): this {
    return this.addRelationJoin("LEFT", propertyName, alias, true);
  }

  /**
   * INNER JOIN using a relation property name and auto-SELECT all joined columns.
   * @see leftJoinRelationAndSelect
   */
  innerJoinRelationAndSelect(propertyName: string, alias: string): this {
    return this.addRelationJoin("INNER", propertyName, alias, true);
  }

  protected addJoin(
    type: "LEFT" | "INNER" | "RIGHT",
    table: string,
    alias: string,
    condition: Sql | string,
  ): this {
    const cond =
      typeof condition === "string" ? sql`${raw(condition)}` : condition;
    this.joinClauses.push({ type, table, alias, condition: cond });
    return this;
  }

  protected addEntityJoin<U>(
    type: "LEFT" | "INNER" | "RIGHT",
    entity: ClazzType<U>,
    alias: string,
    onBuilder: (join: JoinOnBuilder) => JoinOnBuilder,
    andSelect = false,
  ): this {
    const resolver = (this.em as any).resolver as RelationMetadataResolver;
    if (!resolver) {
      throw new OrmError(
        OrmErrorCode.ENTITY_METADATA_NOT_FOUND,
        `EntityManager not connected. Cannot resolve entity metadata for ${entity.name}.`,
      );
    }
    const metadata = resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new OrmError(
        OrmErrorCode.ENTITY_METADATA_NOT_FOUND,
        `Entity metadata not found for ${entity.name}. Did you register the entity?`,
      );
    }

    const propToCol = this.buildPropertyToColumnMapFromMetadata(metadata);
    this.aliasRegistry.set(alias, {
      entity,
      tableName: metadata.name!,
      propertyToColumnMap: propToCol,
    });

    const builder = new JoinOnBuilder((ref) => this.resolveColumn(ref));
    onBuilder(builder);
    const condition = builder.build();

    this.joinClauses.push({
      type,
      table: metadata.name!,
      alias,
      condition,
    });

    if (andSelect) {
      this.appendJoinedColumnsToSelect(alias, propToCol);
    }

    return this;
  }

  /**
   * Append all columns from a joined entity to the SELECT clause.
   * Used by *AndSelect methods.
   */
  protected appendJoinedColumnsToSelect(
    alias: string,
    propToCol: Map<string, string>,
  ): void {
    const cols: string[] = [];
    for (const [, dbCol] of propToCol) {
      cols.push(`${this.em.wrap(alias)}.${this.em.wrap(dbCol)}`);
    }
    if (cols.length === 0) return;

    if (this.selectColumns === "*") {
      // Expand main entity's * to explicit columns, then append joined
      this.selectColumns = [`${this.em.wrap(this.alias)}.*`, ...cols];
    } else {
      (this.selectColumns as string[]).push(...cols);
    }
  }

  protected addRelationJoin(
    type: "LEFT" | "INNER" | "RIGHT",
    propertyName: string,
    alias: string,
    andSelect = false,
  ): this {
    const resolver = (this.em as any).resolver as RelationMetadataResolver;
    if (!resolver) {
      throw new OrmError(
        OrmErrorCode.ENTITY_METADATA_NOT_FOUND,
        `EntityManager not connected. Cannot resolve relation metadata.`,
      );
    }

    // Check source entity — may be a joined entity if propertyName is "alias.property"
    let sourceAlias = this.alias;
    let sourceEntity = this.entity as ClazzType<any>;
    let relationProp = propertyName;

    const dotIndex = propertyName.indexOf(".");
    if (dotIndex > 0) {
      sourceAlias = propertyName.substring(0, dotIndex);
      relationProp = propertyName.substring(dotIndex + 1);
      const entry = this.aliasRegistry.get(sourceAlias);
      if (entry) {
        sourceEntity = entry.entity;
      }
    }

    // Try ManyToOne
    const manyToOnes = resolver.resolveManyToOneMetadata(sourceEntity);
    const m2oRel = manyToOnes.find((r) => r.columnName === relationProp);
    if (m2oRel) {
      return this.addRelationJoinFromManyToOne(type, m2oRel, alias, sourceAlias, resolver, andSelect);
    }

    // Try OneToMany
    const oneToManys = resolver.resolveOneToManyMetadata(sourceEntity);
    const o2mRel = oneToManys.find((r) => r.propertyKey === relationProp);
    if (o2mRel) {
      return this.addRelationJoinFromOneToMany(type, o2mRel, alias, sourceAlias, sourceEntity, resolver, andSelect);
    }

    // Try OneToOne
    const oneToOnes = resolver.resolveOneToOneMetadata(sourceEntity);
    const o2oRel = oneToOnes.find((r) => r.propertyKey === relationProp);
    if (o2oRel) {
      return this.addRelationJoinFromOneToOne(type, o2oRel, alias, sourceAlias, resolver, andSelect);
    }

    throw new OrmError(
      OrmErrorCode.INVALID_QUERY,
      `No relation found for property "${relationProp}" on entity ${sourceEntity.name}. ` +
        `Available ManyToOne: [${manyToOnes.map((r) => r.columnName).join(", ")}], ` +
        `OneToMany: [${oneToManys.map((r) => r.propertyKey).join(", ")}], ` +
        `OneToOne: [${oneToOnes.map((r) => r.propertyKey).join(", ")}].`,
    );
  }

  protected addRelationJoinFromManyToOne(
    type: "LEFT" | "INNER" | "RIGHT",
    rel: any,
    alias: string,
    sourceAlias: string,
    resolver: RelationMetadataResolver,
    andSelect = false,
  ): this {
    const RelatedEntity = rel.getMappingEntity() as ClazzType<any>;
    const relatedMeta = resolver.resolveEntityMetadata(RelatedEntity);
    if (!relatedMeta) {
      throw new OrmError(
        OrmErrorCode.ENTITY_METADATA_NOT_FOUND,
        `Entity metadata not found for ${RelatedEntity.name}.`,
      );
    }

    // FK column on source entity
    const sourceEntry = this.aliasRegistry.get(sourceAlias);
    const joinColumn = sourceEntry
      ? (sourceEntry.propertyToColumnMap.get(rel.joinColumn ?? `${rel.columnName}Id`) ?? rel.joinColumn ?? `${rel.columnName}_id`)
      : (rel.joinColumn ?? `${rel.columnName}_id`);

    // PK column on related entity
    const referencedColumn = rel.references ?? this.findPrimaryColumn(relatedMeta) ?? "id";

    // Register alias
    const propToCol = this.buildPropertyToColumnMapFromMetadata(relatedMeta);
    this.aliasRegistry.set(alias, {
      entity: RelatedEntity,
      tableName: relatedMeta.name!,
      propertyToColumnMap: propToCol,
    });

    const left = `${this.em.wrap(sourceAlias)}.${this.em.wrap(joinColumn)}`;
    const right = `${this.em.wrap(alias)}.${this.em.wrap(referencedColumn)}`;
    const condition = Conditions.compareColumns(left, "=", right);

    this.joinClauses.push({ type, table: relatedMeta.name!, alias, condition });
    if (andSelect) this.appendJoinedColumnsToSelect(alias, propToCol);
    return this;
  }

  protected addRelationJoinFromOneToMany(
    type: "LEFT" | "INNER" | "RIGHT",
    rel: any,
    alias: string,
    sourceAlias: string,
    sourceEntity: ClazzType<any>,
    resolver: RelationMetadataResolver,
    andSelect = false,
  ): this {
    const RelatedEntity = rel.getRelatedEntity() as ClazzType<any>;
    const relatedMeta = resolver.resolveEntityMetadata(RelatedEntity);
    if (!relatedMeta) {
      throw new OrmError(
        OrmErrorCode.ENTITY_METADATA_NOT_FOUND,
        `Entity metadata not found for ${RelatedEntity.name}.`,
      );
    }

    // Find the ManyToOne on the related entity that maps back
    const relatedM2Os = resolver.resolveManyToOneMetadata(RelatedEntity);
    const reverseRel = relatedM2Os.find((r) => r.columnName === rel.mappedBy);

    const propToCol = this.buildPropertyToColumnMapFromMetadata(relatedMeta);

    // FK column on related entity
    let fkColumn: string;
    if (reverseRel?.joinColumn) {
      fkColumn = reverseRel.joinColumn;
    } else {
      // fallback: use mappedById from propToCol, or convention
      fkColumn = propToCol.get(`${rel.mappedBy}Id`) ?? `${rel.mappedBy}_id`;
    }

    // PK column on source entity
    const sourceMeta = resolver.resolveEntityMetadata(sourceEntity);
    const pk = sourceMeta ? this.findPrimaryColumn(sourceMeta) ?? "id" : "id";

    this.aliasRegistry.set(alias, {
      entity: RelatedEntity,
      tableName: relatedMeta.name!,
      propertyToColumnMap: propToCol,
    });

    const left = `${this.em.wrap(sourceAlias)}.${this.em.wrap(pk)}`;
    const right = `${this.em.wrap(alias)}.${this.em.wrap(fkColumn)}`;
    const condition = Conditions.compareColumns(left, "=", right);

    this.joinClauses.push({ type, table: relatedMeta.name!, alias, condition });
    if (andSelect) this.appendJoinedColumnsToSelect(alias, propToCol);
    return this;
  }

  protected addRelationJoinFromOneToOne(
    type: "LEFT" | "INNER" | "RIGHT",
    rel: any,
    alias: string,
    sourceAlias: string,
    resolver: RelationMetadataResolver,
    andSelect = false,
  ): this {
    const RelatedEntity = (rel.getRelatedEntity ?? rel.getMappingEntity)() as ClazzType<any>;
    const relatedMeta = resolver.resolveEntityMetadata(RelatedEntity);
    if (!relatedMeta) {
      throw new OrmError(
        OrmErrorCode.ENTITY_METADATA_NOT_FOUND,
        `Entity metadata not found for ${RelatedEntity.name}.`,
      );
    }

    const sourceEntry = this.aliasRegistry.get(sourceAlias);
    const joinColumn = sourceEntry
      ? (sourceEntry.propertyToColumnMap.get(rel.joinColumn ?? `${rel.propertyKey}Id`) ?? rel.joinColumn ?? `${rel.propertyKey}_id`)
      : (rel.joinColumn ?? `${rel.propertyKey}_id`);

    const referencedColumn = this.findPrimaryColumn(relatedMeta) ?? "id";

    const propToCol = this.buildPropertyToColumnMapFromMetadata(relatedMeta);
    this.aliasRegistry.set(alias, {
      entity: RelatedEntity,
      tableName: relatedMeta.name!,
      propertyToColumnMap: propToCol,
    });

    const left = `${this.em.wrap(sourceAlias)}.${this.em.wrap(joinColumn)}`;
    const right = `${this.em.wrap(alias)}.${this.em.wrap(referencedColumn)}`;
    const condition = Conditions.compareColumns(left, "=", right);

    this.joinClauses.push({ type, table: relatedMeta.name!, alias, condition });
    if (andSelect) this.appendJoinedColumnsToSelect(alias, propToCol);
    return this;
  }

  protected findPrimaryColumn(metadata: EntityScannerMetadata): string | null {
    const pk = metadata.columns.find(
      (c: ColumnMetadata) => c.options?.primary || (c.options as any)?.autoIncrement,
    );
    return pk?.name ?? null;
  }

  /**
   * Build a correlated EXISTS subquery for a relation.
   * Used by `whereHas()`, `whereNotHas()`.
   *
   * @returns A `Sql` fragment: `SELECT 1 FROM related_table WHERE correlation [AND ...]`
   */
  protected buildRelationExistsSubquery(
    propertyName: string,
    fn?: (subQb: SelectQueryBuilder<any, any>) => void,
  ): Sql {
    return this.buildRelationSubquery(propertyName, "exists", fn);
  }

  /**
   * Build a correlated COUNT subquery for a relation.
   * Used by `withCount()`.
   *
   * @returns A `Sql` fragment: `SELECT COUNT(*) FROM related_table WHERE correlation [AND ...]`
   */
  protected buildRelationCountSubquery(
    propertyName: string,
    fn?: (subQb: SelectQueryBuilder<any, any>) => void,
  ): Sql {
    return this.buildRelationSubquery(propertyName, "count", fn);
  }

  /**
   * Core helper: build a correlated subquery (EXISTS or COUNT) for a relation.
   */
  protected buildRelationSubquery(
    propertyName: string,
    mode: "exists" | "count",
    fn?: (subQb: SelectQueryBuilder<any, any>) => void,
  ): Sql {
    const resolver = (this.em as any).resolver as RelationMetadataResolver;
    if (!resolver) {
      throw new OrmError(
        OrmErrorCode.ENTITY_METADATA_NOT_FOUND,
        `EntityManager not connected. Cannot resolve relation metadata.`,
      );
    }

    // Determine source
    let sourceAlias = this.alias;
    let sourceEntity = this.entity as ClazzType<any>;
    let relationProp = propertyName;

    const dotIndex = propertyName.indexOf(".");
    if (dotIndex > 0) {
      sourceAlias = propertyName.substring(0, dotIndex);
      relationProp = propertyName.substring(dotIndex + 1);
      const entry = this.aliasRegistry.get(sourceAlias);
      if (entry) sourceEntity = entry.entity;
    }

    // Try ManyToOne
    const manyToOnes = resolver.resolveManyToOneMetadata(sourceEntity);
    const m2oRel = manyToOnes.find((r) => r.columnName === relationProp);
    if (m2oRel) {
      return this.buildM2OSubquery(m2oRel, sourceAlias, resolver, mode, fn);
    }

    // Try OneToMany
    const oneToManys = resolver.resolveOneToManyMetadata(sourceEntity);
    const o2mRel = oneToManys.find((r) => r.propertyKey === relationProp);
    if (o2mRel) {
      return this.buildO2MSubquery(o2mRel, sourceAlias, sourceEntity, resolver, mode, fn);
    }

    // Try OneToOne
    const oneToOnes = resolver.resolveOneToOneMetadata(sourceEntity);
    const o2oRel = oneToOnes.find((r) => r.propertyKey === relationProp);
    if (o2oRel) {
      return this.buildO2OSubquery(o2oRel, sourceAlias, resolver, mode, fn);
    }

    throw new OrmError(
      OrmErrorCode.INVALID_QUERY,
      `No relation found for property "${relationProp}" on entity ${sourceEntity.name}. ` +
        `Available ManyToOne: [${manyToOnes.map((r) => r.columnName).join(", ")}], ` +
        `OneToMany: [${oneToManys.map((r) => r.propertyKey).join(", ")}], ` +
        `OneToOne: [${oneToOnes.map((r) => r.propertyKey).join(", ")}].`,
    );
  }

  private buildM2OSubquery(
    rel: any,
    sourceAlias: string,
    resolver: RelationMetadataResolver,
    mode: "exists" | "count",
    fn?: (subQb: SelectQueryBuilder<any, any>) => void,
  ): Sql {
    const RelatedEntity = rel.getMappingEntity() as ClazzType<any>;
    const relatedMeta = resolver.resolveEntityMetadata(RelatedEntity);
    if (!relatedMeta) {
      throw new OrmError(OrmErrorCode.ENTITY_METADATA_NOT_FOUND, `Entity metadata not found for ${RelatedEntity.name}.`);
    }

    const sourceEntry = this.aliasRegistry.get(sourceAlias);
    const joinColumn = sourceEntry
      ? (sourceEntry.propertyToColumnMap.get(rel.joinColumn ?? `${rel.columnName}Id`) ?? rel.joinColumn ?? `${rel.columnName}_id`)
      : (rel.joinColumn ?? `${rel.columnName}_id`);
    const referencedColumn = rel.references ?? this.findPrimaryColumn(relatedMeta) ?? "id";

    const innerAlias = `__sub_${rel.columnName}`;
    const selectExpr = mode === "exists" ? "1" : "COUNT(*)";

    const outerRef = `${this.em.wrap(sourceAlias)}.${this.em.wrap(joinColumn)}`;
    const innerRef = `${this.em.wrap(innerAlias)}.${this.em.wrap(referencedColumn)}`;

    const subQb = new SelectQueryBuilder<any>(RelatedEntity, innerAlias, this.em);
    subQb.propertyToColumnMap = this.buildPropertyToColumnMapFromMetadata(relatedMeta);
    subQb.aliasRegistry.set(innerAlias, {
      entity: RelatedEntity,
      tableName: relatedMeta.name!,
      propertyToColumnMap: subQb.propertyToColumnMap,
    });
    subQb.dialectExpression = this.dialectExpression;
    subQb.withDeletedFlag = true; // subqueries don't auto-filter soft deletes

    subQb.whereClauses.push(Conditions.compareColumns(innerRef, "=", outerRef));
    if (fn) fn(subQb);

    const innerWhere = subQb.whereClauses.length > 0
      ? sql`WHERE ${join(subQb.whereClauses, " AND ")}`
      : sql``;

    return sql`SELECT ${raw(selectExpr)} FROM ${raw(this.em.wrapTable(relatedMeta.name!))} AS ${raw(this.em.wrap(innerAlias))} ${innerWhere}`;
  }

  private buildO2MSubquery(
    rel: any,
    sourceAlias: string,
    sourceEntity: ClazzType<any>,
    resolver: RelationMetadataResolver,
    mode: "exists" | "count",
    fn?: (subQb: SelectQueryBuilder<any, any>) => void,
  ): Sql {
    const RelatedEntity = rel.getRelatedEntity() as ClazzType<any>;
    const relatedMeta = resolver.resolveEntityMetadata(RelatedEntity);
    if (!relatedMeta) {
      throw new OrmError(OrmErrorCode.ENTITY_METADATA_NOT_FOUND, `Entity metadata not found for ${RelatedEntity.name}.`);
    }

    const relatedM2Os = resolver.resolveManyToOneMetadata(RelatedEntity);
    const reverseRel = relatedM2Os.find((r) => r.columnName === rel.mappedBy);
    const propToCol = this.buildPropertyToColumnMapFromMetadata(relatedMeta);

    let fkColumn: string;
    if (reverseRel?.joinColumn) {
      fkColumn = reverseRel.joinColumn;
    } else {
      fkColumn = propToCol.get(`${rel.mappedBy}Id`) ?? `${rel.mappedBy}_id`;
    }

    const sourceMeta = resolver.resolveEntityMetadata(sourceEntity);
    const pk = sourceMeta ? this.findPrimaryColumn(sourceMeta) ?? "id" : "id";

    const innerAlias = `__sub_${rel.propertyKey}`;
    const selectExpr = mode === "exists" ? "1" : "COUNT(*)";

    const outerRef = `${this.em.wrap(sourceAlias)}.${this.em.wrap(pk)}`;
    const innerRef = `${this.em.wrap(innerAlias)}.${this.em.wrap(fkColumn)}`;

    const subQb = new SelectQueryBuilder<any>(RelatedEntity, innerAlias, this.em);
    subQb.propertyToColumnMap = propToCol;
    subQb.aliasRegistry.set(innerAlias, {
      entity: RelatedEntity,
      tableName: relatedMeta.name!,
      propertyToColumnMap: propToCol,
    });
    subQb.dialectExpression = this.dialectExpression;
    subQb.withDeletedFlag = true;

    subQb.whereClauses.push(Conditions.compareColumns(innerRef, "=", outerRef));
    if (fn) fn(subQb);

    const innerWhere = subQb.whereClauses.length > 0
      ? sql`WHERE ${join(subQb.whereClauses, " AND ")}`
      : sql``;

    return sql`SELECT ${raw(selectExpr)} FROM ${raw(this.em.wrapTable(relatedMeta.name!))} AS ${raw(this.em.wrap(innerAlias))} ${innerWhere}`;
  }

  private buildO2OSubquery(
    rel: any,
    sourceAlias: string,
    resolver: RelationMetadataResolver,
    mode: "exists" | "count",
    fn?: (subQb: SelectQueryBuilder<any, any>) => void,
  ): Sql {
    const RelatedEntity = (rel.getRelatedEntity ?? rel.getMappingEntity)() as ClazzType<any>;
    const relatedMeta = resolver.resolveEntityMetadata(RelatedEntity);
    if (!relatedMeta) {
      throw new OrmError(OrmErrorCode.ENTITY_METADATA_NOT_FOUND, `Entity metadata not found for ${RelatedEntity.name}.`);
    }

    const sourceEntry = this.aliasRegistry.get(sourceAlias);
    const joinColumn = sourceEntry
      ? (sourceEntry.propertyToColumnMap.get(rel.joinColumn ?? `${rel.propertyKey}Id`) ?? rel.joinColumn ?? `${rel.propertyKey}_id`)
      : (rel.joinColumn ?? `${rel.propertyKey}_id`);
    const referencedColumn = this.findPrimaryColumn(relatedMeta) ?? "id";

    const innerAlias = `__sub_${rel.propertyKey}`;
    const selectExpr = mode === "exists" ? "1" : "COUNT(*)";

    const outerRef = `${this.em.wrap(sourceAlias)}.${this.em.wrap(joinColumn)}`;
    const innerRef = `${this.em.wrap(innerAlias)}.${this.em.wrap(referencedColumn)}`;

    const subQb = new SelectQueryBuilder<any>(RelatedEntity, innerAlias, this.em);
    subQb.propertyToColumnMap = this.buildPropertyToColumnMapFromMetadata(relatedMeta);
    subQb.aliasRegistry.set(innerAlias, {
      entity: RelatedEntity,
      tableName: relatedMeta.name!,
      propertyToColumnMap: subQb.propertyToColumnMap,
    });
    subQb.dialectExpression = this.dialectExpression;
    subQb.withDeletedFlag = true;

    subQb.whereClauses.push(Conditions.compareColumns(innerRef, "=", outerRef));
    if (fn) fn(subQb);

    const innerWhere = subQb.whereClauses.length > 0
      ? sql`WHERE ${join(subQb.whereClauses, " AND ")}`
      : sql``;

    return sql`SELECT ${raw(selectExpr)} FROM ${raw(this.em.wrapTable(relatedMeta.name!))} AS ${raw(this.em.wrap(innerAlias))} ${innerWhere}`;
  }

  // ── ORDER BY / GROUP BY / HAVING ────────────────────────

  /**
   * Set ORDER BY with type-safe column references.
   *
   * @example
   * ```ts
   * qb.orderBy({ createdAt: "DESC", name: "ASC" })
   * ```
   */
  orderBy(spec: OrderBySpec<T>): this {
    for (const key in spec) {
      const direction = spec[key as ColumnOf<T>];
      if (direction) {
        this.orderByClauses.push({
          column: this.col(key),
          direction,
        });
      }
    }
    return this;
  }

  /**
   * Add a single ORDER BY clause. Supports `"alias.property"` notation.
   */
  addOrderBy(column: ColumnOf<T>, direction: "ASC" | "DESC"): this;
  addOrderBy(column: string, direction: "ASC" | "DESC"): this;
  addOrderBy(column: string, direction: "ASC" | "DESC"): this {
    this.orderByClauses.push({ column: this.resolveColumn(column), direction });
    return this;
  }

  /**
   * Set GROUP BY columns. Supports `"alias.property"` notation.
   */
  groupBy(columns: ColumnOf<T>[]): this;
  groupBy(columns: string[]): this;
  groupBy(columns: string[]): this {
    this.groupByCols = columns.map((c) => this.resolveColumn(c));
    return this;
  }

  /**
   * Add HAVING conditions (used with GROUP BY).
   */
  having(condition: Sql): this {
    this.havingClauses.push(condition);
    return this;
  }

  // ── LIMIT / OFFSET ──────────────────────────────────────

  /**
   * Set the maximum number of rows to return.
   */
  limit(count: number): this {
    this.limitValue = count;
    return this;
  }

  /**
   * Set the number of rows to skip.
   */
  offset(count: number): this {
    this.offsetValue = count;
    return this;
  }

  /**
   * Convenience: set both skip and take.
   */
  skip(count: number): this {
    this.offsetValue = count;
    return this;
  }

  take(count: number): this {
    this.limitValue = count;
    return this;
  }

  // ── LOCK / SOFT DELETE ──────────────────────────────────

  /**
   * Add FOR UPDATE lock.
   */
  forUpdate(): this {
    this.lockClause = "FOR UPDATE";
    return this;
  }

  /**
   * Add FOR SHARE lock.
   */
  forShare(): this {
    const internals = (this.em as any)._ctx;
    this.lockClause = internals.isMySqlFamily()
      ? "LOCK IN SHARE MODE"
      : "FOR SHARE";
    return this;
  }

  /**
   * Add FOR UPDATE NOWAIT lock (MySQL 8.0+, PostgreSQL 9.5+).
   * Fails immediately if rows are already locked.
   */
  forUpdateNowait(): this {
    this.lockClause = "FOR UPDATE NOWAIT";
    return this;
  }

  /**
   * Add FOR UPDATE SKIP LOCKED lock (MySQL 8.0+, PostgreSQL 9.5+).
   * Skips rows that are already locked by other transactions.
   */
  forUpdateSkipLocked(): this {
    this.lockClause = "FOR UPDATE SKIP LOCKED";
    return this;
  }

  /**
   * Add FOR SHARE NOWAIT lock (MySQL 8.0+, PostgreSQL 9.5+).
   */
  forShareNowait(): this {
    const internals = (this.em as any)._ctx;
    this.lockClause = internals.isMySqlFamily()
      ? "LOCK IN SHARE MODE NOWAIT"
      : "FOR SHARE NOWAIT";
    return this;
  }

  /**
   * Add FOR SHARE SKIP LOCKED lock (MySQL 8.0+, PostgreSQL 9.5+).
   */
  forShareSkipLocked(): this {
    const internals = (this.em as any)._ctx;
    this.lockClause = internals.isMySqlFamily()
      ? "LOCK IN SHARE MODE SKIP LOCKED"
      : "FOR SHARE SKIP LOCKED";
    return this;
  }

  // ── INDEX HINTS ─────────────────────────────────────────

  /**
   * MySQL: USE INDEX (indexName)
   * Suggests an index for the optimizer to consider.
   */
  useIndex(indexName: string): this {
    this.indexHints.push({ type: "USE", indexName });
    return this;
  }

  /**
   * MySQL: FORCE INDEX (indexName)
   * Forces the optimizer to use a specific index.
   */
  forceIndex(indexName: string): this {
    this.indexHints.push({ type: "FORCE", indexName });
    return this;
  }

  /**
   * MySQL: IGNORE INDEX (indexName)
   * Tells the optimizer to ignore a specific index.
   */
  ignoreIndex(indexName: string): this {
    this.indexHints.push({ type: "IGNORE", indexName });
    return this;
  }

  /**
   * PostgreSQL: pg_hint_plan style hint comment.
   * Added as a hint comment before SELECT.
   *
   * @example
   * ```ts
   * qb.hint("IndexScan(o idx_order_date)")
   * ```
   */
  hint(hintText: string): this {
    this.pgHints.push(hintText);
    return this;
  }

  /**
   * Include soft-deleted entities in results.
   */
  withDeleted(): this {
    this.withDeletedFlag = true;
    return this;
  }

  // ── VALIDATION ──────────────────────────────────────────

  /**
   * Attach a **row-level** validator. Each row returned by `getMany()` /
   * `getOne()` is passed through this validator before being returned.
   *
   * Accepts:
   * - A plain function: `(row) => row` (throw to reject)
   * - A zod schema (or anything with a `.parse()` method)
   *
   * By default, no validator is attached — zero overhead.
   *
   * @example
   * ```ts
   * // With zod
   * import { z } from "zod";
   * const UserRow = z.object({ id: z.number(), name: z.string() });
   *
   * const users = await em
   *   .createQueryBuilder(User, "u")
   *   .select(["id", "name"])
   *   .validate(UserRow)
   *   .getMany();  // throws ZodError if any row doesn't match
   *
   * // With a plain function
   * .validate((row) => {
   *   if (!row.name) throw new Error("name is required");
   *   return row;
   * })
   * ```
   */
  validate(validator: RowValidator<TResult>): this {
    this.rowValidator = validator;
    return this;
  }

  /**
   * Attach an **array-level** validator. The entire result array is passed
   * through this validator before being returned from `getMany()`.
   *
   * Accepts:
   * - A plain function: `(rows) => rows` (throw to reject)
   * - A zod array schema (or anything with a `.parse()` method)
   *
   * @example
   * ```ts
   * import { z } from "zod";
   * const UsersArray = z.array(z.object({ id: z.number(), name: z.string() }));
   *
   * const users = await qb
   *   .select(["id", "name"])
   *   .validateArray(UsersArray)
   *   .getMany();
   * ```
   */
  validateArray(validator: ArrayValidator<TResult>): this {
    this.arrayValidatorFn = validator;
    return this;
  }

  // ── CONDITIONAL / COMPOSABLE ─────────────────────────────

  /**
   * Conditionally apply query modifications.
   *
   * Eliminates `if/else` blocks outside the query chain. When `condition`
   * is truthy (or returns truthy for lazy evaluation), `fn` is called.
   * Otherwise `elseFn` is called if provided. Always returns `this`.
   *
   * @example
   * ```ts
   * const users = await repo.createQueryBuilder("u")
   *   .when(!!searchName, qb => qb.where("name", "LIKE", `%${searchName}%`))
   *   .when(onlyActive, qb => qb.where("status", "active"),
   *                     qb => qb.withDeleted())
   *   .getMany();
   * ```
   */
  when(
    condition: boolean | (() => boolean),
    fn: (qb: this) => void,
    elseFn?: (qb: this) => void,
  ): this {
    const result = typeof condition === "function" ? condition() : condition;
    if (result) fn(this);
    else if (elseFn) elseFn(this);
    return this;
  }

  /**
   * Apply a composable query transform function.
   *
   * Use `pipe()` to extract reusable query logic into standalone functions
   * and compose them in a fluent chain.
   *
   * @example
   * ```ts
   * function withPagination<T>(page: number, size: number) {
   *   return (qb: SelectQueryBuilder<T>) =>
   *     qb.offset((page - 1) * size).limit(size);
   * }
   *
   * const users = await repo.createQueryBuilder("u")
   *   .pipe(withPagination(2, 20))
   *   .getMany();
   * ```
   */
  pipe(fn: (qb: this) => this): this {
    return fn(this);
  }

  /**
   * Add a parenthesized group of AND conditions.
   *
   * All conditions inside the group are combined with AND, then the whole
   * group is appended to the existing WHERE with AND semantics.
   *
   * @example
   * ```ts
   * qb.where("active", true)
   *   .andWhereGroup(g => g
   *     .where("age", ">=", 18)
   *     .where("role", "user")
   *   )
   * // WHERE "active" = true AND ("age" >= 18 AND "role" = 'user')
   * ```
   */
  andWhereGroup(fn: (group: WhereGroupBuilder<T>) => void): this {
    const group = new WhereGroupBuilder<T>(
      (ref) => this.resolveColumn(ref),
      (id) => this.em.wrap(id),
    );
    fn(group);
    this.whereClauses.push(group.build());
    return this;
  }

  /**
   * Add a parenthesized group of conditions with OR semantics.
   *
   * All conditions inside the group are combined with AND. The resulting
   * group is OR-ed with the existing WHERE conditions.
   *
   * @example
   * ```ts
   * qb.where("status", "active")
   *   .orWhereGroup(g => g
   *     .where("role", "admin")
   *     .where("verified", true)
   *   )
   * // WHERE "status" = 'active' OR ("role" = 'admin' AND "verified" = true)
   * ```
   */
  orWhereGroup(fn: (group: WhereGroupBuilder<T>) => void): this {
    const group = new WhereGroupBuilder<T>(
      (ref) => this.resolveColumn(ref),
      (id) => this.em.wrap(id),
    );
    fn(group);
    const groupSql = group.build();
    if (this.whereClauses.length === 0) {
      this.whereClauses.push(groupSql);
    } else {
      const existing =
        this.whereClauses.length === 1
          ? this.whereClauses[0]
          : Conditions.and(this.whereClauses);
      this.whereClauses = [Conditions.or([existing, groupSql])];
    }
    return this;
  }

  // ── RELATION-AWARE QUERIES ─────────────────────────────

  /**
   * Filter entities that have at least one related entity matching the condition.
   *
   * Generates `WHERE EXISTS (SELECT 1 FROM related_table WHERE correlation AND ...)`.
   * Resolves relation metadata automatically from `@ManyToOne`, `@OneToMany`, `@OneToOne`.
   *
   * @param relation - Property name of the relation on the entity (e.g., "comments", "author")
   * @param fn - Optional callback to add extra conditions on the related entity
   *
   * @example
   * ```ts
   * // Posts that have at least one comment
   * qb.whereHas("comments").getMany();
   *
   * // Posts that have recent comments
   * qb.whereHas("comments", sub =>
   *   sub.where("createdAt", ">=", sevenDaysAgo)
   * ).getMany();
   * ```
   */
  whereHas(
    relation: string,
    fn?: (subQb: SelectQueryBuilder<any, any>) => void,
  ): this {
    const subSql = this.buildRelationExistsSubquery(relation, fn);
    this.whereClauses.push(Conditions.exists(sql`(${subSql})`));
    return this;
  }

  /**
   * Filter entities that have NO related entities matching the condition.
   *
   * Generates `WHERE NOT EXISTS (SELECT 1 FROM related_table WHERE ...)`.
   *
   * @example
   * ```ts
   * // Posts without any comments
   * qb.whereNotHas("comments").getMany();
   * ```
   */
  whereNotHas(
    relation: string,
    fn?: (subQb: SelectQueryBuilder<any, any>) => void,
  ): this {
    const subSql = this.buildRelationExistsSubquery(relation, fn);
    this.whereClauses.push(Conditions.notExists(sql`(${subSql})`));
    return this;
  }

  /**
   * Add a relation count as a scalar subquery in the SELECT clause.
   *
   * @param relation - Relation property name
   * @param alias - Column alias for the count (default: `${relation}_count`)
   * @param fn - Optional callback to filter which related entities are counted
   *
   * @example
   * ```ts
   * const users = await em.createQueryBuilder(User, "u")
   *   .withCount("posts", "postCount")
   *   .withCount("posts", "activePostCount", sub => sub.where("status", "published"))
   *   .getRawMany();
   * ```
   */
  withCount(
    relation: string,
    alias?: string,
    fn?: (subQb: SelectQueryBuilder<any, any>) => void,
  ): this {
    const countSql = this.buildRelationCountSubquery(relation, fn);
    const colAlias = alias ?? `${relation}_count`;
    this.selectExpressions.push(
      sql`(${countSql}) AS ${raw(this.em.wrap(colAlias))}`,
    );
    return this;
  }

  /**
   * Shorthand for `leftJoinRelationAndSelect(relation, alias)`.
   *
   * Loads a relation via LEFT JOIN and includes all its columns in the result.
   *
   * @example
   * ```ts
   * qb.loadRelation("author").loadRelation("comments").getMany();
   * ```
   */
  loadRelation(relation: string, alias?: string): this {
    return this.leftJoinRelationAndSelect(relation, alias ?? relation);
  }

  // ── SUBQUERY INTEGRATION ───────────────────────────────

  /**
   * Add `WHERE column IN (subquery)` using a type-safe SelectQueryBuilder.
   *
   * @example
   * ```ts
   * const activeUserIds = em.createQueryBuilder(User, "u2")
   *   .select(["id"])
   *   .where("status", "active");
   *
   * const posts = await em.createQueryBuilder(Post, "p")
   *   .whereInSubquery("authorId", activeUserIds)
   *   .getMany();
   * ```
   */
  whereInSubquery(
    column: ColumnOf<T>,
    subQb: SelectQueryBuilder<any, any>,
  ): this;
  whereInSubquery(
    column: string,
    subQb: SelectQueryBuilder<any, any>,
  ): this;
  whereInSubquery(
    column: string,
    subQb: SelectQueryBuilder<any, any>,
  ): this {
    const qualified = this.resolveColumn(column);
    const subSql = subQb.toSql();
    this.whereClauses.push(
      Conditions.inSubquery(qualified, sql`(${subSql})`),
    );
    return this;
  }

  /**
   * Add `WHERE NOT IN (subquery)`.
   */
  whereNotInSubquery(
    column: ColumnOf<T>,
    subQb: SelectQueryBuilder<any, any>,
  ): this;
  whereNotInSubquery(
    column: string,
    subQb: SelectQueryBuilder<any, any>,
  ): this;
  whereNotInSubquery(
    column: string,
    subQb: SelectQueryBuilder<any, any>,
  ): this {
    const qualified = this.resolveColumn(column);
    const subSql = subQb.toSql();
    this.whereClauses.push(
      Conditions.notInSubquery(qualified, sql`(${subSql})`),
    );
    return this;
  }

  /**
   * Add `WHERE EXISTS (subquery)` using a SelectQueryBuilder.
   *
   * @example
   * ```ts
   * const activePosts = em.createQueryBuilder(Post, "p2")
   *   .select(["id"])
   *   .where(sql`"p2"."author_id" = "u"."id"`);
   *
   * const users = await em.createQueryBuilder(User, "u")
   *   .whereExistsSubquery(activePosts)
   *   .getMany();
   * ```
   */
  whereExistsSubquery(subQb: SelectQueryBuilder<any, any>): this {
    const subSql = subQb.toSql();
    this.whereClauses.push(Conditions.exists(sql`(${subSql})`));
    return this;
  }

  /**
   * Add `WHERE NOT EXISTS (subquery)`.
   */
  whereNotExistsSubquery(subQb: SelectQueryBuilder<any, any>): this {
    const subSql = subQb.toSql();
    this.whereClauses.push(Conditions.notExists(sql`(${subSql})`));
    return this;
  }

  /**
   * Add a scalar subquery to the SELECT clause.
   *
   * @example
   * ```ts
   * const latestComment = em.createQueryBuilder(Comment, "c")
   *   .select(["content"])
   *   .where(sql`"c"."post_id" = "p"."id"`)
   *   .orderBy({ createdAt: "DESC" })
   *   .limit(1);
   *
   * const posts = await em.createQueryBuilder(Post, "p")
   *   .addSelectSubquery(latestComment, "latestComment")
   *   .getRawMany();
   * ```
   */
  addSelectSubquery(
    subQb: SelectQueryBuilder<any, any>,
    alias: string,
  ): this {
    const subSql = subQb.toSql();
    this.selectExpressions.push(
      sql`(${subSql}) AS ${raw(this.em.wrap(alias))}`,
    );
    return this;
  }

  // ── SCOPES ─────────────────────────────────────────────

  /**
   * Apply a named scope defined as a static property on the entity class.
   *
   * Scopes are reusable query fragments defined on the entity:
   * ```ts
   * @Entity()
   * class User {
   *   static scopes = {
   *     active: (qb: SelectQueryBuilder<User>) => qb.where("status", "active"),
   *     recent: (qb: SelectQueryBuilder<User>) => qb.orderBy({ createdAt: "DESC" }).limit(10),
   *   };
   * }
   * ```
   *
   * @example
   * ```ts
   * const users = await repo.createQueryBuilder("u")
   *   .applyScope("active")
   *   .applyScope("recent")
   *   .getMany();
   * ```
   */
  applyScope(name: string): this {
    const scopes = (this.entity as any).scopes;
    if (!scopes || typeof scopes[name] !== "function") {
      const available = scopes ? Object.keys(scopes).join(", ") : "none";
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        `Scope "${name}" not found on entity ${this.entity.name}. Available: [${available}].`,
      );
    }
    scopes[name](this);
    return this;
  }

  // ── RAW APPEND ──────────────────────────────────────────

  /**
   * Append a raw SQL fragment to the query.
   */
  appendSql(fragment: Sql): this {
    this.extraSegments.push(fragment);
    return this;
  }

  // ── BUILD ───────────────────────────────────────────────

  /**
   * Build the final SQL query. Returns a `Sql` object (sql-template-tag).
   */
  toSql(): Sql {
    const tableName = this.resolveTableName();
    const qb = RawQueryBuilderFactory.create() as RawQueryBuilder;

    // Database type
    const internals = (this.em as any)._ctx;
    if (internals.isMySqlFamily()) qb.setDatabaseType("mysql");
    else if (internals.isSqlite?.()) qb.setDatabaseType("sqlite");
    else qb.setDatabaseType("postgresql");

    // SELECT
    if (this.selectColumns === "*") {
      const allCols = `${this.em.wrap(this.alias)}.*`;
      if (this.distinct) {
        qb.selectDistinct([allCols]);
      } else {
        qb.select([allCols]);
      }
    } else {
      if (this.distinct) {
        qb.selectDistinct(this.selectColumns as string[]);
      } else {
        qb.select(this.selectColumns as string[]);
      }
    }

    // Parameterized SELECT expressions (withCount, addSelectSubquery)
    for (const expr of this.selectExpressions) {
      qb.addSelectExpression(expr);
    }

    // FROM + MySQL index hints
    const fromExpr = `${this.em.wrapTable(tableName)} AS ${this.em.wrap(this.alias)}`;
    if (this.indexHints.length > 0 && internals.isMySqlFamily()) {
      const hints = this.indexHints
        .map((h) => `${h.type} INDEX (${this.em.wrap(h.indexName)})`)
        .join(" ");
      qb.from(`${fromExpr} ${hints}`);
    } else {
      qb.from(fromExpr);
    }

    // JOINs
    for (const j of this.joinClauses) {
      qb.join(
        j.type,
        this.em.wrapTable(j.table),
        this.em.wrap(j.alias),
        j.condition,
      );
    }

    // Soft delete auto-filter (use local copy to avoid mutating shared state)
    const effectiveWhere = [...this.whereClauses];
    const resolver = (this.em as any).resolver;
    if (resolver) {
      const deletedAtColumn = resolver.getDeletedAtColumn(this.entity);
      if (deletedAtColumn && !this.withDeletedFlag) {
        effectiveWhere.push(Conditions.isNull(this.col(deletedAtColumn)));
      }
    }

    // WHERE
    qb.where(effectiveWhere);

    // GROUP BY
    if (this.groupByCols.length > 0) {
      qb.groupBy(this.groupByCols);
    }

    // HAVING
    if (this.havingClauses.length > 0) {
      qb.having(this.havingClauses);
    }

    // ORDER BY
    if (this.orderByClauses.length > 0) {
      qb.orderBy(this.orderByClauses);
    }

    // LIMIT / OFFSET
    if (this.offsetValue !== undefined && this.limitValue !== undefined) {
      qb.limit([this.offsetValue, this.limitValue as number]);
    } else if (this.limitValue !== undefined) {
      qb.limit(this.limitValue as number);
    } else if (this.offsetValue !== undefined) {
      if (internals.isMySqlFamily()) {
        // MySQL requires LIMIT with OFFSET; use Number.MAX_SAFE_INTEGER
        qb.limit([this.offsetValue, Number.MAX_SAFE_INTEGER]);
      } else {
        qb.offset(this.offsetValue);
      }
    }

    // LOCK
    if (this.lockClause) {
      qb.appendSql(raw(this.lockClause));
    }

    // Extra segments
    for (const seg of this.extraSegments) {
      qb.appendSql(seg);
    }

    const built = qb.build();

    // pg_hint_plan: prepend /*+ ... */ before SELECT
    if (this.pgHints.length > 0) {
      const hintComment = `/*+ ${this.pgHints.join(" ")} */ `;
      return sql`${raw(hintComment)}${built}`;
    }

    return built;
  }

  /**
   * Get the raw SQL text and parameters (for debugging).
   */
  getSql(): { text: string; values: any[] } {
    const built = this.toSql();
    return { text: built.sql, values: built.values };
  }

  // ── EXECUTION: Safe (class instances) ───────────────────

  /**
   * Execute the query and return class instances.
   *
   * Always deserializes rows into actual entity instances via
   * `class-transformer`, so `instanceof`, class methods, lifecycle hooks,
   * and `em.save()` all work correctly.
   *
   * When `select()` is used with specific columns, validates that all
   * required (non-nullable) columns are included. Throws `OrmError` with
   * `MISSING_REQUIRED_COLUMNS` if a required column is omitted.
   *
   * For plain-object projections without validation, use `getPartialMany()`.
   * For completely untyped results, use `getRawMany()`.
   */
  async getMany(): Promise<T[]> {
    this.validateRequiredColumns();

    const built = this.toSql();
    const rows = await this.em.query<any>(built);

    const registry = DeserializerRegistry.getInstance();
    const entities = rows.map((row: any) =>
      registry.deserialize(this.entity, row),
    );

    return this.applyValidation(entities) as unknown as T[];
  }

  /**
   * Execute the query and return a single class instance or null.
   * Automatically adds LIMIT 1 if not already set.
   */
  async getOne(): Promise<T | null> {
    if (this.limitValue === undefined) {
      this.limitValue = 1;
    }
    const results = await this.getMany();
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Execute the query and return a single class instance.
   * Throws EntityNotFoundError if no result is found.
   */
  async getOneOrFail(): Promise<T> {
    const result = await this.getOne();
    if (result === null) {
      throw new EntityNotFoundError(this.entity.name);
    }
    return result;
  }

  /**
   * Execute the query and return both class instances and total count.
   */
  async getManyAndCount(): Promise<[T[], number]> {
    const [results, count] = await Promise.all([
      this.getMany(),
      this.getCount(),
    ]);
    return [results, count];
  }

  // ── EXECUTION: Partial (typed plain objects) ───────────

  /**
   * Execute the query and return plain objects with `Pick<T, K>` typing.
   *
   * No deserialization — results are NOT class instances. `instanceof`
   * returns false and lifecycle hooks do not fire. Do not pass these
   * to `em.save()`.
   *
   * When `select()` is used, the return type narrows to `Pick<T, K>[]`,
   * preventing access to unselected columns at compile time.
   */
  async getPartialMany(): Promise<TResult[]> {
    const built = this.toSql();
    const rows = await this.em.query<any>(built);
    return this.applyValidation(rows);
  }

  /**
   * Execute the query and return a single plain object or null.
   * Automatically adds LIMIT 1 if not already set.
   */
  async getPartialOne(): Promise<TResult | null> {
    if (this.limitValue === undefined) {
      this.limitValue = 1;
    }
    const results = await this.getPartialMany();
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Execute the query and return both plain objects and total count.
   */
  async getPartialManyAndCount(): Promise<[TResult[], number]> {
    const [results, count] = await Promise.all([
      this.getPartialMany(),
      this.getCount(),
    ]);
    return [results, count];
  }

  // ── EXECUTION: Raw (untyped plain objects) ─────────────

  /**
   * Execute the query and return untyped plain objects.
   *
   * Use when the result includes columns not in the entity definition
   * (e.g. `addSelect(sql\`COUNT(*)\`, "cnt")`). No deserialization,
   * no validation, no type narrowing.
   */
  async getRawMany(): Promise<Record<string, unknown>[]> {
    const built = this.toSql();
    return this.em.query<Record<string, unknown>>(built);
  }

  /**
   * Execute the query and return a single untyped plain object or null.
   * Automatically adds LIMIT 1 if not already set.
   */
  async getRawOne(): Promise<Record<string, unknown> | null> {
    if (this.limitValue === undefined) {
      this.limitValue = 1;
    }
    const results = await this.getRawMany();
    return results.length > 0 ? results[0] : null;
  }

  // ── EXECUTION: Streaming ────────────────────────────────

  /**
   * Stream results as an AsyncGenerator, fetching in batches via LIMIT/OFFSET.
   * Avoids loading the entire result set into memory.
   *
   * @param batchSize Number of rows per batch (default: 1000)
   */
  async *stream(batchSize = 1000): AsyncGenerator<TResult, void, undefined> {
    const effectiveBatchSize = Math.max(batchSize, 1);
    let currentOffset = 0;

    while (true) {
      const cloned = this.clone();
      cloned.offsetValue = currentOffset;
      cloned.limitValue = effectiveBatchSize;

      const batch = await cloned.getPartialMany();
      if (batch.length === 0) break;

      for (const row of batch) {
        yield row;
      }

      if (batch.length < effectiveBatchSize) break;
      currentOffset += effectiveBatchSize;
    }
  }

  // ── EXECUTION: Utility ─────────────────────────────────

  /**
   * Execute a COUNT(*) query with the same WHERE/JOIN conditions.
   */
  async getCount(): Promise<number> {
    const tableName = this.resolveTableName();
    const qb = RawQueryBuilderFactory.create() as RawQueryBuilder;

    const internals = (this.em as any)._ctx;
    if (internals.isMySqlFamily()) qb.setDatabaseType("mysql");
    else if (internals.isSqlite?.()) qb.setDatabaseType("sqlite");
    else qb.setDatabaseType("postgresql");

    qb.select(["COUNT(*) AS count"]);
    qb.from(`${this.em.wrapTable(tableName)} AS ${this.em.wrap(this.alias)}`);

    for (const j of this.joinClauses) {
      qb.join(
        j.type,
        this.em.wrapTable(j.table),
        this.em.wrap(j.alias),
        j.condition,
      );
    }

    // Soft delete auto-filter (re-derive, don't mutate shared state)
    const countWhere = [...this.whereClauses];
    const resolver = (this.em as any).resolver;
    if (resolver) {
      const deletedAtColumn = resolver.getDeletedAtColumn(this.entity);
      if (deletedAtColumn && !this.withDeletedFlag) {
        countWhere.push(Conditions.isNull(this.col(deletedAtColumn)));
      }
    }

    qb.where(countWhere);

    if (this.groupByCols.length > 0) {
      qb.groupBy(this.groupByCols);
    }
    if (this.havingClauses.length > 0) {
      qb.having(this.havingClauses);
    }

    const built = qb.build();
    const rows = await this.em.query<{ count: string | number }>(built);
    if (rows.length === 0) return 0;
    return Number(rows[0].count);
  }

  /**
   * Check if any rows match the conditions.
   * Uses `SELECT 1 ... LIMIT 1` for early termination instead of COUNT(*).
   */
  async exists(): Promise<boolean> {
    const tableName = this.resolveTableName();
    const qb = RawQueryBuilderFactory.create() as RawQueryBuilder;

    const internals = (this.em as any)._ctx;
    if (internals.isMySqlFamily()) qb.setDatabaseType("mysql");
    else if (internals.isSqlite?.()) qb.setDatabaseType("sqlite");
    else qb.setDatabaseType("postgresql");

    qb.select(["1"]);
    qb.from(`${this.em.wrapTable(tableName)} AS ${this.em.wrap(this.alias)}`);

    for (const j of this.joinClauses) {
      qb.join(
        j.type,
        this.em.wrapTable(j.table),
        this.em.wrap(j.alias),
        j.condition,
      );
    }

    // Soft delete auto-filter (don't mutate shared state)
    const existsWhere = [...this.whereClauses];
    const resolver = (this.em as any).resolver;
    if (resolver) {
      const deletedAtColumn = resolver.getDeletedAtColumn(this.entity);
      if (deletedAtColumn && !this.withDeletedFlag) {
        existsWhere.push(Conditions.isNull(this.col(deletedAtColumn)));
      }
    }

    qb.where(existsWhere);
    qb.limit(1);

    const built = qb.build();
    const rows = await this.em.query<Record<string, unknown>>(built);
    return rows.length > 0;
  }

  /**
   * Return the query as a Sql subquery with an alias (for use in FROM/JOIN).
   */
  asSubquery(alias: string): Sql {
    const built = this.toSql();
    return sql`(${built}) AS ${raw(this.em.wrap(alias))}`;
  }

  /**
   * Create a shallow clone of this query builder.
   * Useful for building variations of the same base query.
   */
  clone(): SelectQueryBuilder<T, TResult> {
    const cloned = new SelectQueryBuilder<T, TResult>(this.entity, this.alias, this.em);
    cloned.selectColumns = this.selectColumns === "*" ? "*" : [...this.selectColumns as string[]];
    cloned.distinct = this.distinct;
    cloned.whereClauses = [...this.whereClauses];
    cloned.orderByClauses = [...this.orderByClauses];
    cloned.groupByCols = [...this.groupByCols];
    cloned.havingClauses = [...this.havingClauses];
    cloned.joinClauses = [...this.joinClauses];
    cloned.limitValue = this.limitValue;
    cloned.offsetValue = this.offsetValue;
    cloned.lockClause = this.lockClause;
    cloned.withDeletedFlag = this.withDeletedFlag;
    cloned.extraSegments = [...this.extraSegments];
    cloned.rowValidator = this.rowValidator;
    cloned.arrayValidatorFn = this.arrayValidatorFn;
    cloned.selectedPropertyKeys = this.selectedPropertyKeys ? [...this.selectedPropertyKeys] : null;
    cloned.indexHints = [...this.indexHints];
    cloned.pgHints = [...this.pgHints];
    cloned.propertyToColumnMap = this.propertyToColumnMap;
    cloned.dialectExpression = this.dialectExpression;
    cloned.aliasRegistry = new Map(this.aliasRegistry);
    cloned.selectExpressions = [...this.selectExpressions];
    return cloned;
  }

  // ── Private ─────────────────────────────────────────────

  /**
   * Validate that all required (non-nullable) columns are included in
   * the select() projection. Only runs when select() was called with
   * specific columns. Throws OrmError if required columns are missing.
   */
  protected validateRequiredColumns(): void {
    if (this.selectedPropertyKeys === null) return;

    const columns: ColumnMetadata[] =
      Reflect.getMetadata(COLUMN_TOKEN, this.entity.prototype) ??
      Reflect.getMetadata(COLUMN_TOKEN, this.entity) ??
      [];

    if (columns.length === 0) return;

    const selectedSet = new Set(this.selectedPropertyKeys);
    const missing: string[] = [];

    for (const col of columns) {
      const opts = col.options ?? ({} as any);
      const isRequired =
        opts.nullable !== true &&
        opts.default === undefined &&
        opts.autoIncrement !== true;

      const key = col.propertyKey ?? col.name;
      if (isRequired && key && !selectedSet.has(key)) {
        missing.push(key);
      }
    }

    if (missing.length > 0) {
      throw new OrmError(
        OrmErrorCode.MISSING_REQUIRED_COLUMNS,
        `getMany() requires all non-nullable columns when using select(). ` +
          `Missing: [${missing.join(", ")}]. ` +
          `Use getPartialMany() to skip this check.`,
      );
    }
  }

  /**
   * Apply row-level and/or array-level validation to query results.
   * When no validators are attached, returns the rows as-is (zero overhead).
   */
  protected applyValidation(rows: any[]): TResult[] {
    let result = rows as TResult[];

    // Row-level validation
    if (this.rowValidator) {
      const v = this.rowValidator;
      if (typeof v === "function") {
        result = result.map(v);
      } else {
        // Zod-style: object with .parse() method
        result = result.map((row) => v.parse(row));
      }
    }

    // Array-level validation
    if (this.arrayValidatorFn) {
      const v = this.arrayValidatorFn;
      if (typeof v === "function") {
        result = v(result);
      } else {
        result = v.parse(result);
      }
    }

    return result;
  }

  protected resolveTableName(): string {
    const resolver = (this.em as any).resolver;
    if (!resolver) {
      throw new OrmError(
        OrmErrorCode.ENTITY_METADATA_NOT_FOUND,
        `EntityManager not connected. Cannot resolve table name for ${this.entity.name}.`,
      );
    }
    const metadata = resolver.resolveEntityMetadata(this.entity);
    if (!metadata) {
      throw new OrmError(
        OrmErrorCode.ENTITY_METADATA_NOT_FOUND,
        `Entity metadata not found for ${this.entity.name}. Did you register the entity?`,
      );
    }
    return metadata.name!;
  }

  protected resolveCondition(
    columnOrCondition: string | Sql | ColumnCondition,
    operatorOrValue?: any,
    value?: any,
  ): Sql {
    // ColumnCondition from QueryDSL expressions (u.firstName.eq("Alice"))
    if (columnOrCondition instanceof ColumnCondition) {
      return columnOrCondition.resolve((ref) => this.resolveColumn(ref));
    }

    // Overload 1: raw Sql condition
    if (typeof columnOrCondition !== "string") {
      return columnOrCondition;
    }

    const column = columnOrCondition;
    const qualified = this.resolveColumn(column);

    // Overload 2: where("name", "Alice") — 2 args, equals
    if (value === undefined) {
      const val = operatorOrValue;
      if (val === null) {
        return Conditions.isNull(qualified);
      }
      if (val instanceof Object && "sql" in val) {
        // Sql object passed as value
        return sql`${raw(qualified)} = ${val}`;
      }
      if (Array.isArray(val)) {
        return Conditions.in(qualified, val);
      }
      return Conditions.equals(qualified, val);
    }

    // Overload 3: where("age", ">=", 18) — 3 args, operator
    const operator = operatorOrValue as string;
    const normalizedOp = operator.trim().toUpperCase() as WhereOperator;

    switch (normalizedOp) {
      case "=":
        return Conditions.equals(qualified, value);
      case "!=":
      case "<>":
        return Conditions.notEquals(qualified, value);
      case ">":
        return Conditions.gt(qualified, value);
      case ">=":
        return Conditions.gte(qualified, value);
      case "<":
        return Conditions.lt(qualified, value);
      case "<=":
        return Conditions.lte(qualified, value);
      case "LIKE":
        return Conditions.like(qualified, value);
      case "NOT LIKE":
        return Conditions.notLike(qualified, value);
      case "ILIKE":
        if (this.dialectExpression) {
          return this.dialectExpression.ilike(qualified, value);
        }
        return sql`${raw(qualified)} ILIKE ${value}`;
      case "IN":
        return Conditions.in(qualified, Array.isArray(value) ? value : [value]);
      case "NOT IN":
        return Conditions.notIn(
          qualified,
          Array.isArray(value) ? value : [value],
        );
      case "IS NULL":
        return Conditions.isNull(qualified);
      case "IS NOT NULL":
        return Conditions.isNotNull(qualified);
      case "BETWEEN":
        if (Array.isArray(value) && value.length === 2) {
          return Conditions.between(qualified, value[0], value[1]);
        }
        throw new OrmError(
          OrmErrorCode.INVALID_QUERY,
          `BETWEEN operator requires an array of [min, max]. Got: ${typeof value}`,
        );
      default:
        throw new OrmError(
          OrmErrorCode.INVALID_QUERY,
          `Unsupported operator: "${operator}". Use =, !=, <>, <, >, <=, >=, LIKE, IN, NOT IN, IS NULL, IS NOT NULL, BETWEEN.`,
        );
    }
  }
}
