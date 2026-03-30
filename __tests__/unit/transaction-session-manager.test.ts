import "reflect-metadata";
import { DatabaseNotConnectedError } from "../../src/errors/DatabaseNotConnectedError";
import { DatabaseConnectionFailedError } from "../../src/errors/DatabaseConnectionFailedError";

// ── All mocks must be set up BEFORE importing TransactionSessionManager ──
// jest.mock is hoisted, so factories can only use jest.fn() — not external const.

const dsQuery = jest.fn();
const dsStartTx = jest.fn().mockResolvedValue(undefined);
const dsCommit = jest.fn().mockResolvedValue(undefined);
const dsRollback = jest.fn().mockResolvedValue(undefined);
const dsClose = jest.fn().mockResolvedValue(undefined);
const dsCreate = jest.fn().mockResolvedValue(undefined);
const dsSavepoint = jest.fn().mockResolvedValue(undefined);
const dsRollbackTo = jest.fn().mockResolvedValue(undefined);

// These must be defined as module-scoped vars that jest.mock factories can capture.
const mockGetConnection = jest.fn().mockResolvedValue({
  connect: jest.fn().mockResolvedValue(undefined),
  close: jest.fn().mockResolvedValue(undefined),
});

const mockGetOptions = jest.fn().mockReturnValue({
  host: "localhost",
  port: 3306,
  username: "root",
  password: "",
  database: "test",
});

const dbInstance: Record<string, any> = {
  type: "mysql",
  getConnection: mockGetConnection,
  getOptions: mockGetOptions,
  getType: jest.fn().mockReturnValue("mysql"),
};

jest.mock("../../src/DatabaseClient", () => ({
  DatabaseClient: {
    getInstance: jest.fn(() => dbInstance),
  },
}));

function makeMockDS() {
  return {
    query: dsQuery,
    startTransaction: dsStartTx,
    commit: dsCommit,
    rollback: dsRollback,
    close: dsClose,
    createConnection: dsCreate,
    savepoint: dsSavepoint,
    rollbackTo: dsRollbackTo,
  };
}

