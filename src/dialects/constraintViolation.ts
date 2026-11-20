import { OrmError } from "../errors/OrmError";
import {
  UniqueConstraintViolationDetail,
  UniqueConstraintViolationError,
} from "../errors/UniqueConstraintViolationError";
import {
  ForeignKeyViolationDetail,
  ForeignKeyViolationError,
} from "../errors/ForeignKeyViolationError";

/** The fields `pg`, `mysql2` and `better-sqlite3` put on a server error. */
interface DriverErrorFields {
  message: string;
  code?: unknown;
  errno?: unknown;
  sqlMessage?: unknown;
  constraint?: unknown;
  table?: unknown;
  detail?: unknown;
}

/** MySQL/MariaDB errnos for a duplicate key: ER_DUP_ENTRY, ER_DUP_ENTRY_WITH_KEY_NAME. */
const MYSQL_UNIQUE_ERRNOS = new Set([1062, 1586]);

/**
 * MySQL/MariaDB errnos for a broken foreign key: ER_ROW_IS_REFERENCED_2,
 * ER_NO_REFERENCED_ROW_2, and the detail-less ER_NO_REFERENCED_ROW /
 * ER_ROW_IS_REFERENCED of servers before 5.1.
 */
const MYSQL_FK_ERRNOS = new Set([1451, 1452, 1216, 1217]);

/**
 * The error to throw for `error`, a statement's failure as the driver
 * reported it: a {@link UniqueConstraintViolationError} or
 * {@link ForeignKeyViolationError} for a unique or foreign key violation,
 * with the driver's error as its `cause`, and `error` itself for anything
 * else. The three drivers' codes do not overlap, so one function serves all
 * of them.
 */
export function toConstraintViolation(error: unknown): unknown {
  if (!(error instanceof Error) || error instanceof OrmError) return error;
  const e = error as Error & DriverErrorFields;

  if (
    e.code === "23505" ||
    MYSQL_UNIQUE_ERRNOS.has(e.errno as number) ||
    e.code === "SQLITE_CONSTRAINT_UNIQUE" ||
    e.code === "SQLITE_CONSTRAINT_PRIMARYKEY"
  ) {
    return new UniqueConstraintViolationError(e.message, uniqueDetail(e), {
      cause: error,
    });
  }
  if (
    e.code === "23503" ||
    MYSQL_FK_ERRNOS.has(e.errno as number) ||
    e.code === "SQLITE_CONSTRAINT_FOREIGNKEY"
  ) {
    return new ForeignKeyViolationError(e.message, foreignKeyDetail(e), {
      cause: error,
    });
  }
  return error;
}

function uniqueDetail(e: DriverErrorFields): UniqueConstraintViolationDetail {
  if (e.code === "23505") {
    return {
      constraint: stringField(e.constraint),
      table: stringField(e.table),
      columns: pgKeyColumns(stringField(e.detail)),
    };
  }
  if (typeof e.errno === "number") return mysqlDuplicateKey(mysqlMessage(e));
  return sqliteUniqueTarget(e.message);
}

function foreignKeyDetail(e: DriverErrorFields): ForeignKeyViolationDetail {
  if (e.code === "23503") {
    return { constraint: stringField(e.constraint), table: stringField(e.table) };
  }
  if (typeof e.errno === "number") return mysqlForeignKey(mysqlMessage(e));
  // SQLite says only "FOREIGN KEY constraint failed".
  return {};
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function mysqlMessage(e: DriverErrorFields): string {
  return typeof e.sqlMessage === "string" ? e.sqlMessage : e.message;
}

/**
 * The columns of PostgreSQL's `Key (a, b)=(…) already exists.` detail. An
 * expression key comes back as the expression text; identifiers PostgreSQL
 * quoted are unquoted.
 */
function pgKeyColumns(detail: string | undefined): string[] | undefined {
  const prefix = "Key (";
  if (!detail?.startsWith(prefix)) return undefined;

  const columns: string[] = [];
  let current = "";
  let depth = 0;
  let quoted = false;
  for (let i = prefix.length; i < detail.length; i++) {
    const ch = detail[i];
    if (quoted) {
      current += ch;
      if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      current += ch;
    } else if (ch === "(") {
      depth++;
      current += ch;
    } else if (ch === ")") {
      if (depth === 0) {
        columns.push(unquotePgIdentifier(current.trim()));
        return columns;
      }
      depth--;
      current += ch;
    } else if (ch === "," && depth === 0) {
      columns.push(unquotePgIdentifier(current.trim()));
      current = "";
    } else {
      current += ch;
    }
  }
  return undefined;
}

function unquotePgIdentifier(text: string): string {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/""/g, '"');
  }
  return text;
}

/**
 * The key of `Duplicate entry '…' for key 'name'`. MySQL 8.0.19+ writes the
 * key as `table.name`; MariaDB and older MySQL write the bare name. The
 * duplicated value can itself contain `for key '`, so the last one counts.
 */
function mysqlDuplicateKey(message: string): UniqueConstraintViolationDetail {
  const marker = " for key '";
  const at = message.lastIndexOf(marker);
  if (at < 0 || !message.endsWith("'")) return {};
  const key = message.slice(at + marker.length, -1);
  if (key.length === 0) return {};
  const dot = key.indexOf(".");
  if (dot > 0 && dot < key.length - 1) {
    return { table: key.slice(0, dot), constraint: key.slice(dot + 1) };
  }
  return { constraint: key };
}

/**
 * The table and constraint of `… a foreign key constraint fails
 * (\`db\`.\`table\`, CONSTRAINT \`name\` FOREIGN KEY …)`.
 */
function mysqlForeignKey(message: string): ForeignKeyViolationDetail {
  const identifier = "`((?:[^`]|``)*)`";
  const match = new RegExp(
    `\\(${identifier}\\.${identifier}, CONSTRAINT ${identifier}`,
  ).exec(message);
  if (!match) return {};
  return { table: unquoteMySqlIdentifier(match[2]), constraint: unquoteMySqlIdentifier(match[3]) };
}

function unquoteMySqlIdentifier(text: string): string {
  return text.replace(/``/g, "`");
}

/**
 * The target of SQLite's `UNIQUE constraint failed: t.a, t.b`, or of
 * `UNIQUE constraint failed: index 'name'` for an index over expressions.
 */
function sqliteUniqueTarget(message: string): UniqueConstraintViolationDetail {
  const marker = "UNIQUE constraint failed: ";
  const at = message.indexOf(marker);
  if (at < 0) return {};
  const target = message.slice(at + marker.length);

  const index = /^index '(.*)'$/.exec(target);
  if (index) return { constraint: index[1] };

  let table: string | undefined;
  const columns: string[] = [];
  for (const part of target.split(", ")) {
    const dot = part.indexOf(".");
    if (dot <= 0) return {};
    table ??= part.slice(0, dot);
    columns.push(part.slice(dot + 1));
  }
  return { table, columns };
}
