import { Exception } from "../../src/errors/Exception";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";
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

  it("is named after its class, including a subclass", () => {
    class PaymentDeclined extends Exception {}

    expect(new Exception("x", 400).name).toBe("Exception");
    expect(new PaymentDeclined("x", 402).name).toBe("PaymentDeclined");
  });

  it("should be throwable and catchable", () => {
    expect(() => {
      throw new Exception("thrown error", 500);
    }).toThrow("thrown error");
  });
});

describe("OrmError suggestion exposure", () => {
  it("appends the suggestion to message so every rendering path shows it", () => {
    const error = new OrmError(
      "ORM_INVALID_QUERY" as never,
      "Something went wrong.",
      "Do the other thing.",
    );

    expect(error.message).toBe(
      "Something went wrong.\nSuggestion: Do the other thing.",
    );
    expect(error.suggestion).toBe("Do the other thing.");
    // The stack header is baked at construction — it must carry the suggestion too.
    expect(error.stack).toContain("Suggestion: Do the other thing.");
  });

  it("leaves message untouched when no suggestion is given", () => {
    const error = new OrmError("ORM_INVALID_QUERY" as never, "Plain failure.");

    expect(error.message).toBe("Plain failure.");
    expect(error.suggestion).toBeNull();
  });
});

describe("DatabaseNotConnectedError", () => {
  it("should have correct message and OrmError code", () => {
    const error = new DatabaseNotConnectedError();

    expect(error.message).toContain("Database is not connected.");
    expect(error.message).toContain(`\nSuggestion: ${error.suggestion}`);
    expect(error.code).toBe("ORM_NOT_CONNECTED");
    expect(error.suggestion).toBeTruthy();
    expect(error).toBeInstanceOf(OrmError);
    expect(error).toBeInstanceOf(Error);
  });
});

describe("DatabaseConnectionFailedError", () => {
  it("is an OrmError with the CONNECTION_FAILED code, its own name and status 500", () => {
    const error = new DatabaseConnectionFailedError();

    expect(error).toBeInstanceOf(OrmError);
    expect(error).toBeInstanceOf(DatabaseConnectionFailedError);
    expect(error.code).toBe(OrmErrorCode.CONNECTION_FAILED);
    expect(error.name).toBe("DatabaseConnectionFailedError");
    expect(error.status).toBe(500);
    expect(error.message).toBe(`Failed to connect to the database.\nSuggestion: ${error.suggestion}`);
    expect(error.suggestion).toContain("running and reachable");
    expect("cause" in error).toBe(false);
  });

  it("names the driver error and keeps it as the cause", () => {
    const original = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
      code: "ECONNREFUSED",
    });
    const error = new DatabaseConnectionFailedError(original);

    expect(error.message.split("\n")[0]).toBe(
      "Failed to connect to the database: connect ECONNREFUSED 127.0.0.1:5432",
    );
    expect(error.cause).toBe(original);
    expect((error.cause as { code: string }).code).toBe("ECONNREFUSED");
  });

  it("accepts a cause that is not an Error", () => {
    const error = new DatabaseConnectionFailedError("pool exhausted");

    expect(error.message.split("\n")[0]).toBe("Failed to connect to the database: pool exhausted");
    expect(error.cause).toBe("pool exhausted");
  });
});

describe("NotSupportedDatabaseTypeError", () => {
  it("is an OrmError with the UNSUPPORTED_DATABASE code that names the type", () => {
    const error = new NotSupportedDatabaseTypeError("oracle");

    expect(error).toBeInstanceOf(OrmError);
    expect(error.code).toBe(OrmErrorCode.UNSUPPORTED_DATABASE);
    expect(error.name).toBe("NotSupportedDatabaseTypeError");
    expect(error.status).toBe(500);
    expect(error.message.split("\n")[0]).toBe('Unsupported database type: "oracle".');
    expect(error.suggestion).toBe('Supported types: "mysql", "mariadb", "postgres", "sqlite".');
  });

  it("still reads without a type", () => {
    expect(new NotSupportedDatabaseTypeError().message.split("\n")[0]).toBe("Unsupported database type.");
  });
});

describe("OrmError cause", () => {
  it("keeps the cause the way Error does: own and not enumerable", () => {
    const driverError = new Error("duplicate key");
    const error = new OrmError(OrmErrorCode.SCHEMA_SYNC_FAILED, "Failed.", undefined, { cause: driverError });

    expect(error.cause).toBe(driverError);
    expect(Object.getOwnPropertyDescriptor(error, "cause")).toMatchObject({
      value: driverError,
      enumerable: false,
    });
    expect(Object.keys(error)).not.toContain("cause");
  });

  it("has no cause when none is given", () => {
    const error = new OrmError(OrmErrorCode.INVALID_QUERY, "Failed.", "Fix it.");

    expect("cause" in error).toBe(false);
    expect(error.cause).toBeUndefined();
  });

  it("keeps an explicit undefined cause, as Error does", () => {
    const error = new OrmError(OrmErrorCode.INVALID_QUERY, "Failed.", undefined, { cause: undefined });

    expect(Object.prototype.hasOwnProperty.call(error, "cause")).toBe(true);
  });
});
