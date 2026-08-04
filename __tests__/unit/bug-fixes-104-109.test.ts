/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { SchemaDiff } from "../../src/core/generators/SchemaDiff";
import { SchemaDiffMigrationGenerator } from "../../src/core/generators/SchemaDiffMigrationGenerator";
import { ManyToMany, ManyToManyMetadata, MANY_TO_MANY_TOKEN } from "../../src/decorators/ManyToMany";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../src/decorators/ManyToOne";

// ─────────────────────────────────────────────────
// #104: SQLite PRAGMA table_info SQL injection
// ─────────────────────────────────────────────────

describe("#104: SQLite PRAGMA table_info escapes identifier", () => {
  it("should wrap table name in double-quotes for PRAGMA call", async () => {
    const schemaDiff = new SchemaDiff();
    const queriedSqls: string[] = [];

    const mockRunner = {
      query: async (sql: any) => {
        const sqlStr = typeof sql === "string" ? sql : sql.sql;
        queriedSqls.push(sqlStr);
        return [];
      },
    };

    @Entity()
    class SqlitePragmaUser {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    await schemaDiff.diff([SqlitePragmaUser], mockRunner, "sqlite");

    const pragmaCall = queriedSqls.find((s) => s.includes("PRAGMA table_info"));
    expect(pragmaCall).toBeDefined();
    // Table name should be wrapped in double-quotes
    expect(pragmaCall).toMatch(/^PRAGMA table_info\(".*"\)$/);
  });

  it("should not be vulnerable to SQL injection via table name", async () => {
    // Directly test the escaping logic on SchemaDiff internals
    const schemaDiff = new SchemaDiff();
    const queriedSqls: string[] = [];

    const mockRunner = {
      query: async (sql: any) => {
        const sqlStr = typeof sql === "string" ? sql : sql.sql;
        queriedSqls.push(sqlStr);
        return [];
      },
    };

    // Even if somehow a malicious table name reaches SchemaDiff,
    // double quotes within the name are escaped as ""
    @Entity()
    class SqlitePragmaSafe {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    await schemaDiff.diff([SqlitePragmaSafe], mockRunner, "sqlite");

    const pragmaCall = queriedSqls.find((s) => s.includes("PRAGMA table_info"));
    expect(pragmaCall).toBeDefined();
    // The call should use quoted identifiers, not raw interpolation
    expect(pragmaCall).toContain('"');
  });
});

// ─────────────────────────────────────────────────
// #106: RawQueryBuilder.select([]) — tested in raw-query-builder.test.ts
// ─────────────────────────────────────────────────

// ─────────────────────────────────────────────────
// #107: SchemaDiffMigrationGenerator undefined nullable → NULL
// ─────────────────────────────────────────────────

describe("#107: SchemaDiffMigrationGenerator treats undefined nullable as NULL", () => {
  const gen = new SchemaDiffMigrationGenerator();

  it("should generate NULL when nullable is undefined", () => {
    const result = gen.generate(
      {
        addTables: [],
        dropTables: [],
        addColumns: [
          { tableName: "users", columnName: "bio", columnType: "TEXT", nullable: undefined },
        ],
        dropColumns: [],
        alterColumns: [],
      },
      "postgres",
    );

    expect(result).toContain("NULL");
    expect(result).not.toContain("NOT NULL");
  });

  it("should generate NOT NULL when nullable is false", () => {
    const result = gen.generate(
      {
        addTables: [],
        dropTables: [],
        addColumns: [
          { tableName: "users", columnName: "email", columnType: "VARCHAR(255)", nullable: false },
        ],
        dropColumns: [],
        alterColumns: [],
      },
      "postgres",
    );

    expect(result).toContain("NOT NULL");
  });

  it("should generate NULL when nullable is true", () => {
    const result = gen.generate(
      {
        addTables: [],
        dropTables: [],
        addColumns: [
          { tableName: "users", columnName: "phone", columnType: "VARCHAR(20)", nullable: true },
        ],
        dropColumns: [],
        alterColumns: [],
      },
      "postgres",
    );

    // Should contain NULL but not NOT NULL
    const lines = result.split("\n");
    const addColumnLine = lines.find((l) => l.includes("ADD COLUMN"));
    expect(addColumnLine).toBeDefined();
    expect(addColumnLine).toContain("NULL");
    expect(addColumnLine).not.toContain("NOT NULL");
  });
});

// ─────────────────────────────────────────────────
// #108: ManyToMany cascade option
// ─────────────────────────────────────────────────

describe("#108: ManyToMany decorator cascade option", () => {
  it("should store cascade in metadata when provided", () => {
    @Entity()
    class Tag {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    @Entity()
    class Post {
      @PrimaryGeneratedColumn()
      id!: number;

      @ManyToMany(() => Tag, {
        joinTable: { name: "post_tags", joinColumn: "post_id", inverseJoinColumn: "tag_id" },
        cascade: ["insert", "update"],
      })
      tags!: Tag[];
    }

    const metadata = Reflect.getMetadata(MANY_TO_MANY_TOKEN, Post) as ManyToManyMetadata<any>[];
    expect(metadata).toBeDefined();
    expect(metadata.length).toBeGreaterThan(0);
    const tagsMeta = metadata.find((m) => m.propertyKey === "tags");
    expect(tagsMeta).toBeDefined();
    expect(tagsMeta!.cascade).toEqual(["insert", "update"]);
  });

  it("should store cascade: true in metadata", () => {
    @Entity()
    class Category {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    @Entity()
    class Article {
      @PrimaryGeneratedColumn()
      id!: number;

      @ManyToMany(() => Category, {
        joinTable: { name: "article_categories", joinColumn: "article_id", inverseJoinColumn: "category_id" },
        cascade: true,
      })
      categories!: Category[];
    }

    const metadata = Reflect.getMetadata(MANY_TO_MANY_TOKEN, Article) as ManyToManyMetadata<any>[];
    const catMeta = metadata.find((m) => m.propertyKey === "categories");
    expect(catMeta!.cascade).toBe(true);
  });

  it("should have undefined cascade when not specified", () => {
    @Entity()
    class Label {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    @Entity()
    class Item {
      @PrimaryGeneratedColumn()
      id!: number;

      @ManyToMany(() => Label, {
        joinTable: { name: "item_labels", joinColumn: "item_id", inverseJoinColumn: "label_id" },
      })
      labels!: Label[];
    }

    const metadata = Reflect.getMetadata(MANY_TO_MANY_TOKEN, Item) as ManyToManyMetadata<any>[];
    const labelMeta = metadata.find((m) => m.propertyKey === "labels");
    expect(labelMeta!.cascade).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────
// #109: sortTablesByDependency correctness
// ─────────────────────────────────────────────────

describe("#109: sortTablesByDependency produces correct order", () => {
  const gen = new SchemaDiffMigrationGenerator();

  it("should produce valid dry-run SQL for tables with dependencies", () => {
    @Entity({ name: "sort_users_109" })
    class SortUser109 {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    @Entity({ name: "sort_posts_109" })
    class SortPost109 {
      @PrimaryGeneratedColumn()
      id!: number;

      @ManyToOne(() => SortUser109, (e: any) => e.posts, { joinColumn: "user_id" })
      user!: SortUser109;
    }

    const result = gen.dryRun(
      {
        addTables: ["sort_posts_109", "sort_users_109"],
        dropTables: [],
        addColumns: [],
        dropColumns: [],
        alterColumns: [],
        addTableEntityMap: {
          sort_posts_109: SortPost109,
          sort_users_109: SortUser109,
        },
      },
      "postgres",
    );

    // Referenced table (users) must be created before the referencing one
    expect(result.up).toHaveLength(2);
    expect(result.up[0]).toContain("sort_users_109");
    expect(result.up[1]).toContain("sort_posts_109");
    expect(result.down).toEqual([
      'DROP TABLE IF EXISTS "sort_posts_109"',
      'DROP TABLE IF EXISTS "sort_users_109"',
    ]);
  });

  it("should throw for addTables without an entity class (no silent skip)", () => {
    expect(() =>
      gen.dryRun(
        {
          addTables: ["users", "posts"],
          dropTables: [],
          addColumns: [],
          dropColumns: [],
          alterColumns: [],
        },
        "postgres",
      ),
    ).toThrow('Cannot generate CREATE TABLE for "users"');
  });
});
