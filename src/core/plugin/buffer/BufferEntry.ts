/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../../../utils";
import { CollectionSnapshot } from "./CollectionTracker";
import { LockMode } from "./BufferPreview";

/**
 * A tracked entity with its snapshot for dirty checking.
 */
export interface TrackedEntry {
  entity: ClazzType<any>;
  instance: any;
  snapshot: Record<string, any>;
  columnNames: string[];
  pkColumns: string[];
  /** Collection snapshots for O2M/M2M diff tracking */
  collectionSnapshots?: CollectionSnapshot[];
  /** Pessimistic lock mode to acquire during flush */
  lockMode?: LockMode;
  /** When true, skip dirty checking on flush (immutable entity) */
  readOnly?: boolean;
  /** Explicitly marked dirty (for DEFERRED_EXPLICIT tracking) */
  explicitDirty?: boolean;
}

/**
 * A queued INSERT operation.
 */
export interface InsertEntry {
  entity: ClazzType<any>;
  data: Record<string, any>;
}

/**
 * A queued DELETE operation.
 */
export interface DeleteEntry {
  entity: ClazzType<any>;
  criteria: Record<string, any>;
}

/**
 * An instance-based INSERT entry queued via persist().
 * Holds a reference to the original instance so that generated PK
 * and auto-columns can be written back after flush.
 */
export interface PersistEntry {
  entity: ClazzType<any>;
  instance: any;
  columnNames: string[];
  pkColumns: string[];
}
