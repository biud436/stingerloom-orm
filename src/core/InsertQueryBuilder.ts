/* eslint-disable @typescript-eslint/no-explicit-any */
import { Sql, isSqlFragment } from "../utils/sqlTag";
import { ClazzType } from "../utils";
import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";
import {
  isConditionLike,
  type ConditionLike,
  type ColumnResolver,
} from "./expressions/ConditionLike";
import type { DialectExpression } from "../dialects/DialectExpression";
import type { EntityManager } from "./EntityManager";
import type { SelectQueryBuilder } from "./SelectQueryBuilder";
import { qAlias, type QEntity } from "./query-builder/alias/qAlias";
import {
  qExcluded,
  splitColumnRef,
} from "./query-builder/alias/qExcluded";
import { renderNullishArg } from "./expressions/NullishExpression";
import { isScalarExpression } from "./expressions/ScalarExpression";
import { isAggregateExpression } from "./expressions/AggregateExpression";
import { isJsonPathExpression } from "./expressions/JsonPathExpression";

/**
 * One row handed to {@link InsertQueryBuilder.values}. Every entity property
 * is optional and may hold either its declared value or a raw `Sql` fragment
 * (e.g. ``sql`NOW()` ``) that is spliced into the VALUES tuple untouched.
 */
export type InsertValues<T> = {
  [K in keyof T]?: T[K] | Sql;
};

/**
 * A value assignable in the `DO UPDATE SET` clause.
 *
 * Beyond literals and raw `Sql`, this accepts the whole QueryDSL expression
 * vocabulary — column references from `qAlias` / `qExcluded`, scalar
 * expressions built from them (`.add()`, `greatest()`, `coalesce()` …),
 * aggregates and JSON path extractions.
 */
export type ConflictSetValue<V> = V | Sql | object;

/**
 * The `DO UPDATE SET` assignment map: entity properties to the values or
 * expressions they take when a row conflicts.
 */
export type ConflictSet<T> = {
  [K in keyof T]?: ConflictSetValue<T[K]>;
};

/**
 * Callback form of {@link InsertQueryBuilder.doUpdate}. Receives a reference
 * to the row already stored (`target`) and to the row the INSERT proposed
 * (`excluded`), so the SET expressions can combine both.
 *
 * @example
 * ```ts
 * .doUpdate((t, ex) => ({ records: t.records.add(ex.records) }))
 * ```
 */
export type ConflictSetFactory<T> = (
  target: QEntity<T>,
  excluded: QEntity<T>,
) => ConflictSet<T>;

/**
 * @internal One resolved `DO UPDATE SET` assignment. Expression-valued
 * entries arrive already rendered; literal entries stay unrendered so the
 * write path can apply the column's write transformer before binding them.
 */
export type ResolvedSetEntry =
  | { kind: "expression"; property: string; value: Sql }
  | { kind: "literal"; property: string; value: unknown };

/** @internal The conflict target an INSERT statement declares. */
export interface ConflictTarget {
  /** Entity property names. Empty when a constraint name is used instead. */
  properties: string[];
  /** PostgreSQL `ON CONFLICT ON CONSTRAINT <name>`. */
  constraintName?: string;
  /** PostgreSQL partial-unique-index predicate: `ON CONFLICT (…) WHERE …`. */
  indexPredicate?: Sql;
}

/** @internal What an INSERT does when a row conflicts. */
export type ConflictAction =
  | { kind: "none" }
  | { kind: "nothing" }
  | {
      kind: "update";
      set: ResolvedSetEntry[];
      where?: Sql;
      /**
       * The DB columns `set` reads from the proposed row. MySQL 8.0.19+
       * reads them through a row alias, which holds only the columns the
       * INSERT lists, so the write path lists any missing one with DEFAULT.
       */
      proposedColumns?: string[];
    };

/** @internal The rows of an `INSERT … SELECT`: a query and the columns it fills, by position. */
export interface InsertSelectSource {
  /** Entity property names, in the order the query selects their values. */
  properties: string[];
  query: SelectQueryBuilder<any, any>;
}

/** @internal Everything {@link InsertQueryBuilder} hands to the write path. */
export interface InsertBuilderSpec<T> {
  /** The VALUES rows; empty when {@link source} supplies the rows. */
  items: InsertValues<T>[];
  source?: InsertSelectSource;
  target?: ConflictTarget;
  action: ConflictAction;
}

