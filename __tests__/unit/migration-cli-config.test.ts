/**
 * CLI config resolution (`stingerloom migrate:*` / `introspect`).
 *
 * The CLI previously read `config.database ?? config`, which turned a flat
 * config's scalar `database` field ("mydb" / "./app.sqlite") into the whole
 * options object and failed with "Unsupported database type" — and never
 * read the documented `{ connection: {...} }` shape at all.
 */
import { resolveDbOptions } from "../../src/migration/cli-config";

describe("resolveDbOptions", () => {
  it("reads the documented { connection: {...} } shape", () => {
    const connection = { type: "postgres", host: "localhost", database: "mydb" };
    expect(resolveDbOptions({ connection, migrations: [] })).toBe(connection);
  });

  it("passes a flat config through even when `database` is a string", () => {
    const config = { type: "sqlite", database: "./app.sqlite", migrations: [] };
    expect(resolveDbOptions(config)).toBe(config);
  });

  it("passes a flat server config through (database = DB name)", () => {
    const config = { type: "mysql", host: "db", database: "prod", migrations: [] };
    expect(resolveDbOptions(config)).toBe(config);
  });

  it("still accepts the legacy nested { database: {...} } shape", () => {
    const database = { type: "postgres", host: "localhost" };
    expect(resolveDbOptions({ database })).toBe(database);
  });

  it("prefers `connection` over a nested `database` object", () => {
    const connection = { type: "sqlite", database: ":memory:" };
    const database = { type: "mysql" };
    expect(resolveDbOptions({ connection, database })).toBe(connection);
  });

  it("treats database: null as a flat config", () => {
    const config = { type: "sqlite", database: null };
    expect(resolveDbOptions(config)).toBe(config);
  });
});
