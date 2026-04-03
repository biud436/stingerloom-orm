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
