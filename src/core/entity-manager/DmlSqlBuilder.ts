/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { Sql, join, raw } from "../../utils/sqlTag";
import { EntityManagerInternals } from "../EntityManagerInternals";
import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";

/**
 * What an `INSERT` does when a row conflicts, as {@link DmlSqlBuilder} sees
 * it — the assignments arrive already rendered by the query builder.
 */
export type InsertConflictAction =
  | { kind: "none" }
  | { kind: "nothing" }
  | { kind: "update"; set: Sql[]; where?: Sql };

/**
 * Builds dialect-specific DML SQL fragments (UPDATE / UPSERT / INSERT IGNORE)
 * shared by the write path. Pure SQL composition — holds no state beyond the
 * dialect/identifier helpers it reads from {@link EntityManagerInternals}.
 *
 * Extracted from EntityManager so the write executors and EntityManager itself
 * share one source of truth for dialect branching.
 *
 * @internal Package-internal — not a public API.
 */
export class DmlSqlBuilder {
  constructor(private readonly ctx: EntityManagerInternals) {}

  /** ORDER BY fragment for UPDATE statements (property names → DB columns). */
  buildUpdateOrderBy(
    orderBy: { [k: string]: "ASC" | "DESC" } | undefined,
    propertyToColumn: Map<string, string>,
  ): Sql | undefined {
    if (!orderBy) return undefined;
    const entries = Object.entries(orderBy);
    if (entries.length === 0) return undefined;

    const items: Sql[] = [];
    for (const [prop, dir] of entries) {
      const dbCol = propertyToColumn.get(prop) ?? prop;
      const direction =
        typeof dir === "string" && dir.toUpperCase() === "DESC"
          ? "DESC"
          : "ASC";
      items.push(sql`${raw(this.ctx.wrap(dbCol))} ${raw(direction)}`);
    }
    return sql`ORDER BY ${join(items, ", ")}`;
  }

  /**
   * Builds the final UPDATE SQL, dialect-aware:
   *
   * - MySQL/MariaDB: native `UPDATE … SET … WHERE … [ORDER BY …] [LIMIT n]`.
   * - PostgreSQL / SQLite: when `orderBy` or `limit` is set, rewrites to
   *   `UPDATE t SET … WHERE pk IN (SELECT pk FROM t WHERE … [ORDER BY …] [LIMIT n])`,
   *   because those dialects don't accept ORDER BY / LIMIT directly on UPDATE.
   *   Composite-PK entities can't take that path and throw an
   *   `UNSUPPORTED_OPERATION` error; the caller can fall back to a custom
   *   subquery via `createUpdateBuilder` (or stay on MySQL).
   */
  buildUpdateSql(
    metadata: any,
    entityName: string,
    setMap: Sql[],
    whereMap: Sql[],
    orderBySql: Sql | undefined,
    limit: number | undefined,
  ): Sql {
    const tableSql = raw(this.ctx.wrapTable(metadata.name));
    const setSql = join(setMap, ", ");
    const whereSql = join(whereMap, " AND ");
    const limitSql =
      limit !== undefined ? sql` LIMIT ${raw(String(limit))}` : sql``;
    const orderPart = orderBySql ? sql` ${orderBySql}` : sql``;

    if (this.ctx.isMySqlFamily()) {
      return sql`UPDATE ${tableSql} SET ${setSql} WHERE ${whereSql}${orderPart}${limitSql}`;
    }

    if (orderBySql === undefined && limit === undefined) {
      return sql`UPDATE ${tableSql} SET ${setSql} WHERE ${whereSql}`;
    }

    // PostgreSQL / SQLite — subquery rewrite via PK
    const pkColumns = metadata.columns.filter(
      (c: any) => c.options?.primary,
    );
    if (pkColumns.length === 0) {
      throw new OrmError(
        OrmErrorCode.PRIMARY_KEY_NOT_FOUND,
        `updateMany() with orderBy/limit requires a primary key on "${entityName}" (this dialect needs a subquery rewrite).`,
        `Add @PrimaryColumn / @PrimaryGeneratedColumn to "${entityName}" or run on MySQL/MariaDB.`,
      );
    }
    if (pkColumns.length > 1) {
      throw new OrmError(
        OrmErrorCode.UNSUPPORTED_OPERATION,
        `updateMany() with orderBy/limit on composite-PK entity "${entityName}" is not supported on PostgreSQL/SQLite.`,
        `Use createUpdateBuilder() with a manually scoped subquery, or run the update on MySQL/MariaDB which supports UPDATE … ORDER BY … LIMIT natively.`,
      );
    }
    const pkWrapped = raw(this.ctx.wrap(pkColumns[0].name));
    const subquery = sql`SELECT ${pkWrapped} FROM ${tableSql} WHERE ${whereSql}${orderPart}${limitSql}`;
    return sql`UPDATE ${tableSql} SET ${setSql} WHERE ${pkWrapped} IN (${subquery})`;
  }

