/**
 * Represents a parsed database server version.
 *
 * Used to compare version numbers and gate DDL features that require
 * a minimum database version (e.g. MySQL 8.0.16+ for CHECK constraints).
 */
export class DbVersion {
  constructor(
    readonly major: number,
    readonly minor: number,
    readonly patch: number,
    /** The original, unparsed version string returned by the server. */
    readonly raw: string,
  ) {}

  /** Returns true if this version is >= the given version. */
  gte(major: number, minor = 0, patch = 0): boolean {
    if (this.major !== major) return this.major > major;
    if (this.minor !== minor) return this.minor > minor;
    return this.patch >= patch;
  }

  /** Returns true if this version is < the given version. */
  lt(major: number, minor = 0, patch = 0): boolean {
    return !this.gte(major, minor, patch);
  }

  toString(): string {
    return `${this.major}.${this.minor}.${this.patch}`;
  }

  /**
   * Parses a version string into a DbVersion instance.
   *
   * Handles various formats:
   * - Plain: "8.0.16", "3.39.0"
   * - MySQL/MariaDB: "8.0.16-MySQL Community Server", "10.6.12-MariaDB"
   * - PostgreSQL: "PostgreSQL 15.4 (Ubuntu 15.4-2.pgdg22.04+1)"
   * - Two-part: "15.4" → treated as "15.4.0"
   *
   * Returns `DbVersion.UNKNOWN` if the string cannot be parsed.
   */
  static parse(versionString: string): DbVersion {
    if (!versionString || versionString === "unknown") {
      return DbVersion.UNKNOWN;
    }

    const raw = versionString.trim();

    // PostgreSQL: "PostgreSQL 15.4 (...)" → extract "15.4"
    const pgMatch = raw.match(/^PostgreSQL\s+(\d+(?:\.\d+)*)/i);
    if (pgMatch) {
      return DbVersion.fromDotted(pgMatch[1], raw);
    }

    // Generic: extract first version-like sequence (digits and dots)
    // Handles: "8.0.16", "8.0.16-MySQL Community", "10.6.12-MariaDB", "3.39.0"
    const genericMatch = raw.match(/(\d+(?:\.\d+)*)/);
    if (genericMatch) {
      return DbVersion.fromDotted(genericMatch[1], raw);
    }

    return DbVersion.UNKNOWN;
  }

  /**
   * Detects whether the raw version string indicates a MariaDB server.
   */
  static isMariaDb(versionString: string): boolean {
    return /mariadb/i.test(versionString);
  }

  /** Builds a DbVersion from a dotted string like "8.0.16" or "15.4". */
  private static fromDotted(dotted: string, raw: string): DbVersion {
    const parts = dotted.split(".").map(Number);
    return new DbVersion(
      parts[0] ?? 0,
      parts[1] ?? 0,
      parts[2] ?? 0,
      raw,
    );
  }

  /**
   * Sentinel for unknown/undetected versions.
   * Uses Infinity so that gte() always returns true — all features are
   * assumed available. This preserves backward compatibility: existing
   * code without version detection behaves exactly as before.
   */
  static readonly UNKNOWN = new DbVersion(
    Infinity,
    Infinity,
    Infinity,
    "unknown",
  );
}

/**
 * Reads the server version through `detect`. A failure, or a reply that
 * does not read as a version, is reported through `warn` and yields
 * {@link DbVersion.UNKNOWN} — under which every version-gated feature is
 * assumed available, so the warning names `versionOverride` as the way to
 * pin it.
 *
 * @param server - The database named in the warning ("MySQL", ...).
 */
export async function detectDbVersion(
  detect: () => Promise<unknown>,
  warn: (message: string) => void,
  server: string,
): Promise<DbVersion> {
  const consequence =
    "every version-gated feature is assumed available. Set versionOverride to the server's version to pin it.";
  let raw: unknown;
  try {
    raw = await detect();
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    warn(`Could not read the ${server} server version (${reason}); ${consequence}`);
    return DbVersion.UNKNOWN;
  }
  const version = DbVersion.parse(typeof raw === "string" ? raw : "");
  if (version === DbVersion.UNKNOWN) {
    warn(
      `The ${server} server reported the version ${JSON.stringify(raw ?? null)}, which does not read as one; ${consequence}`,
    );
  }
  return version;
}
