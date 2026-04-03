import { DbVersion } from "./DbVersion";
import {
  FeatureTable,
  MySqlCapabilities,
  PostgresCapabilities,
  SqliteCapabilities,
  resolveFromTable,
} from "./DialectCapabilities";

// ─── MySQL ─────────────────────────────────────────────────────────
// Docs: https://dev.mysql.com/doc/relnotes/mysql/8.0/en/

const MYSQL_FEATURES: FeatureTable<MySqlCapabilities> = {
  // MySQL-specific
  supportsCheckConstraints:  { major: 8, minor: 0, patch: 16 },
  supportsDefaultExpression: { major: 8, minor: 0, patch: 13 },
  supportsJsonColumnType:    { major: 5, minor: 7, patch: 8 },
  supportsInvisibleColumns:  { major: 8, minor: 0, patch: 23 },
  // Common
  supportsGeneratedColumns:  { major: 5, minor: 7, patch: 6 },
  supportsRenameColumn:      { major: 8, minor: 0 },
  supportsReturning:         false,
  supportsDropColumn:        true,
  supportsUpsert:            true,
};

// ─── MariaDB ───────────────────────────────────────────────────────
// Docs: https://mariadb.com/kb/en/release-notes/

const MARIADB_FEATURES: FeatureTable<MySqlCapabilities> = {
  // MariaDB-specific version gates (differ from MySQL)
  supportsCheckConstraints:  { major: 10, minor: 2, patch: 1 },
  supportsDefaultExpression: { major: 10, minor: 2, patch: 1 },
  supportsJsonColumnType:    { major: 10, minor: 2, patch: 7 },
  supportsInvisibleColumns:  { major: 10, minor: 3, patch: 3 },
  // Common
  supportsGeneratedColumns:  { major: 5, minor: 2 },
  supportsRenameColumn:      { major: 10, minor: 5, patch: 2 },
  supportsReturning:         { major: 10, minor: 5 },
  supportsDropColumn:        true,
  supportsUpsert:            true,
};

// ─── PostgreSQL ────────────────────────────────────────────────────
// Docs: https://www.postgresql.org/docs/release/

const POSTGRES_FEATURES: FeatureTable<PostgresCapabilities> = {
  // PostgreSQL-specific
  supportsGeneratedIdentity:     { major: 10 },
  supportsNativeGenRandomUuid:   { major: 13 },
  supportsRenameEnumValue:       { major: 10 },
  supportsIfNotExistsAddColumn:  { major: 9, minor: 6 },
  supportsIndexInclude:          { major: 11 },
  // Common
  supportsGeneratedColumns:      { major: 12 },
  supportsRenameColumn:          true,
  supportsReturning:             true,
  supportsDropColumn:            true,
  supportsUpsert:                true,
};

// ─── SQLite ────────────────────────────────────────────────────────
// Docs: https://www.sqlite.org/changes.html

const SQLITE_FEATURES: FeatureTable<SqliteCapabilities> = {
  // SQLite-specific
  supportsSqliteGeneratedColumns: { major: 3, minor: 31 },
  supportsSqliteRenameColumn:     { major: 3, minor: 25 },
  // Common
  supportsGeneratedColumns:       false,
  supportsRenameColumn:           { major: 3, minor: 25 },
  supportsReturning:              { major: 3, minor: 35 },
  supportsDropColumn:             { major: 3, minor: 35 },
  supportsUpsert:                 { major: 3, minor: 24 },
};

// ─── Public resolvers ──────────────────────────────────────────────

export function resolveMySqlCapabilities(
  v: DbVersion,
  isMariaDb: boolean,
): MySqlCapabilities {
  return resolveFromTable(v, isMariaDb ? MARIADB_FEATURES : MYSQL_FEATURES);
}

export function resolvePostgresCapabilities(v: DbVersion): PostgresCapabilities {
  return resolveFromTable(v, POSTGRES_FEATURES);
}

export function resolveSqliteCapabilities(v: DbVersion): SqliteCapabilities {
  return resolveFromTable(v, SQLITE_FEATURES);
}