/** Options for {@link InsertQueryBuilder.onConflict}. */
export interface OnConflictOptions {
  /**
   * Index predicate for a **partial** unique index — emitted as
   * `ON CONFLICT (cols) WHERE <predicate>`. PostgreSQL only; SQLite accepts
   * the syntax for partial indexes too, MySQL has no conflict target at all.
   *
   * This narrows which *index* arbitrates the conflict. To filter which
   * conflicting rows get updated, use {@link InsertQueryBuilder.doUpdateWhere}.
   */
  where?: Sql | ConditionLike;
}

/**
 * Fluent builder for `INSERT … VALUES … ON CONFLICT …` — or
 * `INSERT … SELECT … ON CONFLICT …` with `.values(columns, query)` — with
 * the full QueryDSL expression vocabulary available in the conflict action.
 *
 * Created by `em.createInsertBuilder(Entity)` or
 * `em.createInsertBuilder(qAlias(Entity, "alias"))`. It is the expression-
 * capable counterpart to `em.upsert()` / `em.batchUpsert()`, which can only
 * overwrite the columns passed with the proposed values (plus the ORM's own
 * `@Version` / timestamp / `@DeletedAt` bookkeeping).
 *
 * The reason to reach for it is a conflict action that has to *read* the
 * stored row — an accumulating counter, a high-water mark, a merge — which
 * cannot be expressed as `col = EXCLUDED.col` and which a read-then-write
 * round trip cannot do safely without row locks:
 *
 * @example Accumulate counters and keep the later timestamp
 * ```ts
 * await em.createInsertBuilder(SyncMarker)
 *   .values(rows)
 *   .onConflict(["mac", "bucketStart"])
 *   .doUpdate((t, ex) => ({
 *     records:  t.records.add(ex.records),
 *     lastTime: greatest(t.lastTime, ex.lastTime),
 *     syncedAt: sql`NOW()`,
 *   }))
 *   .execute();
 * ```
 *
 * Dialect behavior:
 *
 * - **PostgreSQL** — `ON CONFLICT (cols) DO UPDATE SET … WHERE …`, plus
 *   `ON CONSTRAINT` and partial-index predicates.
 * - **SQLite** — same, minus `ON CONSTRAINT`.
 * - **MySQL / MariaDB** — `ON DUPLICATE KEY UPDATE …`. The engine has no
 *   conflict target, so `.onConflict()` columns are accepted (they keep the
 *   call portable) but not emitted; `.doNothing()` becomes `INSERT IGNORE`.
 *   `.onConflictConstraint()`, `.onConflict(…, { where })` and
 *   `.doUpdateWhere()` have no MySQL equivalent and throw.
 *
 * Like `createUpdateBuilder()`, this is a **statement-level** API: it does
 * not emit `beforeInsert` / `afterInsert` events or run entity hooks. Tenant
 * columns, `@CreateTimestamp` / `@UpdateTimestamp` / `@Version` defaults and
 * column transformers on the inserted values are applied exactly as in
 * `insertMany()`.
 */
export class InsertQueryBuilder<T> {
  private rows: InsertValues<T>[] = [];
  private source: InsertSelectSource | undefined;
  private conflictTarget: ConflictTarget | undefined;
  private action: ConflictAction = { kind: "none" };
  /**
   * The DB columns the `doUpdate()` being rendered reads from the proposed
   * row, collected by the column resolver; undefined outside that call.
   */
  private proposedReads: Set<string> | undefined;

  constructor(
    private readonly em: EntityManager,
    private readonly entity: ClazzType<T>,
    private readonly aliasName: string,
    private readonly propertyToColumnMap: Map<string, string>,
    private readonly dialectExpression?: DialectExpression,
    /**
     * The stored row as the conflict action reads it — the wrapped table
     * name, e.g. `"counter"`. Same reference `em.upsert()` uses for its
     * `@Version` increment.
     */
    private readonly storedRowRef?: string,
  ) {}

  // ── VALUES ─────────────────────────────────────────────

