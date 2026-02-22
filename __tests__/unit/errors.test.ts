import { Exception } from "../../src/errors/Exception";
import { DatabaseNotConnectedError } from "../../src/errors/DatabaseNotConnectedError";
import { DatabaseConnectionFailedError } from "../../src/errors/DatabaseConnectionFailedError";
import { NotSupportedDatabaseTypeError } from "../../src/errors/NotSupportedDatabaseTypeError";

describe("Exception", () => {
  it("should create an exception with message and status", () => {
    const error = new Exception("test error", 400);

    expect(error.message).toBe("test error");
    expect(error.status).toBe(400);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(Exception);
  });

  it("should be throwable and catchable", () => {
    expect(() => {
      throw new Exception("thrown error", 500);
    }).toThrow("thrown error");
  });
});

describe("DatabaseNotConnectedError", () => {
  it("should have correct message and status 500", () => {
    const error = new DatabaseNotConnectedError();

    expect(error.message).toBe("데이터베이스 연결이 되어있지 않습니다.");
    expect(error.status).toBe(500);
    expect(error).toBeInstanceOf(Exception);
    expect(error).toBeInstanceOf(Error);
  });
});

describe("DatabaseConnectionFailedError", () => {
  it("should have correct message and status 500", () => {
    const error = new DatabaseConnectionFailedError();

    expect(error.message).toBe("데이터베이스 연결에 실패했습니다.");
    expect(error.status).toBe(500);
    expect(error).toBeInstanceOf(Exception);
    expect(error).toBeInstanceOf(Error);
  });
});

describe("NotSupportedDatabaseTypeError", () => {
  it("should have correct message and status 500", () => {
    const error = new NotSupportedDatabaseTypeError();

    expect(error.message).toBe("지원하지 않는 데이터베이스 타입입니다.");
    expect(error.status).toBe(500);
    expect(error).toBeInstanceOf(Exception);
    expect(error).toBeInstanceOf(Error);
  });
});
