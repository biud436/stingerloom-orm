/**
 * Feature-flag interface describing which DDL features the connected
 * database version supports.
 *
 * Each flag maps to a specific version requirement. When a flag is false,
 * the ORM either uses a fallback SQL syntax or throws an UnsupportedFeatureError.
 */
export interface DialectCapabilities {
  // ── MySQL / MariaDB ──────────────────────────────────────────────
  /** CHECK constraints enforced (MySQL 8.0.16+, MariaDB 10.2.1+). */
  readonly supportsCheckConstraints: boolean;
  /** DEFAULT with expressions like (CURRENT_TIMESTAMP) (MySQL 8.0.13+). */
  readonly supportsDefaultExpression: boolean;
  /** GENERATED ALWAYS AS (expr) columns (MySQL 5.7.6+, MariaDB 5.2+). */
  readonly supportsGeneratedColumns: boolean;
  /** Native JSON column type (MySQL 5.7.8+, MariaDB 10.2.7+). */
  readonly supportsJsonColumnType: boolean;
  /** ALTER TABLE RENAME COLUMN (MySQL 8.0+, MariaDB 10.5.2+). */
  readonly supportsRenameColumn: boolean;
  /** Invisible columns (MySQL 8.0.23+, MariaDB 10.3.3+). */
  readonly supportsInvisibleColumns: boolean;

  // ── PostgreSQL ───────────────────────────────────────────────────
  /** GENERATED ALWAYS AS IDENTITY (PG 10+). Fallback: SERIAL. */
  readonly supportsGeneratedIdentity: boolean;
  /** gen_random_uuid() without pgcrypto (PG 13+). Fallback: uuid_generate_v4(). */
  readonly supportsNativeGenRandomUuid: boolean;
  /** ALTER TYPE ... RENAME VALUE (PG 10+). */
  readonly supportsRenameEnumValue: boolean;
  /** ALTER TABLE ADD COLUMN IF NOT EXISTS (PG 9.6+). */
  readonly supportsIfNotExistsAddColumn: boolean;
  /** CREATE INDEX ... INCLUDE (PG 11+). */
  readonly supportsIndexInclude: boolean;

  // ── SQLite ───────────────────────────────────────────────────────
  /** ALTER TABLE DROP COLUMN (SQLite 3.35.0+). */
  readonly supportsDropColumn: boolean;
  /** INSERT ... ON CONFLICT (SQLite 3.24.0+). */
  readonly supportsUpsert: boolean;
  /** GENERATED ALWAYS AS (SQLite 3.31.0+). */
  readonly supportsSqliteGeneratedColumns: boolean;
  /** ALTER TABLE RENAME COLUMN (SQLite 3.25.0+). */
  readonly supportsSqliteRenameColumn: boolean;

  // ── Cross-dialect ────────────────────────────────────────────────
  /** INSERT/UPDATE ... RETURNING clause (PostgreSQL, SQLite 3.35+). */
  readonly supportsReturning: boolean;
}

/**
 * Default capabilities with all features enabled.
 * Used when the database version is unknown or not yet detected,
 * preserving backward compatibility with existing behavior.
 */
export const ALL_CAPABILITIES: Readonly<DialectCapabilities> = Object.freeze({
  supportsCheckConstraints: true,
  supportsDefaultExpression: true,
  supportsGeneratedColumns: true,
  supportsJsonColumnType: true,
  supportsRenameColumn: true,
  supportsInvisibleColumns: true,

  supportsGeneratedIdentity: true,
  supportsNativeGenRandomUuid: true,
  supportsRenameEnumValue: true,
  supportsIfNotExistsAddColumn: true,
  supportsIndexInclude: true,

  supportsDropColumn: true,
  supportsUpsert: true,
  supportsSqliteGeneratedColumns: true,
  supportsSqliteRenameColumn: true,

  supportsReturning: true,
});
