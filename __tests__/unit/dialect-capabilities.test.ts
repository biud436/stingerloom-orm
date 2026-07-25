import { DbVersion } from "../../src/dialects/DbVersion";
import {
  resolveMySqlCapabilities,
  resolvePostgresCapabilities,
  resolveSqliteCapabilities,
} from "../../src/dialects/resolveCapabilities";
import { ALL_MYSQL, ALL_POSTGRES, ALL_SQLITE } from "../../src/dialects/DialectCapabilities";
import { UnsupportedFeatureError } from "../../src/errors/UnsupportedFeatureError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";

describe("resolveMySqlCapabilities", () => {
  describe("MySQL 5.7.0", () => {
    const caps = resolveMySqlCapabilities(DbVersion.parse("5.7.0"), false);

    it("should not support CHECK constraints", () => {
      expect(caps.supportsCheckConstraints).toBe(false);
    });

    it("should not support DEFAULT expressions", () => {
      expect(caps.supportsDefaultExpression).toBe(false);
    });

    it("should not support generated columns (< 5.7.6)", () => {
      expect(caps.supportsGeneratedColumns).toBe(false);
    });

    it("should not support JSON column type (< 5.7.8)", () => {
      expect(caps.supportsJsonColumnType).toBe(false);
    });

    it("should not support RENAME COLUMN", () => {
      expect(caps.supportsRenameColumn).toBe(false);
    });

    it("should not support invisible columns", () => {
      expect(caps.supportsInvisibleColumns).toBe(false);
    });

    it("should not support RETURNING", () => {
      expect(caps.supportsReturning).toBe(false);
    });
  });

  describe("MySQL 5.7.8", () => {
    const caps = resolveMySqlCapabilities(DbVersion.parse("5.7.8"), false);

    it("should support generated columns (5.7.6+)", () => {
      expect(caps.supportsGeneratedColumns).toBe(true);
    });

    it("should support JSON column type (5.7.8+)", () => {
      expect(caps.supportsJsonColumnType).toBe(true);
    });

    it("should still not support CHECK constraints", () => {
      expect(caps.supportsCheckConstraints).toBe(false);
    });
  });

  describe("MySQL 8.0.0", () => {
    const caps = resolveMySqlCapabilities(DbVersion.parse("8.0.0"), false);

    it("should support RENAME COLUMN (8.0+)", () => {
      expect(caps.supportsRenameColumn).toBe(true);
    });

    it("should not yet support CHECK constraints (< 8.0.16)", () => {
      expect(caps.supportsCheckConstraints).toBe(false);
    });

    it("should not yet support DEFAULT expressions (< 8.0.13)", () => {
      expect(caps.supportsDefaultExpression).toBe(false);
    });
  });

  describe("MySQL 8.0.16", () => {
    const caps = resolveMySqlCapabilities(DbVersion.parse("8.0.16"), false);

    it("should support CHECK constraints (8.0.16+)", () => {
      expect(caps.supportsCheckConstraints).toBe(true);
    });

    it("should support DEFAULT expressions (8.0.13+)", () => {
      expect(caps.supportsDefaultExpression).toBe(true);
    });

    it("should support invisible columns (8.0.23+) — not yet", () => {
      expect(caps.supportsInvisibleColumns).toBe(false);
    });
  });

  describe("MySQL 8.0.23", () => {
    const caps = resolveMySqlCapabilities(DbVersion.parse("8.0.23"), false);

    it("should support invisible columns (8.0.23+)", () => {
      expect(caps.supportsInvisibleColumns).toBe(true);
    });
  });

  describe("MySQL common flags", () => {
    const caps = resolveMySqlCapabilities(DbVersion.parse("8.0.40"), false);

    it("should not support RETURNING", () => {
      expect(caps.supportsReturning).toBe(false);
    });

    it("should support DROP COLUMN", () => {
      expect(caps.supportsDropColumn).toBe(true);
    });

    it("should support UPSERT", () => {
      expect(caps.supportsUpsert).toBe(true);
    });

    it("should not have PG-only keys", () => {
      expect(caps).not.toHaveProperty("supportsGeneratedIdentity");
      expect(caps).not.toHaveProperty("supportsIndexInclude");
    });
  });

  describe("MariaDB 10.2.1", () => {
    const caps = resolveMySqlCapabilities(DbVersion.parse("10.2.1"), true);

    it("should support CHECK constraints (MariaDB 10.2.1+)", () => {
      expect(caps.supportsCheckConstraints).toBe(true);
    });

    it("should support DEFAULT expressions (MariaDB 10.2.1+)", () => {
      expect(caps.supportsDefaultExpression).toBe(true);
    });

    it("should not support RENAME COLUMN (< 10.5.2)", () => {
      expect(caps.supportsRenameColumn).toBe(false);
    });
  });

  describe("MariaDB 10.5.2", () => {
    const caps = resolveMySqlCapabilities(DbVersion.parse("10.5.2"), true);

    it("should support RENAME COLUMN (MariaDB 10.5.2+)", () => {
      expect(caps.supportsRenameColumn).toBe(true);
    });

    it("should support INSERT RETURNING (MariaDB 10.5.0+)", () => {
      expect(caps.supportsInsertReturning).toBe(true);
    });

    it("should still NOT support full (UPDATE) RETURNING — MariaDB only does INSERT/DELETE", () => {
      expect(caps.supportsReturning).toBe(false);
    });
  });

  describe("MariaDB 10.1.0 (old)", () => {
    const caps = resolveMySqlCapabilities(DbVersion.parse("10.1.0"), true);

    it("should not support CHECK constraints", () => {
      expect(caps.supportsCheckConstraints).toBe(false);
    });

    it("should not support JSON column type (< 10.2.7)", () => {
      expect(caps.supportsJsonColumnType).toBe(false);
    });

    it("should not support INSERT RETURNING (< 10.5)", () => {
      expect(caps.supportsInsertReturning).toBe(false);
    });

    it("should not support SEQUENCE (< 10.3)", () => {
      expect(caps.supportsSequence).toBe(false);
    });

    it("should not support SYSTEM VERSIONING (< 10.3)", () => {
      expect(caps.supportsSystemVersioning).toBe(false);
    });
  });

  describe("MariaDB 10.3.0 — MariaDB-only features light up", () => {
    const caps = resolveMySqlCapabilities(DbVersion.parse("10.3.0"), true);

    it("should support SEQUENCE (10.3+)", () => {
      expect(caps.supportsSequence).toBe(true);
    });

    it("should support SYSTEM VERSIONING (10.3+)", () => {
      expect(caps.supportsSystemVersioning).toBe(true);
    });

    it("should not yet support INSERT RETURNING (< 10.5)", () => {
      expect(caps.supportsInsertReturning).toBe(false);
    });

    it("should not yet support native UUID type (< 10.7)", () => {
      expect(caps.supportsNativeUuidType).toBe(false);
    });
  });

  describe("MariaDB 10.4.x — just before INSERT RETURNING", () => {
    const caps = resolveMySqlCapabilities(DbVersion.parse("10.4.99"), true);

    it("should not support INSERT RETURNING (< 10.5)", () => {
      expect(caps.supportsInsertReturning).toBe(false);
    });
  });

  describe("MariaDB 10.7.0 — native UUID type lights up", () => {
    const caps = resolveMySqlCapabilities(DbVersion.parse("10.7.0"), true);

    it("should support native UUID type (10.7+)", () => {
      expect(caps.supportsNativeUuidType).toBe(true);
    });

    it("should support INSERT RETURNING (10.5+)", () => {
      expect(caps.supportsInsertReturning).toBe(true);
    });
  });

  describe("MySQL 8.0.40 — MariaDB-only features stay off", () => {
    const caps = resolveMySqlCapabilities(DbVersion.parse("8.0.40"), false);

    it("should not support INSERT RETURNING (MySQL has no RETURNING)", () => {
      expect(caps.supportsInsertReturning).toBe(false);
    });

    it("should not support SEQUENCE", () => {
      expect(caps.supportsSequence).toBe(false);
    });

    it("should not support native UUID type", () => {
      expect(caps.supportsNativeUuidType).toBe(false);
    });

    it("should not support SYSTEM VERSIONING", () => {
      expect(caps.supportsSystemVersioning).toBe(false);
    });
  });
});

