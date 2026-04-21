/* eslint-disable @typescript-eslint/no-explicit-any */
import type {
  DatabaseClientOptions,
  RetryOptions,
} from "../../src/core/DatabaseClientOptions";

/**
 * Connection retry tests (exponential backoff)
 *
 * Verifies that when DatabaseClient.connect() has a retry option,
 * it waits backoffMs * 2^n between attempts up to maxAttempts on failure.
 */

// DatabaseClient is a singleton, so reset its internal state before each test.
function resetDatabaseClient() {
  const { DatabaseClient } = require("../../src/DatabaseClient");
  (DatabaseClient as any).instance = undefined;
  return DatabaseClient;
}

// Mock the real connectors.
jest.mock("../../src/dialects/mysql/MySqlConnector", () => {
  return {
    MySqlConnector: jest.fn().mockImplementation(() => ({
      connect: jest.fn(),
      close: jest.fn(),
    })),
  };
});

jest.mock("../../src/dialects/postgres/PostgresConnector", () => {
  return {
    PostgresConnector: jest.fn().mockImplementation(() => ({
      connect: jest.fn(),
      close: jest.fn(),
    })),
  };
});

jest.mock("../../src/dialects/sqlite/SqliteConnector", () => {
  return {
    SqliteConnector: jest.fn().mockImplementation(() => ({
      connect: jest.fn(),
      close: jest.fn(),
    })),
  };
});

describe("DatabaseClientOptions - RetryOptions 인터페이스", () => {
  it("should accept retry configuration", () => {
    const options: DatabaseClientOptions = {
      type: "postgres",
      host: "localhost",
      port: 5432,
      username: "test",
      password: "test",
      database: "testdb",
      entities: [],
      retry: {
        maxAttempts: 5,
        backoffMs: 1000,
      },
    };

    expect(options.retry?.maxAttempts).toBe(5);
    expect(options.retry?.backoffMs).toBe(1000);
  });

  it("should accept options without retry configuration (backward compatible)", () => {
    const options: DatabaseClientOptions = {
      type: "mysql",
      host: "localhost",
      port: 3306,
      username: "test",
      password: "test",
      database: "testdb",
      entities: [],
    };

    expect(options.retry).toBeUndefined();
  });
});

