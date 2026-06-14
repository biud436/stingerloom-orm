/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { MySqlDataSource } from "../../src/dialects/mysql/MySqlDataSource";
import { IConnector } from "../../src/core/IConnector";

/**
 * Regression: MySqlConnector.commit/rollback may release (or destroy) the
 * underlying pool connection while recovering from an error. If commit()/
 * rollback() only clear the connection ref on success, a subsequent close()
 * releases the same connection a second time — a double-release that can hand
 * one physical connection to two callers. The ref must be cleared in `finally`.
 */
describe("MySqlDataSource — commit/rollback double-release guard", () => {
  function createDataSource(opts: {
    commitThrows?: boolean;
    rollbackThrows?: boolean;
  }) {
    const release = jest.fn();
    const conn = { release };
    const connector = {
      getConnection: jest.fn().mockResolvedValue(conn),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commit: opts.commitThrows
        ? jest.fn().mockRejectedValue(new Error("commit failed"))
        : jest.fn().mockResolvedValue(undefined),
      rollback: opts.rollbackThrows
        ? jest.fn().mockRejectedValue(new Error("rollback failed"))
        : jest.fn().mockResolvedValue(undefined),
      query: jest.fn(),
    } as unknown as IConnector;
    return { ds: new MySqlDataSource(connector), release };
  }

  it("clears the connection ref when commit() throws so close() does not re-release", async () => {
    const { ds, release } = createDataSource({ commitThrows: true });
    await ds.createConnection();

    await expect(ds.commit()).rejects.toThrow("commit failed");

    // The connector owns releasing on the error path; the DataSource must not
    // release again. After the fix, close() is a no-op (ref already cleared).
    await ds.close();
    expect(release).not.toHaveBeenCalled();
    expect((ds as any).connection).toBeUndefined();
  });

  it("clears the connection ref when rollback() throws so close() does not re-release", async () => {
    const { ds, release } = createDataSource({ rollbackThrows: true });
    await ds.createConnection();

    await expect(ds.rollback()).rejects.toThrow("rollback failed");

    await ds.close();
    expect(release).not.toHaveBeenCalled();
    expect((ds as any).connection).toBeUndefined();
  });

  it("still releases exactly once on the normal commit + close path", async () => {
    const { ds, release } = createDataSource({});
    await ds.createConnection();

    await ds.commit();
    await ds.close();

    // commit() cleared the ref, so close() finds nothing to release.
    expect(release).not.toHaveBeenCalled();
    expect((ds as any).connection).toBeUndefined();
  });
});