describe("resolvePostgresCapabilities", () => {
  describe("PostgreSQL 9.5", () => {
    const caps = resolvePostgresCapabilities(DbVersion.parse("9.5.0"));

    it("should not support IF NOT EXISTS for ADD COLUMN (< 9.6)", () => {
      expect(caps.supportsIfNotExistsAddColumn).toBe(false);
    });

    it("should not support GENERATED IDENTITY (< 10)", () => {
      expect(caps.supportsGeneratedIdentity).toBe(false);
    });

    it("should not support RENAME ENUM VALUE (< 10)", () => {
      expect(caps.supportsRenameEnumValue).toBe(false);
    });
  });

  describe("PostgreSQL 9.6", () => {
    const caps = resolvePostgresCapabilities(DbVersion.parse("9.6.0"));

    it("should support IF NOT EXISTS for ADD COLUMN (9.6+)", () => {
      expect(caps.supportsIfNotExistsAddColumn).toBe(true);
    });
  });

  describe("PostgreSQL 10", () => {
    const caps = resolvePostgresCapabilities(
      DbVersion.parse("PostgreSQL 10.0 on x86_64"),
    );

    it("should support GENERATED IDENTITY (10+)", () => {
      expect(caps.supportsGeneratedIdentity).toBe(true);
    });

    it("should support RENAME ENUM VALUE (10+)", () => {
      expect(caps.supportsRenameEnumValue).toBe(true);
    });

    it("should not yet support INDEX INCLUDE (< 11)", () => {
      expect(caps.supportsIndexInclude).toBe(false);
    });

    it("should not yet support native gen_random_uuid (< 13)", () => {
      expect(caps.supportsNativeGenRandomUuid).toBe(false);
    });
  });

  describe("PostgreSQL 11", () => {
    const caps = resolvePostgresCapabilities(DbVersion.parse("11.0.0"));

    it("should support INDEX INCLUDE (11+)", () => {
      expect(caps.supportsIndexInclude).toBe(true);
    });
  });

  describe("PostgreSQL 13", () => {
    const caps = resolvePostgresCapabilities(DbVersion.parse("13.0.0"));

    it("should support native gen_random_uuid (13+)", () => {
      expect(caps.supportsNativeGenRandomUuid).toBe(true);
    });
  });

  describe("PostgreSQL always-true common flags", () => {
    const caps = resolvePostgresCapabilities(DbVersion.parse("9.5.0"));

    it("should always support RENAME COLUMN", () => {
      expect(caps.supportsRenameColumn).toBe(true);
    });

    it("should always support RETURNING", () => {
      expect(caps.supportsReturning).toBe(true);
    });

    it("should always support DROP COLUMN", () => {
      expect(caps.supportsDropColumn).toBe(true);
    });

    it("should always support upsert (ON CONFLICT)", () => {
      expect(caps.supportsUpsert).toBe(true);
    });
  });
});

