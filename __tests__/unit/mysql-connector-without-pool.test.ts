import { MySqlConnector } from "../../src/dialects/mysql/MySqlConnector";
import { PoolNotFound } from "../../src/dialects/mysql/PoolNotFound";

// Both returned from inside their promise when no pool existed, so the
// promise never settled: query() before connect() and a second close() hung.
describe("MySqlConnector without a pool", () => {
  it("rejects query() instead of leaving it pending", async () => {
    await expect(new MySqlConnector().query("SELECT 1")).rejects.toBeInstanceOf(PoolNotFound);
  });

  it("resolves close()", async () => {
    await expect(new MySqlConnector().close()).resolves.toBeUndefined();
  });
});
