import { OrmError } from "./OrmError";
import { OrmErrorCode } from "./OrmErrorCode";

/**
 * Thrown when a DDL operation requires a database feature that is not
 * available in the connected database version.
 *
 * Provides a human-readable message with the required version and an
 * actionable suggestion to upgrade.
 *
 * @example
 * throw new UnsupportedFeatureError(
 *   "ALTER TABLE DROP COLUMN",
 *   "SQLite 3.35.0+",
 *   "3.24.0",
 * );
 * // → OrmError: ALTER TABLE DROP COLUMN requires SQLite 3.35.0+, but connected to 3.24.0
 * // → suggestion: Upgrade your database to SQLite 3.35.0+ or later
 */
export class UnsupportedFeatureError extends OrmError {
  constructor(
    featureName: string,
    requiredVersion: string,
    currentVersion: string,
  ) {
    super(
      OrmErrorCode.UNSUPPORTED_OPERATION,
      `${featureName} requires ${requiredVersion}, but connected to ${currentVersion}`,
      `Upgrade your database to ${requiredVersion} or later`,
    );
    this.name = "UnsupportedFeatureError";
  }
}