  /** Dialect-specific INSERT IGNORE / ON CONFLICT DO NOTHING for a single row. */
  buildInsertIgnoreQuery(
    tableName: string,
    columns: string[],
    values: any[],
    conflictColumns: string[],
  ): Sql {
    const columnList = join(
      columns.map((c) => raw(c)),
      ", ",
    );
    const valueList = join(values, ", ");

    if (this.ctx.isMySqlFamily()) {
      return sql`INSERT IGNORE INTO ${raw(tableName)} (${columnList}) VALUES (${valueList})`;
    }

    const conflictList = join(
      conflictColumns.map((c) => raw(c)),
      ", ",
    );
    if (this.ctx.isPostgres()) {
      return sql`INSERT INTO ${raw(tableName)} (${columnList}) VALUES (${valueList}) ON CONFLICT (${conflictList}) DO NOTHING`;
    }

    if (this.ctx.isSqlite()) {
      return sql`INSERT INTO ${raw(tableName)} (${columnList}) VALUES (${valueList}) ON CONFLICT (${conflictList}) DO NOTHING`;
    }

    throw new OrmError(
      OrmErrorCode.UNSUPPORTED_DATABASE,
      `Unsupported database type for insertIgnore: ${this.ctx.getDbType()}`,
    );
  }

  /** Dialect-specific UPSERT (ON DUPLICATE KEY / ON CONFLICT DO UPDATE) for a single row. */
  buildUpsertQuery(
    tableName: string,
    columns: string[],
    values: any[],
    conflictColumns: string[],
    updateColumns: string[],
  ): Sql {
    const columnList = join(
      columns.map((c) => raw(c)),
      ", ",
    );
    const valueList = join(values, ", ");

    if (this.ctx.isMySqlFamily()) {
      const updateSet = join(
        updateColumns.map((col) => raw(`${col} = VALUES(${col})`)),
        ", ",
      );
      return sql`INSERT INTO ${raw(tableName)} (${columnList}) VALUES (${valueList}) ON DUPLICATE KEY UPDATE ${updateSet}`;
    }

    const conflictList = join(
      conflictColumns.map((c) => raw(c)),
      ", ",
    );

    if (this.ctx.isPostgres()) {
      const updateSet = join(
        updateColumns.map((col) => raw(`${col} = EXCLUDED.${col}`)),
        ", ",
      );
      return sql`INSERT INTO ${raw(tableName)} (${columnList}) VALUES (${valueList}) ON CONFLICT (${conflictList}) DO UPDATE SET ${updateSet}`;
    }

    // SQLite
    if (this.ctx.isSqlite()) {
      const updateSet = join(
        updateColumns.map((col) => raw(`${col} = excluded.${col}`)),
        ", ",
      );
      return sql`INSERT INTO ${raw(tableName)} (${columnList}) VALUES (${valueList}) ON CONFLICT (${conflictList}) DO UPDATE SET ${updateSet}`;
    }

    throw new OrmError(
      OrmErrorCode.UNSUPPORTED_DATABASE,
      `Unsupported database type for upsert: ${this.ctx.getDbType()}`,
    );
  }