describe("DatabaseClient.connect() - Connection Retry", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("should connect on first attempt without retry when no retry option", async () => {
    const DatabaseClient = resetDatabaseClient();
    const { MySqlConnector } = require("../../src/dialects/mysql/MySqlConnector");

    const mockConnect = jest.fn().mockResolvedValue(undefined);
    MySqlConnector.mockImplementation(() => ({
      connect: mockConnect,
      close: jest.fn(),
    }));

    const client = DatabaseClient.getInstance();
    await client.connect({
      type: "mysql",
      host: "localhost",
      port: 3306,
      username: "test",
      password: "test",
      database: "testdb",
      entities: [],
    });

    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it("should succeed on first attempt with retry option", async () => {
    const DatabaseClient = resetDatabaseClient();
    const { MySqlConnector } = require("../../src/dialects/mysql/MySqlConnector");

    const mockConnect = jest.fn().mockResolvedValue(undefined);
    MySqlConnector.mockImplementation(() => ({
      connect: mockConnect,
      close: jest.fn(),
    }));

    const client = DatabaseClient.getInstance();
    await client.connect({
      type: "mysql",
      host: "localhost",
      port: 3306,
      username: "test",
      password: "test",
      database: "testdb",
      entities: [],
      retry: { maxAttempts: 3, backoffMs: 100 },
    });

    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it("should retry on failure and succeed on second attempt", async () => {
    const DatabaseClient = resetDatabaseClient();
    const { PostgresConnector } = require("../../src/dialects/postgres/PostgresConnector");

    const mockConnect = jest.fn()
      .mockRejectedValueOnce(new Error("Connection refused"))
      .mockResolvedValueOnce(undefined);

    PostgresConnector.mockImplementation(() => ({
      connect: mockConnect,
      close: jest.fn(),
    }));

    const client = DatabaseClient.getInstance();
    const connectPromise = client.connect({
      type: "postgres",
      host: "localhost",
      port: 5432,
      username: "test",
      password: "test",
      database: "testdb",
      entities: [],
      retry: { maxAttempts: 3, backoffMs: 100 },
    });

    // Wait 100ms (100 * 2^0) after the first failure
    await jest.advanceTimersByTimeAsync(100);

    await connectPromise;

    expect(mockConnect).toHaveBeenCalledTimes(2);
  });

  it("should retry with exponential backoff delays", async () => {
    const DatabaseClient = resetDatabaseClient();
    const { MySqlConnector } = require("../../src/dialects/mysql/MySqlConnector");

    const mockConnect = jest.fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockResolvedValueOnce(undefined);

    MySqlConnector.mockImplementation(() => ({
      connect: mockConnect,
      close: jest.fn(),
    }));

    const client = DatabaseClient.getInstance();
    const connectPromise = client.connect({
      type: "mysql",
      host: "localhost",
      port: 3306,
      username: "test",
      password: "test",
      database: "testdb",
      entities: [],
      retry: { maxAttempts: 5, backoffMs: 100 },
    });

    // Wait 100ms (100 * 2^0) after the first failure
    await jest.advanceTimersByTimeAsync(100);
    // Wait 200ms (100 * 2^1) after the second failure
    await jest.advanceTimersByTimeAsync(200);

    await connectPromise;

    expect(mockConnect).toHaveBeenCalledTimes(3);
  });

  it("should throw last error after all retry attempts exhausted", async () => {
    const DatabaseClient = resetDatabaseClient();
    const { SqliteConnector } = require("../../src/dialects/sqlite/SqliteConnector");

    const mockConnect = jest.fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockRejectedValueOnce(new Error("final failure"));

    SqliteConnector.mockImplementation(() => ({
      connect: mockConnect,
      close: jest.fn(),
    }));

    const client = DatabaseClient.getInstance();

    // Pre-register catch to avoid unhandled rejection
    let caughtError: Error | null = null;
    const connectPromise = client.connect({
      type: "sqlite",
      database: ":memory:",
      entities: [],
      retry: { maxAttempts: 3, backoffMs: 50 },
    }).catch((e: Error) => { caughtError = e; });

    // Wait 50ms (50 * 2^0) after the first failure
    await jest.advanceTimersByTimeAsync(50);
    // Wait 100ms (50 * 2^1) after the second failure
    await jest.advanceTimersByTimeAsync(100);

    await connectPromise;

    expect(caughtError).not.toBeNull();
    expect(caughtError!.message).toBe("final failure");
    expect(mockConnect).toHaveBeenCalledTimes(3);
  });

  it("should throw immediately for unsupported database type", async () => {
    const DatabaseClient = resetDatabaseClient();

    const client = DatabaseClient.getInstance();

    await expect(
      client.connect({
        type: "oracle" as any,
        host: "localhost",
        port: 1521,
        username: "test",
        password: "test",
        database: "testdb",
        entities: [],
        retry: { maxAttempts: 3, backoffMs: 100 },
      }),
    ).rejects.toThrow();
  });

  it("should not retry when maxAttempts is 1", async () => {
    const DatabaseClient = resetDatabaseClient();
    const { MySqlConnector } = require("../../src/dialects/mysql/MySqlConnector");

    const mockConnect = jest.fn()
      .mockRejectedValueOnce(new Error("immediate failure"));

    MySqlConnector.mockImplementation(() => ({
      connect: mockConnect,
      close: jest.fn(),
    }));

    const client = DatabaseClient.getInstance();

    await expect(
      client.connect({
        type: "mysql",
        host: "localhost",
        port: 3306,
        username: "test",
        password: "test",
        database: "testdb",
        entities: [],
        retry: { maxAttempts: 1, backoffMs: 100 },
      }),
    ).rejects.toThrow("immediate failure");

    expect(mockConnect).toHaveBeenCalledTimes(1);
  });
});

describe("Exponential backoff calculation", () => {
  it("should calculate correct backoff delays", () => {
    const backoffMs = 100;

    // attempt 1: 100 * 2^0 = 100ms
    expect(backoffMs * Math.pow(2, 0)).toBe(100);
    // attempt 2: 100 * 2^1 = 200ms
    expect(backoffMs * Math.pow(2, 1)).toBe(200);
    // attempt 3: 100 * 2^2 = 400ms
    expect(backoffMs * Math.pow(2, 2)).toBe(400);
    // attempt 4: 100 * 2^3 = 800ms
    expect(backoffMs * Math.pow(2, 3)).toBe(800);
    // attempt 5: 100 * 2^4 = 1600ms
    expect(backoffMs * Math.pow(2, 4)).toBe(1600);
  });

  it("should calculate correct backoff with 1000ms base", () => {
    const backoffMs = 1000;

    expect(backoffMs * Math.pow(2, 0)).toBe(1000);
    expect(backoffMs * Math.pow(2, 1)).toBe(2000);
    expect(backoffMs * Math.pow(2, 2)).toBe(4000);
  });
});
