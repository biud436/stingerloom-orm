import "reflect-metadata";
import { FullTextIndex, FULLTEXT_INDEX_TOKEN, FullTextIndexMetadata } from "../../src/decorators/FullTextIndex";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { Conditions } from "../../src/core/Conditions";
import { resolveWhereClause } from "../../src/core/WhereResolver";
import { WhereClause, FILTER_OPERATOR_KEYS } from "../../src/dialects/FindOption";
import { SchemaGenerator } from "../../src/core/generators/SchemaGenerator";

// ── Test Entities ────────────────────────────────────────

@Entity({ name: "posts" })
@FullTextIndex(["title", "content"])
class Post {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  title!: string;

  @Column({ type: "text" })
  content!: string;
}

@Entity({ name: "articles" })
@FullTextIndex(["title"], { name: "idx_articles_fts", language: "simple" })
class Article {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  title!: string;
}

@Entity({ name: "docs" })
@FullTextIndex(["summary"], { name: "idx_docs_summary_fts" })
@FullTextIndex(["title", "body"])
class DocEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  title!: string;

  @Column({ type: "text" })
  body!: string;

  @Column({ type: "text" })
  summary!: string;
}

// ── Helpers ──────────────────────────────────────────────

const wrapMysql = (n: string) => `\`${n}\``;
const wrapPg = (n: string) => `"${n}"`;

// ── Tests ────────────────────────────────────────────────

