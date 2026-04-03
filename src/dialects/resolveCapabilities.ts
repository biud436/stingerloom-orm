import { DbVersion } from "./DbVersion";
import { DialectCapabilities } from "./DialectCapabilities";

/**
 * Resolves MySQL or MariaDB capabilities from a detected version.
 *
 * MariaDB has its own version timeline — for example CHECK constraints
 * were enforced in MariaDB 10.2.1, but only in MySQL 8.0.16.
 */
export function resolveMySqlCapabilities(
  v: DbVersion,
  isMariaDb: boolean,
): DialectCapabilities {
  if (isMariaDb) {
    return Object.freeze({
      supportsCheckConstraints: v.gte(10, 2, 1),
      supportsDefaultExpression: v.gte(10, 2, 1),
      supportsGeneratedColumns: v.gte(5, 2, 0),
      supportsJsonColumnType: v.gte(10, 2, 7),
      supportsRenameColumn: v.gte(10, 5, 2),
      supportsInvisibleColumns: v.gte(10, 3, 3),

      // PostgreSQL-only flags — always false for MySQL/MariaDB
      supportsGeneratedIdentity: false,
      supportsNativeGenRandomUuid: false,
      supportsRenameEnumValue: false,
      supportsIfNotExistsAddColumn: false,
      supportsIndexInclude: false,

      // SQLite-only flags
      supportsDropColumn: true, // MariaDB supports DROP COLUMN
      supportsUpsert: true, // ON DUPLICATE KEY
      supportsSqliteGeneratedColumns: false,
      supportsSqliteRenameColumn: false,

      supportsReturning: v.gte(10, 5, 0),
    });
  }

  // MySQL
  return Object.freeze({
    supportsCheckConstraints: v.gte(8, 0, 16),
    supportsDefaultExpression: v.gte(8, 0, 13),
    supportsGeneratedColumns: v.gte(5, 7, 6),
    supportsJsonColumnType: v.gte(5, 7, 8),
    supportsRenameColumn: v.gte(8, 0, 0),
    supportsInvisibleColumns: v.gte(8, 0, 23),

    supportsGeneratedIdentity: false,
    supportsNativeGenRandomUuid: false,
    supportsRenameEnumValue: false,
    supportsIfNotExistsAddColumn: false,
    supportsIndexInclude: false,

    supportsDropColumn: true,
    supportsUpsert: true,
    supportsSqliteGeneratedColumns: false,
    supportsSqliteRenameColumn: false,

    supportsReturning: false,
  });
}

/**
 * Resolves PostgreSQL capabilities from a detected version.
 */
export function resolvePostgresCapabilities(
  v: DbVersion,
): DialectCapabilities {
  return Object.freeze({
    // MySQL-only flags — always true/false as appropriate
    supportsCheckConstraints: true, // PG always supports CHECK
    supportsDefaultExpression: true, // PG always supports DEFAULT expressions
    supportsGeneratedColumns: v.gte(12, 0), // PG 12+ for stored generated columns
    supportsJsonColumnType: true, // PG has json/jsonb since 9.2/9.4
    supportsRenameColumn: true, // PG always supports RENAME COLUMN
    supportsInvisibleColumns: false, // PG does not support invisible columns

    supportsGeneratedIdentity: v.gte(10, 0),
    supportsNativeGenRandomUuid: v.gte(13, 0),
    supportsRenameEnumValue: v.gte(10, 0),
    supportsIfNotExistsAddColumn: v.gte(9, 6),
    supportsIndexInclude: v.gte(11, 0),

    supportsDropColumn: true, // PG always supports DROP COLUMN
    supportsUpsert: true, // PG has ON CONFLICT since 9.5
    supportsSqliteGeneratedColumns: false,
    supportsSqliteRenameColumn: false,

    supportsReturning: true, // PG always supports RETURNING
  });
}

/**
 * Resolves SQLite capabilities from a detected version.
 */
export function resolveSqliteCapabilities(
  v: DbVersion,
): DialectCapabilities {
  return Object.freeze({
    supportsCheckConstraints: true, // SQLite always supports CHECK
    supportsDefaultExpression: true, // SQLite always supports DEFAULT expressions
    supportsGeneratedColumns: false, // N/A for MySQL sense
    supportsJsonColumnType: v.gte(3, 9, 0), // json1 built-in since 3.38, extension before
    supportsRenameColumn: v.gte(3, 25, 0),
    supportsInvisibleColumns: false,

    supportsGeneratedIdentity: false,
    supportsNativeGenRandomUuid: false,
    supportsRenameEnumValue: false,
    supportsIfNotExistsAddColumn: false,
    supportsIndexInclude: false,

    supportsDropColumn: v.gte(3, 35, 0),
    supportsUpsert: v.gte(3, 24, 0),
    supportsSqliteGeneratedColumns: v.gte(3, 31, 0),
    supportsSqliteRenameColumn: v.gte(3, 25, 0),

    supportsReturning: v.gte(3, 35, 0),
  });
}
