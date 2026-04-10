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

// ── Buffer Cascade Options ─────────────────────────────────────

/**
 * Granular cascade options for WriteBuffer operations.
 *
 * Each key controls whether the buffer cascades to related entities
 * for the corresponding lifecycle operation.
 *
 * @example
 * ```ts
 * em.buffer({
 *   cascade: { persist: true, merge: true, remove: false, refresh: true, detach: true }
 * })
 * ```
 */
export interface BufferCascadeOptions {
  /**
   * Cascade persist (insert/update) to related entities during flush().
   * @default true
   */
  persist?: boolean;
  /**
   * Cascade merge() to related entities.
   * @default true
   */
  merge?: boolean;
  /**
   * Cascade remove() — propagate delete to related entities during flush().
   * @default true
   */
  remove?: boolean;
  /**
   * Cascade refresh() to tracked related entities.
   * @default true
   */
  refresh?: boolean;
  /**
   * Cascade detach() to related entities.
   * @default true
   */
  detach?: boolean;
}

/**
 * Resolved cascade options — all fields required, no undefined.
 */
export type ResolvedCascadeOptions = Required<BufferCascadeOptions>;

/**
 * Resolve cascade option: boolean | BufferCascadeOptions → ResolvedCascadeOptions.
 *
 * - `true` / `undefined` → all true
 * - `false` → all false
 * - object → merge with defaults (all true)
 */
export function resolveCascadeOptions(
  cascade: boolean | BufferCascadeOptions | undefined,
): ResolvedCascadeOptions {
  if (cascade === undefined || cascade === true) {
    return { persist: true, merge: true, remove: true, refresh: true, detach: true };
  }
  if (cascade === false) {
    return { persist: false, merge: false, remove: false, refresh: false, detach: false };
  }
  return {
    persist: cascade.persist ?? true,
    merge: cascade.merge ?? true,
    remove: cascade.remove ?? true,
    refresh: cascade.refresh ?? true,
    detach: cascade.detach ?? true,
  };
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
   *
   * - `true` (default): all cascade operations enabled
   * - `false`: all cascade operations disabled
   * - `BufferCascadeOptions`: granular control per operation
   *
   * @example
   * ```ts
   * // Enable persist cascade but disable remove cascade
   * em.buffer({ cascade: { persist: true, remove: false } })
   * ```
   *
   * @default true
   */
  cascade?: boolean | BufferCascadeOptions;
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
  /**
   * Maximum number of entries in the Identity Map.
   * When the limit is exceeded, the least-recently-used clean entries
   * are evicted (dirty, NEW, or REMOVED entities are never evicted).
   *
   * Leave undefined (default) for unlimited growth.
   */
  maxIdentityMapSize?: number;
  /**
   * Run @Validation decorator checks on all dirty/persisted entities
   * before executing flush. If validation fails, flush is aborted
   * and a ValidationError is thrown.
   * @default false
   */
  validateBeforeFlush?: boolean;
}

/**
 * Resolved buffer options — all fields required except `maxIdentityMapSize`
 * which remains optional (undefined = unlimited).
 *
 * `cascade` is resolved to `ResolvedCascadeOptions` (all boolean fields required).
 */
export type ResolvedBufferOptions =
  & Omit<Required<Omit<BufferPluginOptions, "maxIdentityMapSize" | "cascade">>, never>
  & { cascade: ResolvedCascadeOptions }
  & Pick<BufferPluginOptions, "maxIdentityMapSize">;
