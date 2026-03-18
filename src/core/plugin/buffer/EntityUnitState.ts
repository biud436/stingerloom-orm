/**
 * Entity lifecycle states within a WriteBuffer (Unit of Work).
 */
export enum EntityState {
  /** persist() called, not yet flushed to DB */
  NEW = "NEW",
  /** Tracked and managed — either loaded or successfully flushed */
  MANAGED = "MANAGED",
  /** Explicitly detached or untracked */
  DETACHED = "DETACHED",
  /** Marked for deletion via remove() */
  REMOVED = "REMOVED",
}
