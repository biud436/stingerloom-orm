/* eslint-disable @typescript-eslint/no-explicit-any */

import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";
import { VALID_DB_TYPES } from "../core/DatabaseClientOptions";

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
 *
 * The resolved object's `type` is checked here, at the point where the config
 * path is still known. Left to `DatabaseClient.connect()`, an unusable config
 * surfaced as a bare `NotSupportedDatabaseTypeError` with neither the offending
 * value, the list of supported types, nor the file it came from — while the
 * message that does list them (`MigrationCli.connect()`) was unreachable.
 */
export function resolveDbOptions(config: any, configPath?: string): any {
  const options =
    config.connection ??
    (typeof config.database === "object" && config.database !== null
      ? config.database
      : config);

  assertUsableDbOptions(options, configPath);

  return options;
}

function assertUsableDbOptions(options: any, configPath?: string): void {
  const source = configPath ? ` in ${configPath}` : "";

  if (!options || typeof options !== "object") {
    throw new OrmError(
      OrmErrorCode.INVALID_CONFIG,
      `Config error${source}: expected an options object, got ${options === null ? "null" : typeof options}.`,
      'Export the connection options: export default { type: "postgres", host: "localhost", database: "mydb" }',
    );
  }

  if (!options.type) {
    throw new OrmError(
      OrmErrorCode.INVALID_CONFIG,
      `Config error${source}: "type" is required. Supported types: ${VALID_DB_TYPES.join(", ")}.`,
      'Set it on the connection options: { type: "postgres", ... } — or nest them under `connection`.',
    );
  }

  if (!VALID_DB_TYPES.includes(options.type)) {
    throw new OrmError(
      OrmErrorCode.INVALID_CONFIG,
      `Config error${source}: unsupported database type "${options.type}". Supported types: ${VALID_DB_TYPES.join(", ")}.`,
    );
  }
}
