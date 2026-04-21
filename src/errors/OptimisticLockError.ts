import { OrmError } from "./OrmError";
import { OrmErrorCode } from "./OrmErrorCode";

/**
 * Thrown on an optimistic lock conflict.
 * An UPDATE with a version predicate throws this when affectedRows === 0,
 * indicating another transaction already modified the row.
 */
export class OptimisticLockError extends OrmError {
  constructor(entityName: string, expectedVersion: number) {
    super(
      OrmErrorCode.OPTIMISTIC_LOCK_FAILED,
      `Optimistic lock failed for entity "${entityName}": ` +
        `the row was modified by another transaction (expected version ${expectedVersion}).`,
    );
    this.name = "OptimisticLockError";
  }
}
