import { LockMode } from "../dialects/FindOption";

/** Which spelling of the row-lock clauses a connection takes. */
export type LockDialect = "postgres" | "mysql" | "mariadb" | "sqlite";

/**
 * The row-lock clause appended to a SELECT for `mode`.
 *
 * Shared locks with a waiting option are where the dialects part. PostgreSQL
 * and MySQL 8 put NOWAIT / SKIP LOCKED on `FOR SHARE` — MySQL's
 * `LOCK IN SHARE MODE` takes neither, and rejects them as a syntax error —
 * while MariaDB has no `FOR SHARE` and puts them on `LOCK IN SHARE MODE`.
 * A plain shared lock stays `LOCK IN SHARE MODE` on both MySQL servers,
 * which every version of either accepts.
 *
 * @internal Package-internal — not a public API.
 */
export function lockClause(mode: LockMode, dialect: LockDialect): string {
  const mysqlFamily = dialect === "mysql" || dialect === "mariadb";
  switch (mode) {
    case LockMode.PESSIMISTIC_READ:
      return mysqlFamily ? "LOCK IN SHARE MODE" : "FOR SHARE";
    case LockMode.PESSIMISTIC_READ_NOWAIT:
      return dialect === "mariadb" ? "LOCK IN SHARE MODE NOWAIT" : "FOR SHARE NOWAIT";
    case LockMode.PESSIMISTIC_READ_SKIP_LOCKED:
      return dialect === "mariadb"
        ? "LOCK IN SHARE MODE SKIP LOCKED"
        : "FOR SHARE SKIP LOCKED";
    case LockMode.PESSIMISTIC_WRITE_NOWAIT:
      return "FOR UPDATE NOWAIT";
    case LockMode.PESSIMISTIC_WRITE_SKIP_LOCKED:
      return "FOR UPDATE SKIP LOCKED";
    case LockMode.PESSIMISTIC_WRITE:
    default:
      return "FOR UPDATE";
  }
}

/**
 * The lock dialect of a connection. MariaDB is told apart from MySQL by the
 * declared `type: "mariadb"` or, for `type: "mysql"`, by the server version
 * the driver detected at connect time.
 *
 * @internal Package-internal — not a public API.
 */
export function lockDialectOf(ctx: {
  isMySqlFamily(): boolean;
  isPostgres(): boolean;
  getDbType?(): string | undefined;
  getDriver?(): unknown;
}): LockDialect {
  if (ctx.isPostgres()) return "postgres";
  if (!ctx.isMySqlFamily()) return "sqlite";
  if (ctx.getDbType?.() === "mariadb") return "mariadb";
  const driver = ctx.getDriver?.() as { isMariaDb?: () => boolean } | undefined;
  return driver?.isMariaDb?.() ? "mariadb" : "mysql";
}
