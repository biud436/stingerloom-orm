/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../../../utils";

/**
 * A preview entry describing an operation that will be executed on flush.
 */
export type BufferPreviewEntry =
  | { action: "update"; entity: string; where: Record<string, any>; data: Record<string, any> }
  | { action: "insert"; entity: string; data: Record<string, any> }
  | { action: "delete"; entity: string; criteria: Record<string, any> }
  | { action: "bulkUpdate"; entity: string; where: Record<string, any>; set: Record<string, any> }
  | { action: "bulkDelete"; entity: string; where: Record<string, any> };

/**
 * Typed changeset returned by computeChanges().
 */
export interface BufferChangeset {
  inserts: { entity: ClazzType<any>; data: Record<string, any>; instance?: any }[];
  updates: { entity: ClazzType<any>; data: Record<string, any>; where: Record<string, any>; instance: any }[];
  deletes: { entity: ClazzType<any>; criteria: Record<string, any> }[];
}

/**
 * Result returned after a successful flush.
 */
export interface BufferFlushResult {
  updates: number;
  inserts: number;
  deletes: number;
}

// ── Change Tracking ─────────────────────────────────────────────

/**
 * Change tracking policy for the WriteBuffer.
 *
 * - DEFERRED_IMPLICIT: Automatic dirty check on flush — compares current vs snapshot. (default)
 * - DEFERRED_EXPLICIT: Only entities explicitly marked dirty via `markDirty()` are checked.
 */
export enum ChangeTrackingPolicy {
  DEFERRED_IMPLICIT = "DEFERRED_IMPLICIT",
  DEFERRED_EXPLICIT = "DEFERRED_EXPLICIT",
}

// ── Flush Mode ──────────────────────────────────────────────────

/**
 * Controls when the WriteBuffer automatically flushes pending changes.
 *
 * - AUTO: Flush before find/findOne queries if there is pending work.
 * - COMMIT: Only flush on explicit `flush()` calls.
 * - MANUAL: Same as COMMIT — never auto-flush.
 * - ALWAYS: Flush before every find/findOne, even without pending work detection.
 */
export enum FlushMode {
  AUTO = "AUTO",
  COMMIT = "COMMIT",
  MANUAL = "MANUAL",
  ALWAYS = "ALWAYS",
}

// ── Pessimistic Locking ─────────────────────────────────────────

// Re-export LockMode from FindOption (canonical location) for backward compatibility.
export { LockMode } from "../../../dialects/FindOption";

// ── Flush Events ────────────────────────────────────────────────

/**
 * Per-entity flush event types.
 */
export type FlushEventType =
  | "preInsert" | "postInsert"
  | "preUpdate" | "postUpdate"
  | "preDelete" | "postDelete";

/**
 * Per-entity flush event payload.
 */
export interface FlushEvent {
  type: FlushEventType;
  entity: ClazzType<any>;
  instance?: any;
  data?: Record<string, any>;
  criteria?: Record<string, any>;
}

export type FlushEventListener = (event: FlushEvent) => void | Promise<void>;

// ── Bulk DML ────────────────────────────────────────────────────

/**
 * Queued bulk UPDATE entry.
 */
export interface BulkUpdateEntry {
  entity: ClazzType<any>;
  where: Record<string, any>;
  set: Record<string, any>;
}

/**
 * Queued bulk DELETE entry.
 */
export interface BulkDeleteEntry {
  entity: ClazzType<any>;
  where: Record<string, any>;
}

/**
 * Options for the buffer plugin.
 */
export interface BufferPluginOptions {
  /**
   * If true (default), tracked entities are re-snapshotted after flush
   * so that further changes can be accumulated and flushed again.
   * If false, all tracked state is cleared after flush.
   */
  retainAfterFlush?: boolean;
  /**
   * Enable cascade processing based on @OneToMany decorator metadata.
   * When true, persist/flush will automatically cascade insert/update
   * to child entities that have cascade options set.
   * @default true
   */
  cascade?: boolean;
  /**
   * When true, child entities removed from a @OneToMany array
   * are automatically deleted from the database on flush.
   * @default false
   */
  orphanRemoval?: boolean;
  /**
   * When true (and cascade is true), M2M pivot table rows
   * are automatically inserted/deleted when the owning-side array changes.
   * @default true when cascade is true
   */
  manyToManySync?: boolean;
  /**
   * Automatically flush pending changes before find/findOne queries.
   * Shorthand for `flushMode: FlushMode.AUTO`.
   * @default false
   */
  autoFlush?: boolean;
  /**
   * Controls when the buffer auto-flushes.
   * Takes precedence over `autoFlush` if both are set.
   * @default FlushMode.MANUAL
   */
  flushMode?: FlushMode;
  /**
   * Callback invoked after a successful flush with the result summary.
   */
  onFlush?: (result: BufferFlushResult) => void | Promise<void>;
  /**
   * Use batch INSERT for multiple entities of the same type.
   * @default false
   */
  batchInsert?: boolean;
  /**
   * Use batch UPDATE for multiple dirty entities of the same type.
   * Builds CASE WHEN ... THEN ... END expressions per column.
   * @default false
   */
  batchUpdate?: boolean;
  /**
   * Change tracking policy.
   * @default ChangeTrackingPolicy.DEFERRED_IMPLICIT
   */
  changeTracking?: ChangeTrackingPolicy;
  /**
   * Enable verbose logging for buffer operations.
   * Logs track/persist/remove/flush lifecycle events to console.
   * @default false
   */
  logging?: boolean;
}