describe("resolveSqliteCapabilities", () => {
  describe("SQLite 3.20.0 (old)", () => {
    const caps = resolveSqliteCapabilities(DbVersion.parse("3.20.0"));

    it("should not support upsert (< 3.24)", () => {
      expect(caps.supportsUpsert).toBe(false);
    });

    it("should not support RENAME COLUMN (< 3.25)", () => {
      expect(caps.supportsSqliteRenameColumn).toBe(false);
      expect(caps.supportsRenameColumn).toBe(false);
    });

    it("should not support generated columns (< 3.31)", () => {
      expect(caps.supportsSqliteGeneratedColumns).toBe(false);
    });

    it("should not support DROP COLUMN (< 3.35)", () => {
      expect(caps.supportsDropColumn).toBe(false);
    });

    it("should not support RETURNING (< 3.35)", () => {
      expect(caps.supportsReturning).toBe(false);
    });
  });

  describe("SQLite 3.24.0", () => {
    const caps = resolveSqliteCapabilities(DbVersion.parse("3.24.0"));

    it("should support upsert (3.24+)", () => {
      expect(caps.supportsUpsert).toBe(true);
    });

    it("should not yet support RENAME COLUMN (< 3.25)", () => {
      expect(caps.supportsSqliteRenameColumn).toBe(false);
    });
  });

  describe("SQLite 3.25.0", () => {
    const caps = resolveSqliteCapabilities(DbVersion.parse("3.25.0"));

    it("should support RENAME COLUMN (3.25+)", () => {
      expect(caps.supportsSqliteRenameColumn).toBe(true);
      expect(caps.supportsRenameColumn).toBe(true);
    });
  });

  describe("SQLite 3.31.0", () => {
    const caps = resolveSqliteCapabilities(DbVersion.parse("3.31.0"));

    it("should support generated columns (3.31+)", () => {
      expect(caps.supportsSqliteGeneratedColumns).toBe(true);
    });
  });

  describe("SQLite 3.35.0", () => {
    const caps = resolveSqliteCapabilities(DbVersion.parse("3.35.0"));

    it("should support DROP COLUMN (3.35+)", () => {
      expect(caps.supportsDropColumn).toBe(true);
    });

    it("should support RETURNING (3.35+)", () => {
      expect(caps.supportsReturning).toBe(true);
    });
  });

  describe("SQLite should not have other dialect keys", () => {
    const caps = resolveSqliteCapabilities(DbVersion.parse("3.20.0"));

    it("should not have MySQL-specific keys", () => {
      expect(caps).not.toHaveProperty("supportsCheckConstraints");
      expect(caps).not.toHaveProperty("supportsJsonColumnType");
    });

    it("should not have PG-specific keys", () => {
      expect(caps).not.toHaveProperty("supportsGeneratedIdentity");
      expect(caps).not.toHaveProperty("supportsIndexInclude");
    });
  });
});

