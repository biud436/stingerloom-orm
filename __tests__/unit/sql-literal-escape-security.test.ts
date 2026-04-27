/**
 * Issues #285, #286 — SQL literal escaping for DDL paths.
 *
 *  - #285: @FullTextIndex({ language }) was interpolated raw into to_tsvector
 *          DDL. Now validated via identifier regex and escaped via the shared
 *          escapeSqlLiteral helper.
 *  - #286: SchemaRegistrar.buildColumnTypeExpr only escaped single quotes for
 *          ENUM values. Now also escapes backslashes and rejects null bytes.
 */

import "reflect-metadata";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { FullTextIndex } from "../../src/decorators/FullTextIndex";
import { SchemaGenerator } from "../../src/core/generators/SchemaGenerator";
import { escapeSqlLiteral } from "../../src/utils/escapeSqlLiteral";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";

// ──────────────────────────────────────────────
// Shared helper coverage
// ──────────────────────────────────────────────

describe("escapeSqlLiteral (#285, #286)", () => {
  it("escapes single quotes", () => {
    expect(escapeSqlLiteral("foo'bar")).toBe("foo''bar");
  });

  it("escapes backslashes", () => {
    expect(escapeSqlLiteral("foo\\")).toBe("foo\\\\");
  });

  it("escapes both backslashes and single quotes (in that order)", () => {
    // Escape backslash first, then quote — verifies the order doesn't double-
    // escape the inserted backslash.
    expect(escapeSqlLiteral("a\\'b")).toBe("a\\\\''b");
  });

  it("rejects null bytes with VALIDATION_ERROR", () => {
    let captured: unknown;
    try {
      escapeSqlLiteral("foo\0bar");
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(OrmError);
    expect((captured as OrmError).code).toBe(OrmErrorCode.VALIDATION_ERROR);
  });

  it("leaves benign values untouched", () => {
    expect(escapeSqlLiteral("english")).toBe("english");
    expect(escapeSqlLiteral("admin")).toBe("admin");
  });
});

// ──────────────────────────────────────────────
// #285 — FullTextIndex language sanitization
// ──────────────────────────────────────────────

describe("@FullTextIndex language sanitization (#285)", () => {
  @Entity({ name: "post_default_lang" })
  @FullTextIndex(["content"])
  class PostDefaultLang {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "text" }) content!: string;
  }

  @Entity({ name: "post_simple_lang" })
  @FullTextIndex(["content"], { language: "simple" })
  class PostSimpleLang {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "text" }) content!: string;
  }

  @Entity({ name: "post_underscored_lang" })
  @FullTextIndex(["content"], { language: "korean_unaccent" })
  class PostUnderscoredLang {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "text" }) content!: string;
  }

  @Entity({ name: "post_quote_inj" })
  @FullTextIndex(["content"], {
    language: "english', 'evil') ; DROP TABLE users; --",
  })
  class PostQuoteInjection {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "text" }) content!: string;
  }

  @Entity({ name: "post_backslash_inj" })
  @FullTextIndex(["content"], { language: "english\\" })
  class PostBackslashInjection {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "text" }) content!: string;
  }

  @Entity({ name: "post_space_inj" })
  @FullTextIndex(["content"], { language: "english evil" })
  class PostSpaceInjection {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "text" }) content!: string;
  }

  it("emits the default 'english' DDL unchanged for the no-option path", () => {
    const gen = new SchemaGenerator({ dialect: "postgres" });
    const ddls = gen.generateFullTextIndexDDL(PostDefaultLang);
    expect(ddls).toHaveLength(1);
    expect(ddls[0]).toContain("to_tsvector('english',");
    expect(ddls[0]).not.toContain("DROP");
  });

  it("accepts a known regconfig such as 'simple'", () => {
    const gen = new SchemaGenerator({ dialect: "postgres" });
    const ddls = gen.generateFullTextIndexDDL(PostSimpleLang);
    expect(ddls[0]).toContain("to_tsvector('simple',");
  });

  it("accepts identifier-shaped configurations (letters, digits, underscores)", () => {
    const gen = new SchemaGenerator({ dialect: "postgres" });
    const ddls = gen.generateFullTextIndexDDL(PostUnderscoredLang);
    expect(ddls[0]).toContain("to_tsvector('korean_unaccent',");
  });

  it("rejects a language containing single quotes (injection vector)", () => {
    const gen = new SchemaGenerator({ dialect: "postgres" });

    let captured: unknown;
    try {
      gen.generateFullTextIndexDDL(PostQuoteInjection);
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(OrmError);
    expect((captured as OrmError).code).toBe(OrmErrorCode.VALIDATION_ERROR);
  });

  it("rejects a language containing a backslash", () => {
    const gen = new SchemaGenerator({ dialect: "postgres" });

    let captured: unknown;
    try {
      gen.generateFullTextIndexDDL(PostBackslashInjection);
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(OrmError);
    expect((captured as OrmError).code).toBe(OrmErrorCode.VALIDATION_ERROR);
  });

  it("rejects a language containing whitespace", () => {
    const gen = new SchemaGenerator({ dialect: "postgres" });

    let captured: unknown;
    try {
      gen.generateFullTextIndexDDL(PostSpaceInjection);
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(OrmError);
    expect((captured as OrmError).code).toBe(OrmErrorCode.VALIDATION_ERROR);
  });

  it("does not affect MySQL FULLTEXT DDL — language has no place there", () => {
    const gen = new SchemaGenerator({ dialect: "mysql" });
    const ddls = gen.generateFullTextIndexDDL(PostDefaultLang);
    expect(ddls).toHaveLength(1);
    expect(ddls[0]).toContain("CREATE FULLTEXT INDEX");
  });
});

// ──────────────────────────────────────────────
// #286 — ENUM literal escaping
// ──────────────────────────────────────────────

describe("ENUM literal escaping (#286)", () => {
  describe("SchemaRegistrar.buildColumnTypeExpr (via private access)", () => {
    // buildColumnTypeExpr is private, so we test it through the path that
    // exercises it indirectly: round-trip an enumValues array through the
    // shared helper to confirm the escape is now backslash-aware.
    //
    // The buildColumnTypeExpr path itself wraps each value as `'${escaped}'`
    // — this test verifies the underlying escape, which is what the call
    // site now uses (see SchemaRegistrar.ts buildColumnTypeExpr).

    it("escapes a backslash-trailing enum value", () => {
      // 'foo\' would, under MySQL default mode, escape the closing quote.
      // After the fix, the value becomes 'foo\\' inside the literal.
      expect(escapeSqlLiteral("foo\\")).toBe("foo\\\\");
    });

    it("escapes a value containing both a backslash and a quote", () => {
      expect(escapeSqlLiteral("a\\'b")).toBe("a\\\\''b");
    });

    it("preserves benign enum values like 'admin' / 'user'", () => {
      expect(escapeSqlLiteral("admin")).toBe("admin");
      expect(escapeSqlLiteral("user")).toBe("user");
      expect(escapeSqlLiteral("read-only")).toBe("read-only");
    });

    it("rejects null bytes outright", () => {
      let captured: unknown;
      try {
        escapeSqlLiteral("a\0b");
      } catch (e) {
        captured = e;
      }
      expect(captured).toBeInstanceOf(OrmError);
      expect((captured as OrmError).code).toBe(OrmErrorCode.VALIDATION_ERROR);
    });
  });

  describe("MySqlColumnDefinitionBuilder.resolveEnumType", () => {
    // Confirm the inline ENUM(...) DDL emitted from @Column metadata now
    // routes its values through the shared escape helper.
    it("escapes backslashes in inline ENUM values for MySQL", async () => {
      const { MySqlColumnDefinitionBuilder } = await import(
        "../../src/dialects/mysql/MySqlColumnDefinitionBuilder"
      );
      const builder = new MySqlColumnDefinitionBuilder();
      // Access the protected method via a casted handle.
      const result = (builder as any).resolveEnumType(
        "ENUM",
        {
          type: "enum",
          enumValues: ["foo\\", "ok"],
        },
        {} as any,
      );
      expect(result).toBe("ENUM('foo\\\\','ok')");
    });

    it("escapes single quotes (regression)", async () => {
      const { MySqlColumnDefinitionBuilder } = await import(
        "../../src/dialects/mysql/MySqlColumnDefinitionBuilder"
      );
      const builder = new MySqlColumnDefinitionBuilder();
      const result = (builder as any).resolveEnumType(
        "ENUM",
        {
          type: "enum",
          enumValues: ["O'Reilly"],
        },
        {} as any,
      );
      expect(result).toBe("ENUM('O''Reilly')");
    });

    it("rejects null-byte enum values", async () => {
      const { MySqlColumnDefinitionBuilder } = await import(
        "../../src/dialects/mysql/MySqlColumnDefinitionBuilder"
      );
      const builder = new MySqlColumnDefinitionBuilder();
      let captured: unknown;
      try {
        (builder as any).resolveEnumType(
          "ENUM",
          { type: "enum", enumValues: ["a\0b"] },
          {} as any,
        );
      } catch (e) {
        captured = e;
      }
      expect(captured).toBeInstanceOf(OrmError);
      expect((captured as OrmError).code).toBe(OrmErrorCode.VALIDATION_ERROR);
    });

    it("emits unchanged DDL for vanilla enum values (regression)", async () => {
      const { MySqlColumnDefinitionBuilder } = await import(
        "../../src/dialects/mysql/MySqlColumnDefinitionBuilder"
      );
      const builder = new MySqlColumnDefinitionBuilder();
      const result = (builder as any).resolveEnumType(
        "ENUM",
        { type: "enum", enumValues: ["admin", "user", "guest"] },
        {} as any,
      );
      expect(result).toBe("ENUM('admin','user','guest')");
    });
  });
});
