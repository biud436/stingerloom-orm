/**
 * Issue #287 — SQLite executeRaw must classify statements via Statement.reader
 * rather than prefix-string matching, so leading comments and CTE-prefixed
 * writes route to the correct better-sqlite3 entry point.
 *
 * Runs in unit mode (no external DB; better-sqlite3 is in-memory).
 */

import "reflect-metadata";
import { SqliteConnector } from "../../src/dialects/sqlite/SqliteConnector";
import { SqliteDriver } from "../../src/dialects/sqlite/SqliteDriver";
import { DatabaseClientOptions } from "../../src/core/DatabaseClientOptions";
import sqlTag from "sql-template-tag";

describe("SqliteConnector.executeRaw classifier (#287)", () => {
  let connector: SqliteConnector;
  let driver: SqliteDriver;

  beforeAll(async () => {
    connector = new SqliteConnector();
    await connector.connect({
      type: "sqlite",
      database: ":memory:",
      logging: false,
    } as DatabaseClientOptions);
    driver = new SqliteDriver(connector);

    await connector.query("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
    await connector.query("CREATE TABLE stale (id INTEGER PRIMARY KEY)");
    await connector.query("INSERT INTO users (id, name) VALUES (1, 'Alice'), (2, 'Bob'), (3, 'Carol')");
    await connector.query("INSERT INTO stale (id) VALUES (1), (2)");
  });

  afterAll(async () => {
    await connector.close();
  });

  // ──────────────────────────────────────────────
  // Leading-comment SELECTs (previously misclassified as writes)
  // ──────────────────────────────────────────────

  it("returns rows for a SELECT prefixed with a /* */ comment", async () => {
    const rows = await connector.query("/* hint */ SELECT id, name FROM users ORDER BY id");
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ id: 1, name: "Alice" });
  });

  it("returns rows for a SELECT prefixed with a -- line comment", async () => {
    const rows = await connector.query(
      "-- query comment\nSELECT id FROM users WHERE id = 2",
    );
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(2);
  });

  // ──────────────────────────────────────────────
  // CTE-prefixed writes (previously misclassified as reads)
  // ──────────────────────────────────────────────

  it("runs a WITH ... DELETE without throwing and returns a RunResult-shaped value", async () => {
    const result: any = await connector.query(
      "WITH s AS (SELECT id FROM stale WHERE id = 1) " +
        "DELETE FROM users WHERE id IN (SELECT id FROM s)",
    );
    expect(result).toBeDefined();
    expect(typeof result.changes).toBe("number");
    expect(result.changes).toBe(1);

    const remaining = await connector.query("SELECT COUNT(*) AS c FROM users");
    expect(remaining[0].c).toBe(2);
  });

  it("runs a WITH ... UPDATE without throwing", async () => {
    const result: any = await connector.query(
      "WITH t AS (SELECT 'Renamed' AS name) " +
        "UPDATE users SET name = (SELECT name FROM t) WHERE id = 2",
    );
    expect(typeof result.changes).toBe("number");
    expect(result.changes).toBe(1);

    const rows = await connector.query(
      "SELECT name FROM users WHERE id = 2",
    );
    expect(rows[0].name).toBe("Renamed");
  });

  // ──────────────────────────────────────────────
  // Regression: vanilla statements still work
  // ──────────────────────────────────────────────

  it("plain SELECT still returns rows", async () => {
    const rows = await connector.query("SELECT id FROM users WHERE id = 3");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(3);
  });

  it("plain INSERT still returns a RunResult", async () => {
    const result: any = await connector.query(
      "INSERT INTO users (id, name) VALUES (10, 'Dave')",
    );
    expect(typeof result.changes).toBe("number");
    expect(result.changes).toBe(1);
  });

  // ──────────────────────────────────────────────
  // SqliteDriver.queryWithOptions parity (#287)
  // ──────────────────────────────────────────────

  it("queryWithOptions handles a CTE-prefixed write without throwing", async () => {
    const result = await driver.queryWithOptions(
      sqlTag`WITH s AS (SELECT id FROM stale WHERE id = 2) DELETE FROM stale WHERE id IN (SELECT id FROM s)`,
      { arrayMode: false },
    );
    // Wrapped as [RunResult] so the return type stays Array-like.
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(typeof (result[0] as any).changes).toBe("number");
    expect((result[0] as any).changes).toBe(1);
  });

  it("queryWithOptions returns rows for a SELECT (regression)", async () => {
    const rows = await driver.queryWithOptions(
      sqlTag`SELECT id FROM users ORDER BY id`,
      { arrayMode: false },
    );
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});
