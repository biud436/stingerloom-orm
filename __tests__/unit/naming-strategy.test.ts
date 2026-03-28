/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import {
  NamingStrategy,
  DefaultNamingStrategy,
} from "../../src/core/generators/NamingStrategy";
import { SnakeNamingStrategy } from "../../src/core/generators/SnakeNamingStrategy";
import { SchemaGenerator } from "../../src/core/generators/SchemaGenerator";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../src/decorators/ManyToOne";

// ─────────────────────────────────────────────────
// Test entities
// ─────────────────────────────────────────────────

@Entity()
class NsUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  name!: string;
}

@Entity()
class NsPost {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  title!: string;

  @ManyToOne(() => NsUser, (e: any) => e.author, { joinColumn: "author_id" })
  author!: NsUser;
}

// ─────────────────────────────────────────────────
// DefaultNamingStrategy tests
// ─────────────────────────────────────────────────

describe("DefaultNamingStrategy", () => {
  let strategy: DefaultNamingStrategy;

  beforeEach(() => {
    strategy = new DefaultNamingStrategy();
  });

  describe("foreignKeyName()", () => {
    it("should generate a deterministic FK name with SHA1 hash", () => {
      const name1 = strategy.foreignKeyName("posts", "author_id", "users");
      const name2 = strategy.foreignKeyName("posts", "author_id", "users");
      expect(name1).toBe(name2);
      expect(name1).toMatch(/^fk_posts_[a-f0-9]{8}$/);
    });

    it("should produce different names for different inputs", () => {
      const name1 = strategy.foreignKeyName("posts", "author_id", "users");
      const name2 = strategy.foreignKeyName("posts", "category_id", "categories");
      expect(name1).not.toBe(name2);
    });

    it("should truncate to 63 characters max", () => {
      const longTableName = "a".repeat(100);
      const name = strategy.foreignKeyName(longTableName, "col", "ref");
      expect(name.length).toBeLessThanOrEqual(63);
      // When base exceeds 63 chars, falls back to fk_{hash}
      expect(name).toMatch(/^fk_[a-f0-9]{8}$/);
    });

    it("should match SchemaGenerator.generateForeignKeyName output", () => {
      const sgName = SchemaGenerator.generateForeignKeyName(
        "posts",
        "author_id",
        "users",
      );
      const nsName = strategy.foreignKeyName("posts", "author_id", "users");
      expect(nsName).toBe(sgName);
    });
  });

  describe("uniqueIndexName()", () => {
    it("should generate correct unique index name", () => {
      const name = strategy.uniqueIndexName("users", ["email"]);
      expect(name).toBe("uq_users_email");
    });

    it("should join multiple columns with underscore", () => {
      const name = strategy.uniqueIndexName("users", ["first_name", "last_name"]);
      expect(name).toBe("uq_users_first_name_last_name");
    });
  });

  describe("indexName()", () => {
    it("should generate correct index name", () => {
      const name = strategy.indexName("users", "email");
      expect(name).toBe("INDEX_users_email");
    });
  });
});

// ─────────────────────────────────────────────────
// Custom NamingStrategy tests
// ─────────────────────────────────────────────────

describe("Custom NamingStrategy with SchemaGenerator", () => {
  it("should use custom naming strategy for FK names", () => {
    const custom: NamingStrategy = {
      tableName: (name) => name,
      columnName: (name) => name,
      joinColumnName: (prop, ref) => `${prop}${ref.charAt(0).toUpperCase()}${ref.slice(1)}`,
      foreignKeyName: (table, col, ref) => `custom_fk_${table}_${col}_${ref}`,
      uniqueIndexName: (table, cols) =>
        `custom_uq_${table}_${cols.join("_")}`,
      indexName: (table, col) => `custom_idx_${table}_${col}`,
      compositeIndexName: (table, cols) =>
        `custom_cidx_${table}_${cols.join("_")}`,
    };

    const sg = new SchemaGenerator({
      dialect: "mysql",
      namingStrategy: custom,
    });

    const fkDdls = sg.generateForeignKeyDDL(NsPost);
    expect(fkDdls.length).toBeGreaterThan(0);
    expect(fkDdls[0]).toContain("custom_fk_");
  });

  it("should use default naming strategy when none provided", () => {
    const sg = new SchemaGenerator({ dialect: "mysql" });
    const fkDdls = sg.generateForeignKeyDDL(NsPost);
    expect(fkDdls.length).toBeGreaterThan(0);
    // Default uses fk_{table}_{hash}
    expect(fkDdls[0]).toMatch(/fk_ns_post_[a-f0-9]{8}/);
  });
});

// ─────────────────────────────────────────────────
// Backward compatibility
// ─────────────────────────────────────────────────

describe("SchemaGenerator.generateForeignKeyName() backward compat", () => {
  it("should still work as a static method", () => {
    const name = SchemaGenerator.generateForeignKeyName(
      "orders",
      "user_id",
      "users",
    );
    expect(name).toMatch(/^fk_orders_[a-f0-9]{8}$/);
  });

  it("should produce deterministic results", () => {
    const a = SchemaGenerator.generateForeignKeyName("t", "c", "r");
    const b = SchemaGenerator.generateForeignKeyName("t", "c", "r");
    expect(a).toBe(b);
  });
});

// ─────────────────────────────────────────────────
// SnakeNamingStrategy tests
// ─────────────────────────────────────────────────

describe("SnakeNamingStrategy", () => {
  const snake = new SnakeNamingStrategy();

  describe("tableName()", () => {
    it("should convert PascalCase class names to snake_case", () => {
      expect(snake.tableName("User")).toBe("user");
      expect(snake.tableName("UserProfile")).toBe("user_profile");
      expect(snake.tableName("BlogPostComment")).toBe("blog_post_comment");
      expect(snake.tableName("APIKey")).toBe("apikey");
    });
  });

  describe("columnName()", () => {
    it("should convert camelCase property names to snake_case", () => {
      expect(snake.columnName("id")).toBe("id");
      expect(snake.columnName("firstName")).toBe("first_name");
      expect(snake.columnName("createdAt")).toBe("created_at");
      expect(snake.columnName("isActive")).toBe("is_active");
      expect(snake.columnName("postViewCount")).toBe("post_view_count");
    });

    it("should handle already-lowered names", () => {
      expect(snake.columnName("name")).toBe("name");
      expect(snake.columnName("email")).toBe("email");
    });
  });

  describe("joinColumnName()", () => {
    it("should produce snake_case FK column names", () => {
      expect(snake.joinColumnName("author", "id")).toBe("author_id");
      expect(snake.joinColumnName("categoryGroup", "id")).toBe("category_group_id");
      expect(snake.joinColumnName("parentComment", "id")).toBe("parent_comment_id");
    });
  });
});

describe("DefaultNamingStrategy — table/column methods", () => {
  const def = new DefaultNamingStrategy();

  it("tableName should apply camelToSnakeCase (backward compat)", () => {
    expect(def.tableName("User")).toBe("user");
    expect(def.tableName("UserProfile")).toBe("user_profile");
  });

  it("columnName should be identity (backward compat)", () => {
    expect(def.columnName("firstName")).toBe("firstName");
    expect(def.columnName("id")).toBe("id");
  });

  it("joinColumnName should be camelCase concat (backward compat)", () => {
    expect(def.joinColumnName("author", "id")).toBe("authorId");
  });
});
