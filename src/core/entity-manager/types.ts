/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../../utils";
import { AliasRef, SqlRef } from "../SqlRef";
import { TRANSACTION_ISOLATION_LEVEL } from "../../dialects/IsolationLevel";
import { TransactionPropagation } from "../../decorators/Transactional";

// ── refs() helper types ───────────────────────────────────

/**
 * Argument shape accepted by `em.refs(...)`.
 *
 * - `Entity`            — resolves to `em.ref(Entity)`        (`SqlRef<Entity>`)
 * - `[Entity, "alias"]` — resolves to `em.ref(Entity, alias)` (`SqlRef<Entity>`)
 * - `"alias"`           — resolves to `em.aliasRef("alias")`  (`AliasRef`)
 */
export type RefSpec<T = unknown> =
  | ClazzType<T>
  | readonly [ClazzType<T>, string]
  | string;

export type ResolveRef<S> = S extends string
  ? AliasRef
  : S extends readonly [ClazzType<infer U>, string]
    ? SqlRef<U>
    : S extends ClazzType<infer U>
      ? SqlRef<U>
      : never;

/** Tuple-typed return for `em.refs(...)` — preserves per-position types. */
export type RefTuple<T extends readonly RefSpec[]> = {
  -readonly [K in keyof T]: ResolveRef<T[K]>;
};

// ── Public Metadata View Types (#233) ────────────────────

export interface EntityMetadataView {
  tableName: string;
  columns: ColumnMetadataView[];
  relations: RelationMetadataView[];
  indexes: any[];
  deletedAtColumn: string | null;
  createTimestampColumn: string | null;
  updateTimestampColumn: string | null;
  versionColumn: string | null;
}

export interface ColumnMetadataView {
  propertyKey: string;
  columnName: string;
  type: string;
  nullable: boolean;
  primary: boolean;
  unique: boolean;
  default?: any;
  length?: number;
}

export interface RelationMetadataView {
  type: "ManyToOne" | "OneToMany" | "ManyToMany" | "OneToOne";
  propertyKey: string;
  target: ClazzType<any>;
  joinColumn: string | null;
  eager: boolean;
}

/**
 * Transaction options for `em.transaction()`.
 *
 * The first three control deadlock retry behavior. The latter three bring the
 * programmatic API to parity with the `@Transactional` decorator so the
 * decorator is never the *only* way to set them.
 */
export interface TransactionOptions {
  /** If true, automatically retry the transaction on deadlock. */
  retryOnDeadlock?: boolean;
  /** Maximum number of retries on deadlock (default: 3). */
  maxRetries?: number;
  /** Delay between retries in milliseconds (default: 100). */
  retryDelayMs?: number;
  /**
   * Transaction isolation level (default: driver default, "READ COMMITTED").
   * Decorator-free equivalent of `@Transactional("SERIALIZABLE")`.
   */
  isolationLevel?: TRANSACTION_ISOLATION_LEVEL;
  /**
   * Propagation strategy (default: REQUIRED). Decorator-free equivalent of
   * `@Transactional({ propagation })`.
   * - REQUIRED: join the active transaction if present, else start one.
   * - REQUIRES_NEW: always start a fresh, independent transaction.
   * - NESTED: create a savepoint inside the active transaction.
   */
  propagation?: TransactionPropagation;
  /**
   * Named connection to run the transaction on (multi-DB).
   * Decorator-free equivalent of `@Transactional({ connectionName })`.
   */
  connectionName?: string;
}

/** @internal Per-transaction overrides threaded into executeInTransaction. */
export interface ExecuteTransactionOptions {
  isolationLevel?: TRANSACTION_ISOLATION_LEVEL;
  connectionName?: string;
  /** When true, ignore any ambient session and always open a new transaction. */
  forceNew?: boolean;
}
