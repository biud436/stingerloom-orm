/**
 * Version-aware dialect capability system.
 *
 * Architecture:
 * - CommonCapabilities: flags that vary by version across multiple dialects
 * - MySqlCapabilities, PostgresCapabilities, SqliteCapabilities: dialect-specific extensions
 * - FeatureRule + FeatureTable: declarative version→capability mapping
 * - resolveFromTable(): generic resolver that reads a table and produces capabilities
 *
 * Adding a new feature = one line in the relevant feature table.
 */

// ─── Version gate ──────────────────────────────────────────────────

/** Minimum version where a feature becomes available. */
export interface VersionGate {
  readonly major: number;
  readonly minor?: number;
  readonly patch?: number;
}

/**
 * A feature rule:
 * - `VersionGate`: available from that version onward
 * - `true`: always available in this dialect
 * - `false`: never available in this dialect
 */
export type FeatureRule = VersionGate | boolean;

/**
 * Type-safe feature table. Keys must match the target capabilities interface.
 * Each entry maps a capability flag to its version requirement.
 */
export type FeatureTable<T> = { readonly [K in keyof T]: FeatureRule };

// ─── Capability interfaces (hierarchical) ──────────────────────────

/** Capabilities shared across multiple dialects. */
export interface CommonCapabilities {
  readonly supportsReturning: boolean;
  readonly supportsDropColumn: boolean;
  readonly supportsUpsert: boolean;
  readonly supportsRenameColumn: boolean;
  readonly supportsGeneratedColumns: boolean;
}

/** MySQL / MariaDB specific capabilities. */
export interface MySqlCapabilities extends CommonCapabilities {
  /** CHECK constraints enforced (MySQL 8.0.16+, MariaDB 10.2.1+). */
  readonly supportsCheckConstraints: boolean;
  /** DEFAULT with expressions (MySQL 8.0.13+). */
  readonly supportsDefaultExpression: boolean;
  /** Native JSON column type (MySQL 5.7.8+, MariaDB 10.2.7+). */
  readonly supportsJsonColumnType: boolean;
  /** Invisible columns (MySQL 8.0.23+, MariaDB 10.3.3+). */
  readonly supportsInvisibleColumns: boolean;
  /** INSERT ... RETURNING clause. MariaDB 10.5+ only — MySQL does not support it. */
  readonly supportsInsertReturning: boolean;
  /** CREATE SEQUENCE / sequence objects. MariaDB 10.3+ only. */
  readonly supportsSequence: boolean;
  /** Native UUID column type. MariaDB 10.7+ only. */
  readonly supportsNativeUuidType: boolean;
  /** System-versioned (temporal) tables. MariaDB 10.3+ only. */
  readonly supportsSystemVersioning: boolean;
}

/** PostgreSQL specific capabilities. */
export interface PostgresCapabilities extends CommonCapabilities {
  /** GENERATED ALWAYS AS IDENTITY (PG 10+). Fallback: SERIAL. */
  readonly supportsGeneratedIdentity: boolean;
  /** gen_random_uuid() without pgcrypto (PG 13+). */
  readonly supportsNativeGenRandomUuid: boolean;
  /** ALTER TYPE ... RENAME VALUE (PG 10+). */
  readonly supportsRenameEnumValue: boolean;
  /** ALTER TABLE ADD COLUMN IF NOT EXISTS (PG 9.6+). */
  readonly supportsIfNotExistsAddColumn: boolean;
  /** CREATE INDEX ... INCLUDE (PG 11+). */
  readonly supportsIndexInclude: boolean;
}

/** SQLite specific capabilities. */
export interface SqliteCapabilities extends CommonCapabilities {
  /** GENERATED ALWAYS AS (SQLite 3.31.0+). */
  readonly supportsSqliteGeneratedColumns: boolean;
  /** ALTER TABLE RENAME COLUMN (SQLite 3.25.0+). */
  readonly supportsSqliteRenameColumn: boolean;
}

/** Union of all dialect capabilities. */
export type DialectCapabilities =
  | MySqlCapabilities
  | PostgresCapabilities
  | SqliteCapabilities;

// ─── Default "all on" constants (per dialect) ──────────────────────

export const ALL_COMMON: Readonly<CommonCapabilities> = Object.freeze({
  supportsReturning: true,
  supportsDropColumn: true,
  supportsUpsert: true,
  supportsRenameColumn: true,
  supportsGeneratedColumns: true,
});

export const ALL_MYSQL: Readonly<MySqlCapabilities> = Object.freeze({
  ...ALL_COMMON,
  supportsCheckConstraints: true,
  supportsDefaultExpression: true,
  supportsJsonColumnType: true,
  supportsInvisibleColumns: true,
  // MariaDB-only features: kept false in the "MySQL best-case" default so that
  // DDL produced without version detection is MySQL-safe. MariaDB users get the
  // real flags via `resolveMySqlCapabilities(version, isMariaDb=true)`.
  supportsInsertReturning: false,
  supportsSequence: false,
  supportsNativeUuidType: false,
  supportsSystemVersioning: false,
});

export const ALL_POSTGRES: Readonly<PostgresCapabilities> = Object.freeze({
  ...ALL_COMMON,
  supportsGeneratedIdentity: true,
  supportsNativeGenRandomUuid: true,
  supportsRenameEnumValue: true,
  supportsIfNotExistsAddColumn: true,
  supportsIndexInclude: true,
});

export const ALL_SQLITE: Readonly<SqliteCapabilities> = Object.freeze({
  ...ALL_COMMON,
  supportsSqliteGeneratedColumns: true,
  supportsSqliteRenameColumn: true,
});

// ─── Generic resolver ──────────────────────────────────────────────

import { DbVersion } from "./DbVersion";

/**
 * Resolves a feature table into concrete boolean capabilities
 * by comparing each rule against the detected database version.
 *
 * - `true` → always on
 * - `false` → always off
 * - `{ major, minor, patch? }` → on if version >= gate
 */
export function resolveFromTable<T extends CommonCapabilities>(
  version: DbVersion,
  table: FeatureTable<T>,
): Readonly<T> {
  const result: Record<string, boolean> = {};
  for (const [key, rule] of Object.entries(table)) {
    if (typeof rule === "boolean") {
      result[key] = rule;
    } else {
      const gate = rule as VersionGate;
      result[key] = version.gte(gate.major, gate.minor ?? 0, gate.patch ?? 0);
    }
  }
  return Object.freeze(result) as unknown as T;
}
