/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { Sql, join, raw } from "sql-template-tag";
import { EntityManagerInternals } from "../EntityManagerInternals";
import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";

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
    const tableSql = raw(this.ctx.wrapTable(metadata.name!));
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
    const pkWrapped = raw(this.ctx.wrap(pkColumns[0].name!));
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
