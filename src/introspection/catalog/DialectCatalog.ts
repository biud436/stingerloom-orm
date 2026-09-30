/* eslint-disable @typescript-eslint/no-explicit-any */
import type { CommonCapabilities } from "../../dialects/DialectCapabilities";
import type { CanonicalType, TableIR } from "../SchemaIR";
import type { IntrospectionDialect } from "../TypeMapper";

/**
 * Query function the catalog readers run their statements through. Accepts
 * plain SQL strings and sql-template-tag `Sql` objects.
 */
export interface CatalogQueryFn {
  (sql: string | import("sql-template-tag").Sql): Promise<any>;
}

/** How faithfully one type reproduces another on a given dialect. */
export type TypeFidelity =
  /** The same type. */
  | "exact"
  /** A different declaration the database stores identically. */
  | "equivalent"
  /** A different type. */
  | "different";

/**
 * A dialect's type system, as introspection needs it. Pure — no I/O — so the
 * lowering can use it to check a mapping without a connection.
 */
export interface DialectTypes {
  readonly dialect: IntrospectionDialect;

  /**
   * Parses a native type spelling into its {@link CanonicalType}. Must accept
   * both what the catalog prints and what this ORM's column definition
   * builder emits for the dialect — the same parser reads both sides of every
   * fidelity check.
   *
   * @param resolveNamedType - Resolves a user-defined type name (a PostgreSQL
   *   enum) that the spelling alone cannot identify.
   */
  parseType(
    nativeType: string,
    resolveNamedType?: (name: string) => CanonicalType | undefined,
  ): CanonicalType;

  /** How faithfully `created` reproduces the `declared` type. */
  compareTypes(declared: CanonicalType, created: CanonicalType): TypeFidelity;

  /**
   * Whether creating a foreign key makes the database create an index on its
   * columns by itself (InnoDB does; PostgreSQL and SQLite do not). Such an
   * index is the engine's, not the schema author's, and is not declared.
   */
  readonly foreignKeysCreateIndexes: boolean;
}

/** What a catalog reader learned about the server, beyond the tables. */
export interface CatalogServerInfo {
  /**
   * Capabilities of the connected server version, so fidelity checks render
   * DDL the way the ORM would on this server (MariaDB 10.7+ `UUID`, …).
   */
  capabilities?: CommonCapabilities;
}

/**
 * Reads one dialect's catalog into the {@link TableIR} form. The only place
 * that knows how that database describes itself.
 */
export interface CatalogReader {
  readonly types: DialectTypes;
  /** User tables (no views, no engine-internal tables), sorted by name. */
  listTables(): Promise<string[]>;
  readTable(name: string): Promise<TableIR>;
  readServerInfo(): Promise<CatalogServerInfo>;
}

/**
 * Driver results come back as a bare array (mysql2, better-sqlite3) or wrapped
 * (`{ rows }` from pg, `{ results }` from some connectors).
 */
export function normalizeRows(result: any): any[] {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.results)) return result.results;
  if (Array.isArray(result.rows)) return result.rows;
  return [];
}

/**
 * Reads a field from a catalog row whatever case the server returned its name
 * in (`COLUMN_NAME` from MySQL's `SELECT *`, `column_name` from an alias).
 */
export function field(row: any, name: string): any {
  if (row == null) return undefined;
  if (name in row) return row[name];
  const lower = name.toLowerCase();
  if (lower in row) return row[lower];
  const upper = name.toUpperCase();
  if (upper in row) return row[upper];
  return undefined;
}

/** A catalog value as a string, or `null` for SQL NULL. */
export function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return String(value);
}

/** A catalog value as a number, or `null` when absent or not numeric. */
export function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A catalog boolean in any of the spellings drivers return. */
export function bool(value: unknown): boolean {
  return (
    value === true ||
    value === 1 ||
    value === "1" ||
    value === "t" ||
    value === "true" ||
    value === "YES"
  );
}