  /** Multi-row variant of {@link buildUpsertQuery}. */
  buildBatchUpsertQuery(
    tableName: string,
    columns: string[],
    valueRows: Sql[],
    conflictColumns: string[],
    updateColumns: string[],
  ): Sql {
    const columnList = join(
      columns.map((c) => raw(c)),
      ", ",
    );
    const valuesList = join(valueRows, ", ");

    if (this.ctx.isMySqlFamily()) {
      const updateSet = join(
        updateColumns.map((col) => raw(`${col} = VALUES(${col})`)),
        ", ",
      );
      return sql`INSERT INTO ${raw(tableName)} (${columnList}) VALUES ${valuesList} ON DUPLICATE KEY UPDATE ${updateSet}`;
    }

    const conflictList = join(
      conflictColumns.map((c) => raw(c)),
      ", ",
    );

    if (this.ctx.isPostgres()) {
      const updateSet = join(
        updateColumns.map((col) => raw(`${col} = EXCLUDED.${col}`)),
        ", ",
      );
      return sql`INSERT INTO ${raw(tableName)} (${columnList}) VALUES ${valuesList} ON CONFLICT (${conflictList}) DO UPDATE SET ${updateSet}`;
    }

    // SQLite
    if (this.ctx.isSqlite()) {
      const updateSet = join(
        updateColumns.map((col) => raw(`${col} = excluded.${col}`)),
        ", ",
      );
      return sql`INSERT INTO ${raw(tableName)} (${columnList}) VALUES ${valuesList} ON CONFLICT (${conflictList}) DO UPDATE SET ${updateSet}`;
    }

    throw new OrmError(
      OrmErrorCode.UNSUPPORTED_DATABASE,
      `Unsupported database type for upsert: ${this.ctx.getDbType()}`,
    );
  }

  /**
   * The dialect's spelling of a column on the row an INSERT proposed —
   * what `qExcluded()` references resolve to.
   *
   * PostgreSQL and SQLite expose a pseudo-table; MySQL/MariaDB exposes the
   * `VALUES()` function instead. `VALUES()` is deprecated as of MySQL 8.0.20
   * in favour of a row alias (`INSERT … AS new`), but it is the only form
   * MariaDB accepts and the one every other upsert path here already emits,
   * so it stays until version detection can pick between them.
   *
   * @param wrappedColumn - The column identifier, already escaped.
   */
  renderExcludedColumn(wrappedColumn: string): string {
    if (this.ctx.isMySqlFamily()) {
      return `VALUES(${wrappedColumn})`;
    }
    if (this.ctx.isPostgres()) {
      return `EXCLUDED.${wrappedColumn}`;
    }
    if (this.ctx.isSqlite()) {
      return `excluded.${wrappedColumn}`;
    }
    throw new OrmError(
      OrmErrorCode.UNSUPPORTED_DATABASE,
      `Unsupported database type for an ON CONFLICT excluded reference: ${this.ctx.getDbType()}`,
    );
  }

  /**
   * Builds `INSERT … VALUES … ON CONFLICT …` for the INSERT query builder.
   *
   * Unlike {@link buildUpsertQuery}, the DO UPDATE assignments arrive
   * already rendered, so the conflict action can be any expression rather
   * than a fixed overwrite of the proposed values.
   *
   * MySQL/MariaDB has no conflict target and no DO UPDATE predicate, so the
   * clauses it cannot express are rejected here rather than silently dropped —
   * a `DO UPDATE … WHERE` that quietly loses its predicate would update rows
   * the caller excluded.
   */
  buildInsertOnConflictSql(opts: {
    tableName: string;
    columns: Sql[];
    valueRows: Sql[];
    conflictColumns: string[];
    constraintName?: string;
    indexPredicate?: Sql;
    action: InsertConflictAction;
  }): Sql {
    const { tableName, columns, valueRows, action } = opts;
    const head = sql`INSERT INTO ${raw(tableName)} (${join(columns, ", ")}) VALUES ${join(valueRows, ", ")}`;

    if (action.kind === "none") {
      return head;
    }

    if (this.ctx.isMySqlFamily()) {
      return this.buildMySqlConflictTail(head, { ...opts, action });
    }

    if (!this.ctx.isPostgres() && !this.ctx.isSqlite()) {
      throw new OrmError(
        OrmErrorCode.UNSUPPORTED_DATABASE,
        `Unsupported database type for ON CONFLICT: ${this.ctx.getDbType()}`,
      );
    }

    const target = this.buildConflictTarget(opts);

    if (action.kind === "nothing") {
      return sql`${head} ON CONFLICT${target} DO NOTHING`;
    }

    const setSql = join(action.set, ", ");
    const filter = action.where ? sql` WHERE ${action.where}` : sql``;
    return sql`${head} ON CONFLICT${target} DO UPDATE SET ${setSql}${filter}`;
  }

