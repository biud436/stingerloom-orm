import { DbVersion } from "../../src/dialects/DbVersion";

describe("DbVersion", () => {
  describe("parse", () => {
    it("should parse simple dotted version", () => {
      const v = DbVersion.parse("8.0.16");
      expect(v.major).toBe(8);
      expect(v.minor).toBe(0);
      expect(v.patch).toBe(16);
      expect(v.raw).toBe("8.0.16");
    });

    it("should parse two-part version as x.y.0", () => {
      const v = DbVersion.parse("15.4");
      expect(v.major).toBe(15);
      expect(v.minor).toBe(4);
      expect(v.patch).toBe(0);
    });

    it("should parse MySQL community version string", () => {
      const v = DbVersion.parse("8.0.16-MySQL Community Server - GPL");
      expect(v.major).toBe(8);
      expect(v.minor).toBe(0);
      expect(v.patch).toBe(16);
    });

    it("should parse MySQL 5.7 version string", () => {
      const v = DbVersion.parse("5.7.44-log");
      expect(v.major).toBe(5);
      expect(v.minor).toBe(7);
      expect(v.patch).toBe(44);
    });

    it("should parse MariaDB version string", () => {
      const v = DbVersion.parse("10.6.12-MariaDB");
      expect(v.major).toBe(10);
      expect(v.minor).toBe(6);
      expect(v.patch).toBe(12);
    });

    it("should parse PostgreSQL version string", () => {
      const v = DbVersion.parse(
        "PostgreSQL 15.4 (Ubuntu 15.4-2.pgdg22.04+1)",
      );
      expect(v.major).toBe(15);
      expect(v.minor).toBe(4);
      expect(v.patch).toBe(0);
    });

    it("should parse PostgreSQL older version string", () => {
      const v = DbVersion.parse(
        "PostgreSQL 9.6.24 on x86_64-pc-linux-gnu",
      );
      expect(v.major).toBe(9);
      expect(v.minor).toBe(6);
      expect(v.patch).toBe(24);
    });

    it("should parse SQLite version string", () => {
      const v = DbVersion.parse("3.39.0");
      expect(v.major).toBe(3);
      expect(v.minor).toBe(39);
      expect(v.patch).toBe(0);
    });

    it("should return UNKNOWN for empty string", () => {
      expect(DbVersion.parse("")).toBe(DbVersion.UNKNOWN);
    });

    it('should return UNKNOWN for "unknown"', () => {
      expect(DbVersion.parse("unknown")).toBe(DbVersion.UNKNOWN);
    });

    it("should return UNKNOWN for unparseable string", () => {
      expect(DbVersion.parse("not-a-version")).toBe(DbVersion.UNKNOWN);
    });
  });

  describe("isMariaDb", () => {
    it("should detect MariaDB from version string", () => {
      expect(DbVersion.isMariaDb("10.6.12-MariaDB")).toBe(true);
    });

    it("should detect MariaDB case-insensitively", () => {
      expect(DbVersion.isMariaDb("10.6.12-mariadb-log")).toBe(true);
    });

    it("should return false for MySQL", () => {
      expect(DbVersion.isMariaDb("8.0.16-MySQL Community")).toBe(false);
    });

    it("should return false for plain version", () => {
      expect(DbVersion.isMariaDb("8.0.16")).toBe(false);
    });
  });

  describe("gte", () => {
    const v = new DbVersion(8, 0, 16, "8.0.16");

    it("should return true for equal version", () => {
      expect(v.gte(8, 0, 16)).toBe(true);
    });

    it("should return true for lower version", () => {
      expect(v.gte(8, 0, 0)).toBe(true);
      expect(v.gte(7, 0, 0)).toBe(true);
      expect(v.gte(8, 0, 15)).toBe(true);
    });

    it("should return false for higher version", () => {
      expect(v.gte(8, 0, 17)).toBe(false);
      expect(v.gte(8, 1, 0)).toBe(false);
      expect(v.gte(9, 0, 0)).toBe(false);
    });

    it("should default minor and patch to 0", () => {
      expect(v.gte(8)).toBe(true);
      expect(v.gte(9)).toBe(false);
    });
  });

  describe("lt", () => {
    const v = new DbVersion(5, 7, 0, "5.7.0");

    it("should return true for higher version", () => {
      expect(v.lt(8, 0, 0)).toBe(true);
    });

    it("should return false for equal version", () => {
      expect(v.lt(5, 7, 0)).toBe(false);
    });

    it("should return false for lower version", () => {
      expect(v.lt(5, 6, 0)).toBe(false);
    });
  });

  describe("UNKNOWN", () => {
    it("should have Infinity for all parts", () => {
      expect(DbVersion.UNKNOWN.major).toBe(Infinity);
      expect(DbVersion.UNKNOWN.minor).toBe(Infinity);
      expect(DbVersion.UNKNOWN.patch).toBe(Infinity);
    });

    it("should gte any version", () => {
      expect(DbVersion.UNKNOWN.gte(999, 999, 999)).toBe(true);
      expect(DbVersion.UNKNOWN.gte(0, 0, 0)).toBe(true);
    });

    it("should never be lt any version", () => {
      expect(DbVersion.UNKNOWN.lt(999, 999, 999)).toBe(false);
    });

    it('should have raw "unknown"', () => {
      expect(DbVersion.UNKNOWN.raw).toBe("unknown");
    });
  });

  describe("toString", () => {
    it("should format as major.minor.patch", () => {
      expect(new DbVersion(8, 0, 16, "").toString()).toBe("8.0.16");
    });

    it("should handle UNKNOWN with Infinity", () => {
      expect(DbVersion.UNKNOWN.toString()).toBe("Infinity.Infinity.Infinity");
    });
  });
});
