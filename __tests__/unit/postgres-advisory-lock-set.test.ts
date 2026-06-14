/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { PostgresDriver } from "../../src/dialects/postgres/PostgresDriver";
import { IConnector } from "../../src/core/IConnector";

/**
 * Regression: PostgreSQL rejects bind parameters in SET, so the timed advisory
 * lock must interpolate `statement_timeout` as a literal — not send it as a
 * parameterized `sql\`SET statement_timeout = ${value}\``, which raises
 * "syntax error at or near $1" and makes timed lock acquisition always throw.
 */
describe("PostgresDriver.acquireAdvisoryLock — SET statement_timeout literal", () => {
  function createRecordingConnector() {
    const queries: any[] = [];
    const release = jest.fn();
    const connector = {
      getVersion: () => undefined,
      getConnection: jest.fn().mockResolvedValue({ release }),
      query: jest.fn(async (q: any) => {
        queries.push(q);
        const text = typeof q === "string" ? q : q?.text ?? "";
        if (text.includes("SHOW")) {
          return { rows: [{ statement_timeout: "0" }] };
        }
        return { rows: [] };
      }),
    } as unknown as IConnector;
    return { connector, queries, release };
  }

  function setQueries(queries: any[]) {
    return queries.filter((q) => {
      const text = typeof q === "string" ? q : q?.text ?? "";
      return text.includes("SET statement_timeout");
    });
  }

  it("sends SET as a plain literal string with no bound parameters", async () => {
    const { connector, queries, release } = createRecordingConnector();
    const driver = new PostgresDriver(connector);

    const acquired = await driver.acquireAdvisoryLock("migration-lock", 5000);

    expect(acquired).toBe(true);

    const sets = setQueries(queries);
    // One to apply the timeout, one to restore it in the finally block.
    expect(sets.length).toBeGreaterThanOrEqual(2);
    for (const q of sets) {
      // A literal string — not a parameterized Sql object (which would carry
      // `.values` and emit `$1`, the exact thing Postgres rejects in SET).
      expect(typeof q).toBe("string");
      expect(q).not.toMatch(/\$\d/);
    }
    expect(sets[0]).toContain("'5000ms'");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("does not enter the SET path for the untimed (try) variant", async () => {
    const { connector, queries } = createRecordingConnector();
    (connector.query as jest.Mock).mockImplementation(async (q: any) => {
      queries.push(q);
      return { rows: [{ lock_result: true }] };
    });
    const driver = new PostgresDriver(connector);

    const acquired = await driver.acquireAdvisoryLock("lock", 0);

    expect(acquired).toBe(true);
    expect(setQueries(queries)).toHaveLength(0);
  });
});