describe("Full-text search", () => {
  describe("@FullTextIndex decorator", () => {
    it("should store metadata with columns", () => {
      const meta: FullTextIndexMetadata[] =
        Reflect.getMetadata(FULLTEXT_INDEX_TOKEN, Post) ?? [];
      expect(meta).toHaveLength(1);
      expect(meta[0].columns).toEqual(["title", "content"]);
      expect(meta[0].name).toBeUndefined();
      expect(meta[0].language).toBeUndefined();
    });

    it("should store custom name and language", () => {
      const meta: FullTextIndexMetadata[] =
        Reflect.getMetadata(FULLTEXT_INDEX_TOKEN, Article) ?? [];
      expect(meta).toHaveLength(1);
      expect(meta[0].columns).toEqual(["title"]);
      expect(meta[0].name).toBe("idx_articles_fts");
      expect(meta[0].language).toBe("simple");
    });

    it("should support multiple @FullTextIndex on same entity", () => {
      const meta: FullTextIndexMetadata[] =
        Reflect.getMetadata(FULLTEXT_INDEX_TOKEN, DocEntity) ?? [];
      expect(meta).toHaveLength(2);
      // Decorators stack bottom-up: ["title","body"] first, then ["summary"]
      expect(meta[0].columns).toEqual(["title", "body"]);
      expect(meta[1].columns).toEqual(["summary"]);
      expect(meta[1].name).toBe("idx_docs_summary_fts");
    });
  });

  describe("Conditions.fullTextSearch()", () => {
    it("should generate PostgreSQL tsvector/tsquery SQL", () => {
      const result = Conditions.fullTextSearch('"title"', "hello world", "postgres");
      // sql-template-tag uses ? placeholders
      expect(result.sql).toBe(
        'to_tsvector(?, "title") @@ plainto_tsquery(?, ?)',
      );
      expect(result.values).toEqual(["english", "english", "hello world"]);
    });

    it("should generate PostgreSQL SQL with custom language", () => {
      const result = Conditions.fullTextSearch('"title"', "bonjour", "postgres", "french");
      expect(result.sql).toBe(
        'to_tsvector(?, "title") @@ plainto_tsquery(?, ?)',
      );
      expect(result.values).toEqual(["french", "french", "bonjour"]);
    });

    it("should generate MySQL MATCH...AGAINST SQL", () => {
      const result = Conditions.fullTextSearch("`title`", "hello world", "mysql");
      expect(result.sql).toBe(
        "MATCH(`title`) AGAINST(? IN BOOLEAN MODE)",
      );
      expect(result.values).toEqual(["hello world"]);
    });

    it("should default to PostgreSQL dialect when not specified", () => {
      const result = Conditions.fullTextSearch('"content"', "search term");
      expect(result.sql).toContain("to_tsvector");
      expect(result.sql).toContain("plainto_tsquery");
    });

    it("should accept MySQL natural language mode via options", () => {
      const result = Conditions.fullTextSearch(
        "`title`",
        "hello",
        "mysql",
        { mode: "natural" },
      );
      expect(result.sql).toBe("MATCH(`title`) AGAINST(? IN NATURAL LANGUAGE MODE)");
      expect(result.values).toEqual(["hello"]);
    });

    it("should accept boolean mode explicitly via options", () => {
      const result = Conditions.fullTextSearch(
        "`title`",
        "hello",
        "mysql",
        { mode: "boolean" },
      );
      expect(result.sql).toBe("MATCH(`title`) AGAINST(? IN BOOLEAN MODE)");
    });

    it("should generate MySQL MATCH over multiple columns", () => {
      const result = Conditions.fullTextSearch(
        ["i.`title`", "i.`description`"],
        "hello",
        "mysql",
        { mode: "natural" },
      );
      expect(result.sql).toBe(
        "MATCH(i.`title`, i.`description`) AGAINST(? IN NATURAL LANGUAGE MODE)",
      );
      expect(result.values).toEqual(["hello"]);
    });

    it("should accept PG language via options object", () => {
      const result = Conditions.fullTextSearch(
        '"title"',
        "bonjour",
        "postgres",
        { language: "french" },
      );
      expect(result.values).toEqual(["french", "french", "bonjour"]);
    });

    it("should compose PG tsvector across multiple columns", () => {
      const result = Conditions.fullTextSearch(
        ['i."title"', 'i."description"'],
        "hello",
        "postgres",
      );
      expect(result.sql).toBe(
        "to_tsvector(?, COALESCE(i.\"title\", '') || ' ' || COALESCE(i.\"description\", '')) @@ plainto_tsquery(?, ?)",
      );
      expect(result.values).toEqual(["english", "english", "hello"]);
    });
  });

  describe("WhereResolver search operator", () => {
    it("should handle search filter for PostgreSQL", () => {
      const where: WhereClause<Post> = {
        title: { search: "typescript orm" } as any,
      };
      const results = resolveWhereClause(where, {
        wrapColumn: wrapPg,
        dialect: "postgres",
      });
      expect(results).toHaveLength(1);
      expect(results[0].sql).toContain("to_tsvector");
      expect(results[0].sql).toContain("plainto_tsquery");
      expect(results[0].values).toContain("typescript orm");
    });

    it("should handle search filter for MySQL", () => {
      const where: WhereClause<Post> = {
        title: { search: "typescript orm" } as any,
      };
      const results = resolveWhereClause(where, {
        wrapColumn: wrapMysql,
        dialect: "mysql",
      });
      expect(results).toHaveLength(1);
      expect(results[0].sql).toContain("MATCH");
      expect(results[0].sql).toContain("AGAINST");
      expect(results[0].values).toContain("typescript orm");
    });

    it("should combine search with other filters", () => {
      const where: WhereClause<Post> = {
        title: { search: "orm" } as any,
        id: { gt: 10 },
      };
      const results = resolveWhereClause(where, {
        wrapColumn: wrapPg,
        dialect: "postgres",
      });
      expect(results).toHaveLength(2);
    });

    it("should default to postgres when dialect not specified", () => {
      const where: WhereClause<Post> = {
        title: { search: "test" } as any,
      };
      const results = resolveWhereClause(where, {
        wrapColumn: wrapPg,
      });
      expect(results).toHaveLength(1);
      // Default (no dialect) should produce postgres-style SQL
      expect(results[0].sql).toContain("to_tsvector");
    });
  });

  describe("FILTER_OPERATOR_KEYS", () => {
    it("should include search in operator keys", () => {
      expect(FILTER_OPERATOR_KEYS.has("search")).toBe(true);
    });
  });

  describe("SchemaGenerator full-text DDL", () => {
    it("should generate PostgreSQL GIN index with to_tsvector", () => {
      const gen = new SchemaGenerator({ dialect: "postgres" });
      const ddls = gen.generateFullTextIndexDDL(Post);
      expect(ddls).toHaveLength(1);
      expect(ddls[0]).toContain("USING gin");
      expect(ddls[0]).toContain("to_tsvector('english'");
      expect(ddls[0]).toContain('"title"');
      expect(ddls[0]).toContain('"content"');
      expect(ddls[0]).toContain("IF NOT EXISTS");
    });

    it("should generate PostgreSQL GIN index with custom language", () => {
      const gen = new SchemaGenerator({ dialect: "postgres" });
      const ddls = gen.generateFullTextIndexDDL(Article);
      expect(ddls).toHaveLength(1);
      expect(ddls[0]).toContain("to_tsvector('simple'");
      expect(ddls[0]).toContain('"idx_articles_fts"');
    });

    it("should generate MySQL FULLTEXT index", () => {
      const gen = new SchemaGenerator({ dialect: "mysql" });
      const ddls = gen.generateFullTextIndexDDL(Post);
      expect(ddls).toHaveLength(1);
      expect(ddls[0]).toContain("CREATE FULLTEXT INDEX");
      expect(ddls[0]).toContain("`title`");
      expect(ddls[0]).toContain("`content`");
    });

    it("should generate MySQL FULLTEXT index with custom name", () => {
      const gen = new SchemaGenerator({ dialect: "mysql" });
      const ddls = gen.generateFullTextIndexDDL(Article);
      expect(ddls).toHaveLength(1);
      expect(ddls[0]).toContain("`idx_articles_fts`");
    });

    it("should return empty array for SQLite", () => {
      const gen = new SchemaGenerator({ dialect: "sqlite" });
      const ddls = gen.generateFullTextIndexDDL(Post);
      expect(ddls).toHaveLength(0);
    });

    it("should include FTS indexes in generateSchemaDDL", () => {
      const gen = new SchemaGenerator({ dialect: "postgres" });
      const ddls = gen.generateSchemaDDL([Post]);
      const ftsIndex = ddls.find((d) => d.includes("USING gin"));
      expect(ftsIndex).toBeDefined();
    });

    it("should handle multiple FTS indexes on same entity", () => {
      const gen = new SchemaGenerator({ dialect: "postgres" });
      const ddls = gen.generateFullTextIndexDDL(DocEntity);
      expect(ddls).toHaveLength(2);
      // First: ["title", "body"], second: ["summary"] with custom name
      const ftsBody = ddls.find((d) => d.includes("|| ' ' ||"));
      const ftsSummary = ddls.find((d) => d.includes("idx_docs_summary_fts"));
      expect(ftsBody).toBeDefined();
      expect(ftsSummary).toBeDefined();
    });

    it("should generate single-column PostgreSQL GIN index without concatenation", () => {
      const gen = new SchemaGenerator({ dialect: "postgres" });
      const ddls = gen.generateFullTextIndexDDL(Article);
      expect(ddls[0]).not.toContain("||");
      expect(ddls[0]).toContain('to_tsvector(\'simple\', "title")');
    });

    it("should generate multi-column PostgreSQL GIN index with concatenation", () => {
      const gen = new SchemaGenerator({ dialect: "postgres" });
      const ddls = gen.generateFullTextIndexDDL(Post);
      expect(ddls[0]).toContain("||");
      expect(ddls[0]).toContain('"title"');
      expect(ddls[0]).toContain('"content"');
    });
  });
});
