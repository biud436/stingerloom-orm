/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * A preview entry describing an operation that will be executed on flush.
 */
export type BufferPreviewEntry =
  | { action: "update"; entity: string; where: Record<string, any>; data: Record<string, any> }
  | { action: "insert"; entity: string; data: Record<string, any> }
  | { action: "delete"; entity: string; criteria: Record<string, any> };

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
}
