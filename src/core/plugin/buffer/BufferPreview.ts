/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../../../utils";

/**
 * A preview entry describing an operation that will be executed on flush.
 */
export type BufferPreviewEntry =
  | { action: "update"; entity: string; where: Record<string, any>; data: Record<string, any> }
  | { action: "insert"; entity: string; data: Record<string, any> }
  | { action: "delete"; entity: string; criteria: Record<string, any> };

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
   * @default false
   */
  autoFlush?: boolean;
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
}