jest.mock("../../src/dialects/mysql/MySqlDataSource", () => ({
  MySqlDataSource: jest.fn().mockImplementation(() => makeMockDS()),
}));
jest.mock("../../src/dialects/postgres/PostgresDataSource", () => ({
  PostgresDataSource: jest.fn().mockImplementation(() => makeMockDS()),
}));
jest.mock("../../src/dialects/sqlite/SqliteDataSource", () => ({
  SqliteDataSource: jest.fn().mockImplementation(() => makeMockDS()),
}));
jest.mock("../../src/dialects/postgres/PostgresConnector", () => ({
  PostgresConnector: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));
jest.mock("../../src/dialects/mysql/MySqlConnector", () => ({
  MySqlConnector: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

// Import AFTER mocks
import { TransactionSessionManager } from "../../src/dialects/TransactionSessionManager";

describe("TransactionSessionManager", () => {
  let session: TransactionSessionManager;

  beforeEach(() => {
    jest.clearAllMocks();
    dbInstance.type = "mysql";
    session = new TransactionSessionManager();
  });

  // ─── connect() ─────────────────────────────────────────────────

  describe("connect()", () => {
    it("should connect to the database with default connection", async () => {
      await session.connect();
      expect(mockGetConnection).toHaveBeenCalled();
      expect(dsCreate).toHaveBeenCalled();
    });

    it("should connect with named connection", async () => {
      await session.connect("secondary");
      expect(mockGetConnection).toHaveBeenCalledWith("secondary");
    });

    it("should throw DatabaseConnectionFailedError on failure", async () => {
      mockGetConnection.mockRejectedValueOnce(new Error("Connection refused"));
      await expect(session.connect()).rejects.toThrow(DatabaseConnectionFailedError);
    });

    it("should create PostgresDataSource for postgres type", async () => {
      dbInstance.type = "postgres";
      await session.connect();

      const { PostgresDataSource } = require("../../src/dialects/postgres/PostgresDataSource");
      expect(PostgresDataSource).toHaveBeenCalled();
    });

    it("should create SqliteDataSource for sqlite type", async () => {
      dbInstance.type = "sqlite";
      await session.connect();

      const { SqliteDataSource } = require("../../src/dialects/sqlite/SqliteDataSource");
      expect(SqliteDataSource).toHaveBeenCalled();
    });

    it("should create MySqlDataSource for mariadb type", async () => {
      dbInstance.type = "mariadb";
      await session.connect();

      const { MySqlDataSource } = require("../../src/dialects/mysql/MySqlDataSource");
      expect(MySqlDataSource).toHaveBeenCalled();
    });

    it("should throw for unsupported database type", async () => {
      dbInstance.type = "oracle";
      await expect(session.connect()).rejects.toThrow(DatabaseConnectionFailedError);
    });
  });

  // ─── connectToNode() ───────────────────────────────────────────

  describe("connectToNode()", () => {
    const nodeConfig = {
      host: "replica.example.com",
      port: 5432,
      username: "reader",
      password: "secret",
      database: "mydb",
    };

    it("should connect to a replication node (mysql)", async () => {
      await session.connectToNode(nodeConfig);
      expect(dsCreate).toHaveBeenCalled();
    });

    it("should connect to a postgres replication node", async () => {
      dbInstance.type = "postgres";
      await session.connectToNode(nodeConfig);

      const { PostgresConnector } = require("../../src/dialects/postgres/PostgresConnector");
      expect(PostgresConnector).toHaveBeenCalled();
    });

    it("should throw DatabaseConnectionFailedError on connect failure", async () => {
      dsCreate.mockRejectedValueOnce(new Error("fail"));
      await expect(session.connectToNode(nodeConfig)).rejects.toThrow(DatabaseConnectionFailedError);
    });
  });

  // ─── query() ───────────────────────────────────────────────────

  describe("query()", () => {
    it("should throw DatabaseNotConnectedError when not connected", async () => {
      await expect(session.query("SELECT 1")).rejects.toThrow(DatabaseNotConnectedError);
    });

    it("should execute query when connected", async () => {
      dsQuery.mockResolvedValueOnce({ results: [{ id: 1 }] });
      await session.connect();
      const result = await session.query("SELECT 1");
      expect(result).toEqual({ results: [{ id: 1 }] });
    });

    it("should execute parameterized Sql query", async () => {
      const sql = require("sql-template-tag");
      dsQuery.mockResolvedValueOnce({ results: [] });
      await session.connect();
      const query = sql.default`SELECT * FROM users WHERE id = ${1}`;
      await session.query(query);
      expect(dsQuery).toHaveBeenCalledWith(query);
    });
  });

  // ─── startTransaction() ────────────────────────────────────────

  describe("startTransaction()", () => {
    it("should throw DatabaseNotConnectedError when not connected", async () => {
      await expect(session.startTransaction()).rejects.toThrow(DatabaseNotConnectedError);
    });

    it("should start transaction with default isolation level", async () => {
      await session.connect();
      await session.startTransaction();
      expect(dsStartTx).toHaveBeenCalledWith("READ COMMITTED");
    });

    it("should start transaction with custom isolation level", async () => {
      await session.connect();
      await session.startTransaction("SERIALIZABLE");
      expect(dsStartTx).toHaveBeenCalledWith("SERIALIZABLE");
    });
  });

  // ─── commit() / rollback() ─────────────────────────────────────

  describe("commit()", () => {
    it("should commit transaction", async () => {
      await session.connect();
      await session.commit();
      expect(dsCommit).toHaveBeenCalled();
    });
  });

  describe("rollback()", () => {
    it("should rollback transaction", async () => {
      await session.connect();
      await session.rollback();
      expect(dsRollback).toHaveBeenCalled();
    });
  });

  // ─── savepoint() / rollbackTo() ────────────────────────────────

  describe("savepoint()", () => {
    it("should create a savepoint", async () => {
      await session.connect();
      await session.savepoint("sp1");
      expect(dsSavepoint).toHaveBeenCalledWith("sp1");
    });

    it("should reject invalid savepoint names", async () => {
      await session.connect();
      await expect(session.savepoint("invalid name!")).rejects.toThrow();
    });
  });

  describe("rollbackTo()", () => {
    it("should rollback to savepoint", async () => {
      await session.connect();
      await session.rollbackTo("sp1");
      expect(dsRollbackTo).toHaveBeenCalledWith("sp1");
    });

    it("should reject invalid savepoint names", async () => {
      await session.connect();
      await expect(session.rollbackTo("bad name!")).rejects.toThrow();
    });
  });

  // ─── close() ───────────────────────────────────────────────────

  describe("close()", () => {
    it("should throw DatabaseNotConnectedError when not connected", async () => {
      await expect(session.close()).rejects.toThrow(DatabaseNotConnectedError);
    });

    it("should close connection", async () => {
      await session.connect();
      await session.close();
      expect(dsClose).toHaveBeenCalled();
    });
  });
});
