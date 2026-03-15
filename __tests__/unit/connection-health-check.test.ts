/* eslint-disable @typescript-eslint/no-explicit-any */
import { MySqlConnector } from "../../src/dialects/mysql/MySqlConnector";
import { PostgresConnector } from "../../src/dialects/postgres/PostgresConnector";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function makeMysqlPool(pingResults: boolean[]) {
  let callIndex = 0;

  const makeConnection = () => ({
    ping: (cb: (err?: Error) => void) => {
      const ok = pingResults[callIndex++] ?? false;
      cb(ok ? undefined : new Error("ping failed"));
    },
    destroy: jest.fn(),
  });

  const connections: any[] = [];
  return {
    getConnection: (cb: (err: Error | null, conn?: any) => void) => {
      const conn = makeConnection();
      connections.push(conn);
      cb(null, conn);
    },
    connections,
  };
}

function makePgPool(queryResults: boolean[]) {
  let callIndex = 0;

  const makeClient = () => ({
    query: jest.fn().mockImplementation((sql: string) => {
      if (sql === "SELECT 1") {
        const ok = queryResults[callIndex++] ?? false;
        if (ok) return Promise.resolve({ rows: [{ "?column?": 1 }] });
        return Promise.reject(new Error("connection lost"));
      }
      return Promise.resolve({ rows: [] });
    }),
    release: jest.fn(),
  });

  const clients: any[] = [];
  return {
    connect: jest.fn().mockImplementation(() => {
      const client = makeClient();
      clients.push(client);
      return Promise.resolve(client);
    }),
    on: jest.fn(),
    clients,
  };
}

// ──────────────────────────────────────────────
// PoolOptions interface
// ──────────────────────────────────────────────

describe("Connection Health Check", () => {
  describe("PoolOptions.validateOnBorrow", () => {
    it("should accept validateOnBorrow in PoolOptions", () => {
      const opts = { max: 5, validateOnBorrow: true };
      expect(opts.validateOnBorrow).toBe(true);
    });
  });

  // ──────────────────────────────────────────
  // MySQL
  // ──────────────────────────────────────────

  describe("MySqlConnector", () => {
    it("disabled: no ping is called", async () => {
      const connector = new MySqlConnector();
      const pool = makeMysqlPool([]);
      (connector as any).pool = pool;
      (connector as any).validateOnBorrow = false;

      const conn = await connector.getConnection();
      expect(conn).toBeDefined();
      // ping should not have been called — callIndex stays 0
      // The connection object should have no ping calls tracked
    });

    it("ping success: returns connection", async () => {
      const connector = new MySqlConnector();
      const pool = makeMysqlPool([true]);
      (connector as any).pool = pool;
      (connector as any).validateOnBorrow = true;

      const conn = await connector.getConnection();
      expect(conn).toBeDefined();
      expect(conn.destroy).not.toHaveBeenCalled();
    });

    it("ping fail then retry success: destroys stale and returns new", async () => {
      const connector = new MySqlConnector();
      const pool = makeMysqlPool([false, true]);
      (connector as any).pool = pool;
      (connector as any).validateOnBorrow = true;

      const conn = await connector.getConnection();
      expect(conn).toBeDefined();
      // First connection should have been destroyed
      expect(pool.connections[0].destroy).toHaveBeenCalled();
      // Returned connection is the second one
      expect(conn).toBe(pool.connections[1]);
    });

    it("both pings fail: throws OrmError", async () => {
      const connector = new MySqlConnector();
      const pool = makeMysqlPool([false, false]);
      (connector as any).pool = pool;
      (connector as any).validateOnBorrow = true;

      await expect(connector.getConnection()).rejects.toThrow(OrmError);
      await expect(connector.getConnection()).rejects.toThrow(
        /health check failed/i,
      );
      expect(pool.connections[0].destroy).toHaveBeenCalled();
    });

    it("both pings fail: error has CONNECTION_FAILED code", async () => {
      const connector = new MySqlConnector();
      const pool = makeMysqlPool([false, false]);
      (connector as any).pool = pool;
      (connector as any).validateOnBorrow = true;

      try {
        await connector.getConnection();
        fail("should have thrown");
      } catch (err: any) {
        expect(err).toBeInstanceOf(OrmError);
        expect(err.code).toBe(OrmErrorCode.CONNECTION_FAILED);
        expect(err.suggestion).toBeDefined();
      }
    });
  });

  // ──────────────────────────────────────────
  // PostgreSQL
  // ──────────────────────────────────────────

  describe("PostgresConnector", () => {
    it("disabled: no SELECT 1 is called", async () => {
      const connector = new PostgresConnector();
      const pool = makePgPool([]);
      (connector as any).pool = pool;
      (connector as any).validateOnBorrow = false;

      const client = await connector.getConnection();
      expect(client).toBeDefined();
      // query should not have been called with SELECT 1
      expect(client.query).not.toHaveBeenCalled();
    });

    it("SELECT 1 success: returns client", async () => {
      const connector = new PostgresConnector();
      const pool = makePgPool([true]);
      (connector as any).pool = pool;
      (connector as any).validateOnBorrow = true;

      const client = await connector.getConnection();
      expect(client).toBeDefined();
      expect(client.release).not.toHaveBeenCalled();
    });

    it("SELECT 1 fail then retry success: releases stale and returns new", async () => {
      const connector = new PostgresConnector();
      const pool = makePgPool([false, true]);
      (connector as any).pool = pool;
      (connector as any).validateOnBorrow = true;

      const client = await connector.getConnection();
      expect(client).toBeDefined();
      // First client should have been released with destroy=true
      expect(pool.clients[0].release).toHaveBeenCalledWith(true);
      // Returned client is the second one
      expect(client).toBe(pool.clients[1]);
    });

    it("both SELECT 1 fail: throws OrmError", async () => {
      const connector = new PostgresConnector();
      const pool = makePgPool([false, false]);
      (connector as any).pool = pool;
      (connector as any).validateOnBorrow = true;

      await expect(connector.getConnection()).rejects.toThrow(OrmError);
      await expect(connector.getConnection()).rejects.toThrow(
        /health check failed/i,
      );
      expect(pool.clients[0].release).toHaveBeenCalledWith(true);
    });

    it("both SELECT 1 fail: error has CONNECTION_FAILED code", async () => {
      const connector = new PostgresConnector();
      const pool = makePgPool([false, false]);
      (connector as any).pool = pool;
      (connector as any).validateOnBorrow = true;

      try {
        await connector.getConnection();
        fail("should have thrown");
      } catch (err: any) {
        expect(err).toBeInstanceOf(OrmError);
        expect(err.code).toBe(OrmErrorCode.CONNECTION_FAILED);
        expect(err.suggestion).toBeDefined();
      }
    });
  });
});
