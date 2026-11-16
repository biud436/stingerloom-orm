/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A refused connection fails register(), and a connection failure reaches
 * the caller as `ORM_CONNECTION_FAILED` with the driver error as its cause
 * (MySQL/MariaDB + PostgreSQL).
 *
 * register() used to succeed against a server that was down or refused the
 * login: the only connection it opened read the server version, and a
 * failed version read is only a warning. `retry` therefore never retried,
 * and every query after boot failed instead. A pool that ran out of
 * connections was reported as "Transaction failed and rollback also failed"
 * about a transaction that never began.
 */
import "reflect-metadata";
import { getTestDrivers, type TestDriverConfig } from "./helpers/driver-config";
import { EntityManager } from "../../src/core/EntityManager";
import { MySqlConnector } from "../../src/dialects/mysql/MySqlConnector";
import { PostgresConnector } from "../../src/dialects/postgres/PostgresConnector";
import { DatabaseConnectionFailedError } from "../../src/errors/DatabaseConnectionFailedError";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";

const rejectionOf = async (work: () => Promise<unknown>): Promise<any> => {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
};

describe.each(getTestDrivers())(
  "[Integration] $label: connection failures",
  ({ type, options }: TestDriverConfig) => {
    const open: EntityManager[] = [];
    let seq = 0;

    afterEach(async () => {
      jest.restoreAllMocks();
      for (const em of open.splice(0)) await em.propagateShutdown().catch(() => undefined);
    });

    const register = async (overrides: Record<string, unknown>) => {
      const em = new EntityManager();
      open.push(em);
      await em.register(
        {
          ...options,
          entities: [],
          synchronize: false,
          logging: false,
          ...overrides,
        } as any,
        `cfd_${type}_${++seq}`,
      );
      return em;
    };

    it("fails register() when the database does not exist, keeping the driver error", async () => {
      const error = await rejectionOf(() => register({ database: "cfd_no_such_database" }));

      expect(error).toBeInstanceOf(OrmError);
      expect(error.code).toBe(OrmErrorCode.CONNECTION_FAILED);
      expect(error.cause).toMatchObject({
        code: type === "postgres" ? "3D000" : "ER_BAD_DB_ERROR",
      });
    });

    it("retries a refused connection as many times as retry asks", async () => {
      const Connector: any = type === "postgres" ? PostgresConnector : MySqlConnector;
      const attempts = jest.spyOn(Connector.prototype, "connect");

      const error = await rejectionOf(() =>
        register({ host: "127.0.0.1", port: 1, retry: { maxAttempts: 2, backoffMs: 10 } }),
      );

      expect(attempts).toHaveBeenCalledTimes(2);
      expect(error.code).toBe(OrmErrorCode.CONNECTION_FAILED);
      expect(error.cause).toMatchObject({ code: "ECONNREFUSED" });
    });

    it("still boots and queries against a reachable server", async () => {
      const em = await register({});

      expect(await em.query("SELECT 1 AS one")).toEqual([{ one: 1 }]);
    });

    if (type === "postgres") {
      it("reports an exhausted pool as a connection failure and leaves the holder's transaction alone", async () => {
        const em = await register({ pool: { max: 1, acquireTimeoutMs: 300 } });
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        const holder = em.transaction(async (tx) => {
          await tx.query("SELECT 1");
          await held;
          return "committed";
        });
        await new Promise((resolve) => setTimeout(resolve, 100));

        const error = await rejectionOf(() => em.query("SELECT 1"));
        release();

        expect(error).toBeInstanceOf(DatabaseConnectionFailedError);
        expect(error.code).toBe(OrmErrorCode.CONNECTION_FAILED);
        expect((error.cause as Error).message).toContain("timeout exceeded when trying to connect");
        expect(await holder).toBe("committed");
      });
    }
  },
);
