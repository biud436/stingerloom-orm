import { OrmError } from "./OrmError";
import { OrmErrorCode } from "./OrmErrorCode";

/**
 * 데이터베이스 연결이 되어있지 않을 때 발생하는 에러입니다.
 */
export class DatabaseNotConnectedError extends OrmError {
  constructor() {
    super(
      OrmErrorCode.NOT_CONNECTED,
      `Database is not connected.`,
      `Call entityManager.register(options) or entityManager.connect(options) before executing queries.`,
    );
    this.name = "DatabaseNotConnectedError";
  }
}
