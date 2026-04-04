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
  protected orderByClauses: Array<{ column: string; direction: "ASC" | "DESC" }> =
    [];
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
  protected indexHints: Array<{ type: "USE" | "FORCE" | "IGNORE"; indexName: string }> = [];
  protected pgHints: string[] = [];

  /** Maps TypeScript property names to DB column names (NamingStrategy). */
  protected propertyToColumnMap?: Map<string, string>;

  constructor(entity: ClazzType<T>, alias: string, em: EntityManager) {
    this.entity = entity;
    this.alias = alias;
    this.em = em;
  }

  /** Set the property-to-column mapping for NamingStrategy support. */
  setPropertyToColumnMap(map: Map<string, string>): this {
    this.propertyToColumnMap = map;
    return this;
  }

  // ── Helpers ──────────────────────────────────────────────

  /** Qualify a column with the main alias: `"u"."name"` */
  protected col(column: string): string {
    const dbCol = this.propertyToColumnMap?.get(column) ?? column;
    return `${this.em.wrap(this.alias)}.${this.em.wrap(dbCol)}`;
  }

  /** Qualify a column for a different alias */
  protected qualifiedCol(tableAlias: string, column: string): string {
    return `${this.em.wrap(tableAlias)}.${this.em.wrap(column)}`;
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
  select<K extends ColumnOf<T>>(columns: K[]): SelectQueryBuilder<T, Pick<T, K>>;
  select(columns: "*"): SelectQueryBuilder<T, T>;
  select<K extends ColumnOf<T>>(columns: K[] | "*"): SelectQueryBuilder<T, any> {
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
  addSelect(expr: Sql | string, alias?: string): this {
    const exprStr =
      typeof expr === "string" ? this.col(expr) : expr.sql;
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
   * 1. `where("name", "Alice")` → equals
   * 2. `where("age", ">=", 18)` → operator
   * 3. `where(Conditions.like("u"."name", "%alice%"))` → raw Sql
   */
  where(condition: Sql): this;
  where(column: ColumnOf<T>, value: T[ColumnOf<T>] | Sql | null): this;
  where(
    column: ColumnOf<T>,
    operator: WhereOperator,
    value: any,
  ): this;
  where(
    columnOrCondition: ColumnOf<T> | Sql,
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
  andWhere(column: ColumnOf<T>, value: T[ColumnOf<T>] | Sql | null): this;
  andWhere(column: ColumnOf<T>, operator: WhereOperator, value: any): this;
  andWhere(
    columnOrCondition: ColumnOf<T> | Sql,
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
  orWhere(column: ColumnOf<T>, value: T[ColumnOf<T>] | Sql | null): this;
  orWhere(column: ColumnOf<T>, operator: WhereOperator, value: any): this;
  orWhere(
    columnOrCondition: ColumnOf<T> | Sql,
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
   * WHERE column IN (values).
   */
  whereIn(column: ColumnOf<T>, values: any[]): this {
    this.whereClauses.push(Conditions.in(this.col(column), values));
    return this;
  }

  /**
   * WHERE column NOT IN (values).
   */
  whereNotIn(column: ColumnOf<T>, values: any[]): this {
    this.whereClauses.push(Conditions.notIn(this.col(column), values));
    return this;
  }

  /**
   * WHERE column IS NULL.
   */
  whereNull(column: ColumnOf<T>): this {
    this.whereClauses.push(Conditions.isNull(this.col(column)));
    return this;
  }

  /**
   * WHERE column IS NOT NULL.
   */
  whereNotNull(column: ColumnOf<T>): this {
    this.whereClauses.push(Conditions.isNotNull(this.col(column)));
    return this;
  }

  /**
   * WHERE column BETWEEN min AND max.
   */
  whereBetween(column: ColumnOf<T>, min: any, max: any): this {
    this.whereClauses.push(Conditions.between(this.col(column), min, max));
    return this;
  }

  /**
   * WHERE column LIKE pattern.
   */
  whereLike(column: ColumnOf<T>, pattern: string): this {
    this.whereClauses.push(Conditions.like(this.col(column), pattern));
    return this;
  }

  // ── JOIN ─────────────────────────────────────────────────

  /**
   * Add a LEFT JOIN.
   *
   * @example
   * ```ts
   * qb.leftJoin("posts", "p", "u.id = p.authorId")
   * ```
   */
  leftJoin(table: string, alias: string, condition: Sql | string): this {
    return this.addJoin("LEFT", table, alias, condition);
  }

  /**
   * Add an INNER JOIN.
   */
  innerJoin(table: string, alias: string, condition: Sql | string): this {
    return this.addJoin("INNER", table, alias, condition);
  }

  /**
   * Add a RIGHT JOIN.
   */
  rightJoin(table: string, alias: string, condition: Sql | string): this {
    return this.addJoin("RIGHT", table, alias, condition);
  }

  protected addJoin(
    type: "LEFT" | "INNER" | "RIGHT",
    table: string,
    alias: string,
    condition: Sql | string,
  ): this {
    const cond =
      typeof condition === "string"
        ? sql`${raw(condition)}`
        : condition;
    this.joinClauses.push({ type, table, alias, condition: cond });
    return this;
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
   * Add a single ORDER BY clause.
   */
  addOrderBy(column: ColumnOf<T>, direction: "ASC" | "DESC"): this {
    this.orderByClauses.push({ column: this.col(column), direction });
    return this;
  }

  /**
   * Set GROUP BY columns.
   */
  groupBy(columns: ColumnOf<T>[]): this {
    this.groupByCols = columns.map((c) => this.col(c));
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

    // Soft delete auto-filter
    const resolver = (this.em as any).resolver;
    if (resolver) {
      const deletedAtColumn = resolver.getDeletedAtColumn(this.entity);
      if (deletedAtColumn && !this.withDeletedFlag) {
        this.whereClauses.push(
          Conditions.isNull(this.col(deletedAtColumn)),
        );
      }
    }

    // WHERE
    qb.where(this.whereClauses);

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
    qb.from(
      `${this.em.wrapTable(tableName)} AS ${this.em.wrap(this.alias)}`,
    );

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
   */
  async exists(): Promise<boolean> {
    const count = await this.getCount();
    return count > 0;
  }

  /**
   * Return the query as a Sql subquery with an alias (for use in FROM/JOIN).
   */
  asSubquery(alias: string): Sql {
    const built = this.toSql();
    return sql`(${built}) AS ${raw(this.em.wrap(alias))}`;
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
    columnOrCondition: ColumnOf<T> | Sql,
    operatorOrValue?: any,
    value?: any,
  ): Sql {
    // Overload 1: raw Sql condition
    if (typeof columnOrCondition !== "string") {
      return columnOrCondition;
    }

    const column = columnOrCondition;
    const qualified = this.col(column);

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
    const normalizedOp = operator.trim().toUpperCase();

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
