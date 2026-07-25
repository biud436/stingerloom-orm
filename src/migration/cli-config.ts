/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Resolves the database options object from a loaded CLI config file.
 *
 * Accepted shapes:
 * - Documented: `{ connection: { type, host, ... }, migrations: [...] }`
 * - Flat `DatabaseClientOptions`: `{ type, database: "mydb", ... }`
 * - Legacy nested: `{ database: { type, ... } }`
 *
 * A flat config's scalar `database` field (a DB name or SQLite file path)
 * must never be mistaken for the options object — that used to turn
 * `{ type: "sqlite", database: "./app.sqlite" }` into the string
 * `"./app.sqlite"` and fail with "Unsupported database type".
 */
export function resolveDbOptions(config: any): any {
  return (
    config.connection ??
    (typeof config.database === "object" && config.database !== null
      ? config.database
      : config)
  );
}