  /**
   * The `(cols) [WHERE pred]` / `ON CONSTRAINT name` fragment that names
   * which index arbitrates the conflict, or an empty fragment when the
   * caller left the target implicit.
   */
  private buildConflictTarget(opts: {
    conflictColumns: string[];
    constraintName?: string;
    indexPredicate?: Sql;
  }): Sql {
    if (opts.constraintName) {
      if (!this.ctx.isPostgres()) {
        throw new OrmError(
          OrmErrorCode.UNSUPPORTED_OPERATION,
          `ON CONFLICT ON CONSTRAINT is PostgreSQL-only and ${this.ctx.getDbType()} does not support it. Name the conflicting columns with .onConflict([...]) instead.`,
        );
      }
      return sql` ON CONSTRAINT ${raw(this.ctx.wrap(opts.constraintName))}`;
    }
    if (opts.conflictColumns.length === 0) {
      return sql``;
    }
    const list = join(
      opts.conflictColumns.map((c) => raw(c)),
      ", ",
    );
    const predicate = opts.indexPredicate
      ? sql` WHERE ${opts.indexPredicate}`
      : sql``;
    return sql` (${list})${predicate}`;
  }

  /**
   * MySQL/MariaDB tail: `ON DUPLICATE KEY UPDATE …`, or `INSERT IGNORE` for
   * the DO NOTHING case (rewriting the head, since the keyword sits before
   * the table).
   */
  private buildMySqlConflictTail(
    head: Sql,
    opts: {
      tableName: string;
      columns: Sql[];
      valueRows: Sql[];
      constraintName?: string;
      indexPredicate?: Sql;
      action: Exclude<InsertConflictAction, { kind: "none" }>;
    },
  ): Sql {
    const { action } = opts;
    if (opts.constraintName) {
      throw new OrmError(
        OrmErrorCode.UNSUPPORTED_OPERATION,
        "ON CONFLICT ON CONSTRAINT is PostgreSQL-only — MySQL/MariaDB arbitrates on every unique key at once. Use .onConflict([...]) (columns are accepted for portability but not emitted).",
      );
    }
    if (opts.indexPredicate) {
      throw new OrmError(
        OrmErrorCode.UNSUPPORTED_OPERATION,
        "A partial-index predicate on the conflict target has no MySQL/MariaDB equivalent — the engine has no conflict target at all. Drop the `where` option, or run this statement on PostgreSQL.",
      );
    }

    if (action.kind === "nothing") {
      // MySQL has no DO NOTHING; INSERT IGNORE is the equivalent. Note it
      // downgrades every error in the statement to a warning, not just the
      // duplicate-key one — the same tradeoff insertIgnore() already makes.
      return sql`INSERT IGNORE INTO ${raw(opts.tableName)} (${join(opts.columns, ", ")}) VALUES ${join(opts.valueRows, ", ")}`;
    }

    if (action.where) {
      throw new OrmError(
        OrmErrorCode.UNSUPPORTED_OPERATION,
        "ON DUPLICATE KEY UPDATE takes no WHERE clause, so .doUpdateWhere() cannot run on MySQL/MariaDB. Fold the condition into the assigned value with a CASE expression, or run the statement on PostgreSQL/SQLite.",
      );
    }

    return sql`${head} ON DUPLICATE KEY UPDATE ${join(action.set, ", ")}`;
  }

  /** INSERT IGNORE / ON CONFLICT DO NOTHING for an M2M join-table row. */
  buildInsertIgnoreJoinTableSql(
    tableName: string,
    ownerCol: string,
    relatedCol: string,
    ownerId: unknown,
    relatedId: unknown,
  ): Sql {
    if (this.ctx.isMySqlFamily()) {
      return sql`INSERT IGNORE INTO ${raw(tableName)} (${raw(ownerCol)}, ${raw(relatedCol)}) VALUES (${ownerId as any}, ${relatedId as any})`;
    }
    // PostgreSQL + SQLite both support ON CONFLICT DO NOTHING.
    return sql`INSERT INTO ${raw(tableName)} (${raw(ownerCol)}, ${raw(relatedCol)}) VALUES (${ownerId as any}, ${relatedId as any}) ON CONFLICT DO NOTHING`;
  }
}