describe("ALL_* defaults", () => {
  // MariaDB-only flags are intentionally false in ALL_MYSQL so that DDL
  // produced with the optimistic default stays safe on MySQL.
  const MARIADB_ONLY_FLAGS = new Set([
    "supportsInsertReturning",
    "supportsSequence",
    "supportsNativeUuidType",
    "supportsSystemVersioning",
  ]);

  it("ALL_MYSQL should have every non-MariaDB-only flag set to true", () => {
    for (const [key, value] of Object.entries(ALL_MYSQL)) {
      if (MARIADB_ONLY_FLAGS.has(key)) {
        expect(value).toBe(false);
      } else {
        expect(value).toBe(true);
      }
    }
  });

  it("ALL_POSTGRES should have all flags set to true", () => {
    for (const [, value] of Object.entries(ALL_POSTGRES)) {
      expect(value).toBe(true);
    }
  });

  it("ALL_SQLITE should have all flags set to true (except ALTER ADD FK)", () => {
    for (const [key, value] of Object.entries(ALL_SQLITE)) {
      if (key === "supportsAlterAddForeignKey") {
        // SQLite has never supported ALTER TABLE ADD FOREIGN KEY in any
        // version — FKs are embedded inline at CREATE TABLE time instead.
        expect(value).toBe(false);
      } else {
        expect(value).toBe(true);
      }
    }
  });

  it("ALL_MYSQL should have MySQL-specific keys", () => {
    expect(ALL_MYSQL).toHaveProperty("supportsCheckConstraints");
    expect(ALL_MYSQL).toHaveProperty("supportsJsonColumnType");
    expect(ALL_MYSQL).not.toHaveProperty("supportsGeneratedIdentity");
  });

  it("ALL_POSTGRES should have PG-specific keys", () => {
    expect(ALL_POSTGRES).toHaveProperty("supportsGeneratedIdentity");
    expect(ALL_POSTGRES).toHaveProperty("supportsIndexInclude");
    expect(ALL_POSTGRES).not.toHaveProperty("supportsJsonColumnType");
  });

  it("ALL_SQLITE should have SQLite-specific keys", () => {
    expect(ALL_SQLITE).toHaveProperty("supportsSqliteGeneratedColumns");
    expect(ALL_SQLITE).not.toHaveProperty("supportsCheckConstraints");
  });
});

describe("UnsupportedFeatureError", () => {
  it("should have correct error code", () => {
    const err = new UnsupportedFeatureError(
      "ALTER TABLE DROP COLUMN",
      "SQLite 3.35.0+",
      "3.24.0",
    );
    expect(err.code).toBe(OrmErrorCode.UNSUPPORTED_OPERATION);
  });

  it("should include feature name and versions in message", () => {
    const err = new UnsupportedFeatureError(
      "ALTER TABLE DROP COLUMN",
      "SQLite 3.35.0+",
      "3.24.0",
    );
    expect(err.message).toContain("ALTER TABLE DROP COLUMN");
    expect(err.message).toContain("SQLite 3.35.0+");
    expect(err.message).toContain("3.24.0");
  });

  it("should include upgrade suggestion", () => {
    const err = new UnsupportedFeatureError(
      "CHECK constraints",
      "MySQL 8.0.16+",
      "5.7.0",
    );
    expect(err.suggestion).toContain("MySQL 8.0.16+");
    expect(err.suggestion).toContain("Upgrade");
  });

  it("should have correct error name", () => {
    const err = new UnsupportedFeatureError("test", "v1", "v0");
    expect(err.name).toBe("UnsupportedFeatureError");
  });

  it("should be instanceof OrmError", () => {
    const err = new UnsupportedFeatureError("test", "v1", "v0");
    expect(err).toBeInstanceOf(Error);
  });
});
