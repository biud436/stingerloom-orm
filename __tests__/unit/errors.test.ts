import { Exception } from "../../src/errors/Exception";
import { OrmError } from "../../src/errors/OrmError";
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
  it("should have correct message and status 500", () => {
    const error = new DatabaseConnectionFailedError();

    expect(error.message).toBe("Failed to connect to the database.");
    expect(error.status).toBe(500);
    expect(error).toBeInstanceOf(Exception);
    expect(error).toBeInstanceOf(Error);
  });

  it("should preserve original Error message and cause", () => {
    const original = new Error("ECONNREFUSED 127.0.0.1:5432");
    const error = new DatabaseConnectionFailedError(original);

    expect(error.message).toBe(
      "Failed to connect to the database: ECONNREFUSED 127.0.0.1:5432",
    );
    expect((error as any).cause).toBe(original);
    expect(error.status).toBe(500);
  });

  it("should handle non-Error original values", () => {
    const error = new DatabaseConnectionFailedError("pool exhausted");

    expect(error.message).toBe(
      "Failed to connect to the database: pool exhausted",
    );
    expect((error as any).cause).toBe("pool exhausted");
  });
});

describe("NotSupportedDatabaseTypeError", () => {
  it("should have correct message and status 500", () => {
    const error = new NotSupportedDatabaseTypeError();

    expect(error.message).toBe("Unsupported database type.");
    expect(error.status).toBe(500);
    expect(error).toBeInstanceOf(Exception);
    expect(error).toBeInstanceOf(Error);
  });
});
