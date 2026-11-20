/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { MySqlDataSource } from "../../src/dialects/mysql/MySqlDataSource";
import { PostgresDataSource } from "../../src/dialects/postgres/PostgresDataSource";
import { IConnector } from "../../src/core/IConnector";

/**
 * A failed COMMIT ends the transaction: the connector rolls it back and
 * releases the connection. The ROLLBACK the transaction runner issues next
 * has nothing to do, so it must not fail on the released connection — that
 * reported every COMMIT failure (a deferred constraint, a serialization
 * failure) as "rollback also failed".
 */
describe.each([
  ["PostgresDataSource", (c: IConnector) => new PostgresDataSource(c)],
  ["MySqlDataSource", (c: IConnector) => new MySqlDataSource(c)],
] as const)("%s: rollback after COMMIT", (_name, create) => {
  function connector(commitError?: Error) {
    return {
      getConnection: jest.fn().mockResolvedValue({ release: jest.fn() }),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commit: commitError
        ? jest.fn().mockRejectedValue(commitError)
        : jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(),
    } as any;
  }

  it("resolves without another ROLLBACK when COMMIT failed", async () => {
    const commitError = new Error("deferred constraint failed");
    const c = connector(commitError);
    const ds = create(c);
    await ds.createConnection();
    await ds.startTransaction();

    await expect(ds.commit()).rejects.toBe(commitError);
    await expect(ds.rollback()).resolves.toBeUndefined();
    expect(c.rollback).not.toHaveBeenCalled();
  });

  it("still fails a ROLLBACK on a session that never connected", async () => {
    const ds = create(connector());

    await expect(ds.rollback()).rejects.toThrow();
  });

  it("fails a ROLLBACK again once a new connection replaced the committed one and was released", async () => {
    const c = connector(new Error("commit failed"));
    const ds = create(c);
    await ds.createConnection();
    await expect(ds.commit()).rejects.toThrow("commit failed");

    await ds.createConnection();
    await ds.close();

    await expect(ds.rollback()).rejects.toThrow();
  });
});