  /**
   * Add one row or several to the VALUES list. Multiple calls accumulate,
   * so rows can be appended in a loop.
   *
   * Each cell takes either the property's declared value or a raw `Sql`
   * fragment. Values go through the column's write transformer; `Sql`
   * fragments are spliced verbatim.
   */
  values(data: InsertValues<T> | InsertValues<T>[]): this;
  /**
   * Take the rows from a query — `INSERT INTO t (columns) SELECT …`. The
   * query's selected values fill `columns` **by position**, so it must
   * select them explicitly and in the same order.
   *
   * The query runs as built, its own tenant and soft-delete scoping
   * included. The INSERT side follows `insertMany()`: the tenant column,
   * the STI discriminator and unlisted `@CreateTimestamp` /
   * `@UpdateTimestamp` / `@Version` columns are filled in by the ORM.
   *
   * @param columns - The entity properties the query fills, in its select
   *   order: declared columns, or relations that own a foreign key.
   * @param query - A `SelectQueryBuilder` with an explicit select list. It
   *   is not modified.
   *
   * @example Roll orders up into daily totals, adding to existing ones
   * ```ts
   * await em.createInsertBuilder(DailyTotal)
   *   .values(["day", "total"], em.createQueryBuilder(Order, "o")
   *     .select([o.day, sum(o.amount).as("total")])
   *     .groupBy(["day"]))
   *   .onConflict(["day"])
   *   .doUpdate((t, ex) => ({ total: t.total.add(ex.total) }))
   *   .execute();
   * ```
   */
  values(
    columns: Array<keyof T & string>,
    query: SelectQueryBuilder<any, any>,
  ): this;
  values(
    data: InsertValues<T> | InsertValues<T>[] | Array<keyof T & string>,
    query?: SelectQueryBuilder<any, any>,
  ): this {
    if (query !== undefined) {
      return this.valuesFromQuery(data as Array<keyof T & string>, query);
    }
    if (this.source) {
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        "InsertQueryBuilder.values(): this INSERT already takes its rows from a query. An INSERT … SELECT has no VALUES rows.",
      );
    }
    if (Array.isArray(data)) {
      this.rows.push(...(data as InsertValues<T>[]));
    } else {
      this.rows.push(data);
    }
    return this;
  }

  // ── Conflict target ────────────────────────────────────

  /**
   * Declare which columns arbitrate the conflict. Accepts entity property
   * names or `qAlias` column references; both resolve through the naming
   * strategy.
   *
   * Defaults to the primary key when omitted.
   */
  onConflict(
    columns: Array<(keyof T & string) | { toString(): string }>,
    options?: OnConflictOptions,
  ): this {
    const properties = columns.map((c) =>
      typeof c === "string" ? c : splitColumnRef(String(c)).property,
    );
    if (properties.length === 0) {
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        "InsertQueryBuilder.onConflict() requires at least one column. Omit the call entirely to arbitrate on the primary key.",
      );
    }
    this.conflictTarget = {
      properties,
      indexPredicate: options?.where
        ? this.resolveCondition(options.where)
        : undefined,
    };
    return this;
  }

  /**
   * Arbitrate the conflict by unique-constraint name —
   * `ON CONFLICT ON CONSTRAINT <name>`. **PostgreSQL only**; the name is
   * emitted as a quoted identifier.
   *
   * Prefer {@link onConflict} unless the constraint is one the column list
   * cannot name (e.g. an exclusion constraint).
   */
  onConflictConstraint(name: string): this {
    if (!name || !name.trim()) {
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        "InsertQueryBuilder.onConflictConstraint() requires a constraint name.",
      );
    }
    this.conflictTarget = { properties: [], constraintName: name };
    return this;
  }

  // ── Conflict action ────────────────────────────────────

  /** Skip conflicting rows: `DO NOTHING` (PG/SQLite) / `INSERT IGNORE` (MySQL). */
  doNothing(): this {
    this.action = { kind: "nothing" };
    return this;
  }

  /**
   * Overwrite the listed columns with the proposed values
   * (`col = EXCLUDED.col`). Unlike `em.upsert()`, no `@Version`,
   * `@UpdateTimestamp` or `@DeletedAt` assignment is added.
   */
  doUpdate(columns: Array<keyof T & string>): this;
  /**
   * Assign literal values or raw `Sql` to the listed columns on conflict.
   */
  doUpdate(set: ConflictSet<T>): this;
  /**
   * Build the assignments from the stored row and the proposed row — the
   * expression form.
   *
   * @param factory receives `(target, excluded)`; `target` reads the row
   *        already in the table, `excluded` the row this INSERT proposed.
   */
  doUpdate(factory: ConflictSetFactory<T>): this;
  doUpdate(
    spec: Array<keyof T & string> | ConflictSet<T> | ConflictSetFactory<T>,
  ): this {
    const proposedReads = new Set<string>();
    this.proposedReads = proposedReads;
    let set: ResolvedSetEntry[];
    try {
      set = Array.isArray(spec)
        ? this.setFromColumnList(spec)
        : typeof spec === "function"
          ? this.resolveSet(
              spec(
                qAlias(this.entity, this.aliasName),
                qExcluded(this.entity),
              ),
            )
          : this.resolveSet(spec);
    } finally {
      this.proposedReads = undefined;
    }

    if (set.length === 0) {
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        "InsertQueryBuilder.doUpdate() produced no assignments. Pass at least one column, or call .doNothing() to skip conflicting rows.",
      );
    }
    const existingWhere =
      this.action.kind === "update" ? this.action.where : undefined;
    this.action = {
      kind: "update",
      set,
      where: existingWhere,
      proposedColumns: [...proposedReads],
    };
    return this;
  }

  /**
   * Restrict which conflicting rows the update touches —
   * `DO UPDATE SET … WHERE <condition>`. Rows that fail the condition are
   * left untouched (and not counted as inserted).
   *
   * PostgreSQL and SQLite only — MySQL's `ON DUPLICATE KEY UPDATE` takes no
   * WHERE clause. Express the same intent there with a `CASE` in the SET
   * value, or by making the assignment idempotent.
   *
   * Column references on the entity alias read the stored row (rendered
   * qualified by the table name); use the `excluded` reference for the
   * proposed one.
   */
  doUpdateWhere(condition: Sql | ConditionLike): this {
    if (this.action.kind !== "update") {
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        "InsertQueryBuilder.doUpdateWhere() must follow .doUpdate() — there is no update to filter.",
      );
    }
    this.action = {
      ...this.action,
      where: this.resolveCondition(condition),
    };
    return this;
  }

  // ── Execution ──────────────────────────────────────────

  /**
   * Execute the INSERT and return the affected row count.
   *
   * Runs inside the EntityManager's transaction wrapper, with tenant
   * scoping, timestamp/version defaults and column transformers applied
   * exactly as `insertMany()` applies them.
   *
   * Note that "affected" is engine-specific for an upsert: MySQL reports 2
   * for a row it updated and 1 for a row it inserted, while PostgreSQL and
   * SQLite report 1 per row written and 0 for one skipped.
   */
  async execute(): Promise<{ affected: number }> {
    return (this.em as any).executeBuilderInsert(this.entity, this.spec());
  }

  /**
   * Execute the INSERT and return the rows it wrote, as entity instances —
   * the inserted rows and the rows the conflict action updated, with
   * generated keys, database defaults and the values the conflict action
   * computed. A row the statement skipped (`doNothing()`, a failed
   * `doUpdateWhere()`, another tenant's row) is not returned. Relations are
   * not loaded.
   *
   * PostgreSQL and SQLite use `RETURNING *`; so does MariaDB 10.5+ for an
   * INSERT without a conflict action.
   *
   * MySQL has no `RETURNING`, so there this writes **one row per call** and
   * reads it back by key — the auto-increment primary key (reported through
   * `LAST_INSERT_ID()`), else the `onConflict()` columns for an update, else
   * the primary key. More than one row throws `UNSUPPORTED_OPERATION` before
   * anything is sent. MariaDB takes the same path whenever a conflict action
   * is set. An `INSERT … SELECT` has no row to read back, so on that path it
   * throws `UNSUPPORTED_OPERATION` too.
   *
   * @example Accumulate and get the new totals back
   * ```ts
   * const [marker] = await em.createInsertBuilder(SyncMarker)
   *   .values(row)
   *   .onConflict(["mac", "bucketStart"])
   *   .doUpdate((t, ex) => ({ records: t.records.add(ex.records) }))
   *   .executeAndReturn();
   * marker.records; // the stored total after this write
   * ```
   */
  async executeAndReturn(): Promise<T[]> {
    return (this.em as any).executeBuilderInsertAndReturn(
      this.entity,
      this.spec(),
    );
  }

  /**
   * Build the SQL without executing — useful for tests and inspection.
   * Tenant scoping is **not** applied here (it is added at execute time).
   */
  build(): Sql {
    return (this.em as any).buildBuilderInsertSql(this.entity, this.spec());
  }

  /** Convenience accessor returning the SQL text and bound values. */
  toSql(): { text: string; values: unknown[] } {
    const built = this.build();
    return { text: built.text, values: built.values };
  }

  // ── internals ──────────────────────────────────────────

  /** @internal The immutable snapshot the write path consumes. */
  private spec(): InsertBuilderSpec<T> {
    if (this.rows.length === 0 && !this.source) {
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        "InsertQueryBuilder: no rows to insert. Call .values() at least once.",
      );
    }
    return {
      items: this.rows,
      source: this.source,
      target: this.conflictTarget,
      action: this.action,
    };
  }

  private valuesFromQuery(
    columns: Array<keyof T & string>,
    query: SelectQueryBuilder<any, any>,
  ): this {
    if (this.source || this.rows.length > 0) {
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        "InsertQueryBuilder.values(columns, query): an INSERT takes its rows from one VALUES list or one query, and this one already has " +
          (this.source ? "a query." : "VALUES rows."),
      );
    }
    if (!Array.isArray(columns) || columns.length === 0) {
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        "InsertQueryBuilder.values(columns, query) requires at least one column: the properties the query's select list fills, in order.",
      );
    }
    const repeated = columns.find((c, i) => columns.indexOf(c) !== i);
    if (repeated !== undefined) {
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        `InsertQueryBuilder.values(columns, query) names '${repeated}' twice.`,
      );
    }
    this.source = { properties: [...columns], query };
    return this;
  }

  /** `col = EXCLUDED.col` for each named column. */
  private setFromColumnList(
    columns: Array<keyof T & string>,
  ): ResolvedSetEntry[] {
    const excluded = qExcluded(this.entity) as any;
    return columns.map((property) => ({
      kind: "expression" as const,
      property,
      value: renderNullishArg(
        excluded[property],
        this.columnResolver,
        this.dialectExpression,
      ),
    }));
  }

  /**
   * Split an assignment map into pre-rendered expressions and literals.
   *
   * Literals stay unrendered on purpose: the write path knows each column's
   * metadata and applies its write transformer before binding, which the
   * builder cannot do.
   */
  private resolveSet(set: ConflictSet<T>): ResolvedSetEntry[] {
    const entries: ResolvedSetEntry[] = [];
    for (const property of Object.keys(set) as Array<keyof T & string>) {
      const value = set[property];
      if (value === undefined) continue;
      if (this.isExpressionValue(value)) {
        entries.push({
          kind: "expression",
          property,
          value: renderNullishArg(
            value,
            this.columnResolver,
            this.dialectExpression,
          ),
        });
        continue;
      }
      entries.push({ kind: "literal", property, value });
    }
    return entries;
  }

  /**
   * Whether a SET value is an expression to render rather than a value to
   * bind. `Sql` fragments count — they are spliced as written.
   */
  private isExpressionValue(value: unknown): boolean {
    if (value === null || typeof value !== "object") return false;
    if (isSqlFragment(value)) return true;
    const marked = value as { __isColumnExpression?: unknown };
    return (
      marked.__isColumnExpression === true ||
      isScalarExpression(value) ||
      isAggregateExpression(value) ||
      isJsonPathExpression(value)
    );
  }

  private resolveCondition(condition: Sql | ConditionLike): Sql {
    if (isConditionLike(condition)) {
      return condition.resolve(this.columnResolver, this.dialectExpression);
    }
    return condition;
  }

  /**
   * Resolves a deferred column reference for the conflict clause.
   *
   * References carrying the `qExcluded` sentinel alias render as the
   * dialect's proposed-row syntax; everything else is a stored-row read and
   * renders **qualified by the table name** (`"counter"."records"`).
   *
   * Qualifying is not optional on PostgreSQL: inside `DO UPDATE SET` and its
   * `WHERE`, both the target table and `EXCLUDED` are in scope, so a bare
   * column name is rejected as ambiguous. MySQL/MariaDB and SQLite accept
   * the qualified form too, so one spelling serves every dialect — it is
   * the same reference `em.upsert()` emits for its `@Version` increment.
   */
  private columnResolver: ColumnResolver = (ref: string) => {
    const { property, isExcluded } = splitColumnRef(ref);
    const dbCol = this.propertyToColumnMap.get(property) ?? property;
    const wrapped = this.em.wrap(dbCol);
    if (isExcluded) {
      this.proposedReads?.add(dbCol);
      return (this.em as any).renderExcludedColumn(
        wrapped,
        this.storedRowRef ?? "",
      );
    }
    return this.storedRowRef ? `${this.storedRowRef}.${wrapped}` : wrapped;
  };
}
