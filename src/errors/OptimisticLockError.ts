import { OrmError } from "./OrmError";
import { OrmErrorCode } from "./OrmErrorCode";

/**
 * 낙관적 락(Optimistic Locking) 충돌 시 발생하는 에러입니다.
 * UPDATE 쿼리에서 version 조건에 의해 affectedRows === 0이면 throw됩니다.
 *
 * 이는 다른 트랜잭션이 동일한 행을 먼저 수정했음을 의미합니다.
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
