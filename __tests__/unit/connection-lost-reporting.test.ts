/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { EventEmitter } from "events";
import { PostgresConnector } from "../../src/dialects/postgres/PostgresConnector";
import { MySqlConnector } from "../../src/dialects/mysql/MySqlConnector";
import { createConnectionErrorReporter } from "../../src/dialects/connectionErrorReporter";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";
import { Logger } from "../../src/utils/Logger";

// A connection the server closes outside a statement raises "error" on an
// emitter. Node ends the process when such an event has no listener, which is
// what a restart of the database did to an application holding a PostgreSQL
// pool.

const mockPgPools: any[] = [];
jest.mock("pg", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: Emitter } = require("events");
  return {
    Pool: jest.fn().mockImplementation(() => {
      const pool = new Emitter();
      pool.query = jest.fn();
      pool.end = jest.fn().mockResolvedValue(undefined);
      pool.connect = jest.fn().mockResolvedValue({ release: jest.fn() });
      mockPgPools.push(pool);
      return pool;
    }),
  };
});

const mockMysqlPools: any[] = [];
jest.mock("mysql2", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: Emitter } = require("events");
  return {
    createPool: jest.fn().mockImplementation(() => {
      const pool = new Emitter();
      pool.getConnection = jest.fn((cb: any) => cb(null, { release: jest.fn() }));
      pool.end = jest.fn((cb: any) => cb?.());
      mockMysqlPools.push(pool);
      return pool;
    }),
  };
});

const base = {
  host: "localhost",
  username: "u",
  password: "p",
  database: "app",
  entities: [],
  versionOverride: "16.0",
};

describe("lost pooled connections", () => {
  const logged: string[] = [];

  beforeEach(() => {
    mockPgPools.length = 0;
    mockMysqlPools.length = 0;
    logged.length = 0;
    Logger.setOutput((line) => logged.push(line));
  });

  afterEach(() => {
    Logger.reset();
  });

  describe("createConnectionErrorReporter", () => {
    it("hands the listener an OrmError that keeps the driver error as cause", () => {
      const onConnectionError = jest.fn();
      const report = createConnectionErrorReporter({ onConnectionError }, new Logger("t"), "PostgreSQL");
      const cause = new Error("terminating connection due to administrator command");

      report(cause, {});

      expect(onConnectionError).toHaveBeenCalledTimes(1);
      const received = onConnectionError.mock.calls[0][0];
      expect(received).toBeInstanceOf(OrmError);
      expect(received.code).toBe(OrmErrorCode.CONNECTION_LOST);
      expect(received.message).toContain("terminating connection due to administrator command");
      expect(received.cause).toBe(cause);
      expect(logged).toEqual([]);
    });

    it("reports a connection once however many errors it raises", () => {
      const onConnectionError = jest.fn();
      const report = createConnectionErrorReporter({ onConnectionError }, new Logger("t"), "PostgreSQL");
      const first = {};
      const second = {};

      report(new Error("fatal"), first);
      report(new Error("Connection terminated unexpectedly"), first);
      report(new Error("fatal"), second);

      expect(onConnectionError).toHaveBeenCalledTimes(2);
    });

    it("logs a warning when there is no listener", () => {
      const report = createConnectionErrorReporter({}, new Logger("t"), "MySQL");

      report(new Error("Connection lost"), {});

      expect(logged.join("\n")).toContain("WARN");
      expect(logged.join("\n")).toContain("A pooled MySQL connection was lost. Connection lost");
    });

    it("does not let a throwing listener escape", () => {
      const report = createConnectionErrorReporter(
        {
          onConnectionError: () => {
            throw new Error("listener bug");
          },
        },
        new Logger("t"),
        "PostgreSQL",
      );

      expect(() => report(new Error("fatal"), {})).not.toThrow();
      expect(logged.join("\n")).toContain("ERROR");
      expect(logged.join("\n")).toContain("listener bug");
    });
  });

  describe("PostgresConnector", () => {
    it("survives an error on the pool and reports it", async () => {
      const onConnectionError = jest.fn();
      await new PostgresConnector().connect({ ...base, type: "postgres", port: 5432, onConnectionError } as any);
      const pool = mockPgPools[0];

      expect(() => pool.emit("error", new Error("idle client died"), {})).not.toThrow();

      expect(onConnectionError).toHaveBeenCalledTimes(1);
      expect(onConnectionError.mock.calls[0][0].code).toBe(OrmErrorCode.CONNECTION_LOST);
    });

    it("survives an error on a checked-out client and reports the client once", async () => {
      const onConnectionError = jest.fn();
      await new PostgresConnector().connect({ ...base, type: "postgres", port: 5432, onConnectionError } as any);
      const pool = mockPgPools[0];
      const client = new EventEmitter();
      pool.emit("connect", client);

      expect(() => client.emit("error", new Error("terminating connection"))).not.toThrow();
      expect(() => client.emit("error", new Error("Connection terminated unexpectedly"))).not.toThrow();
      // An idle client's error reaches the pool as well.
      pool.emit("error", new Error("terminating connection"), client);

      expect(onConnectionError).toHaveBeenCalledTimes(1);
    });

    it("warns when no listener is configured", async () => {
      await new PostgresConnector().connect({ ...base, type: "postgres", port: 5432 } as any);

      mockPgPools[0].emit("error", new Error("idle client died"), {});

      expect(logged.join("\n")).toContain("idle client died");
    });
  });

  describe("MySqlConnector", () => {
    it("reports an error a pooled connection raises", async () => {
      const onConnectionError = jest.fn();
      await new MySqlConnector().connect({
        ...base,
        type: "mysql",
        port: 3306,
        versionOverride: "8.4.0",
        onConnectionError,
      } as any);
      const connection = new EventEmitter();
      mockMysqlPools[0].emit("connection", connection);

      expect(() => connection.emit("error", new Error("Connection lost: The server closed the connection."))).not.toThrow();

      expect(onConnectionError).toHaveBeenCalledTimes(1);
      expect(onConnectionError.mock.calls[0][0].message).toContain("A pooled MySQL connection was lost.");
    });
  });
});
