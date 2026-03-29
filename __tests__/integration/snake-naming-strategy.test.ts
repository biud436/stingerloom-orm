/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Integration test: SnakeNamingStrategy
 *
 * Verifies that SnakeNamingStrategy correctly transforms camelCase
 * TypeScript property names to snake_case DB column names across
 * the full CRUD lifecycle with a real database.
 */
import "reflect-metadata";
import {
  createTestConnection,
  dropTestTable,
  truncateTestTable,
  rawQuery,
  TestConnectionResult,
} from "./helpers/test-connection";
import { getMySqlConfig } from "./helpers/driver-config";
import { generateTableName } from "./helpers/create-test-entity";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  OneToMany,
} from "../../src";
import { SnakeNamingStrategy } from "../../src/core/generators/SnakeNamingStrategy";
import { getScannerInstance } from "../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../src/scanner";
import { MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";
import { DatabaseClient } from "../../src/DatabaseClient";

// Skip if INTEGRATION_TEST is not set or MySQL is disabled
const shouldRun =
  process.env.INTEGRATION_TEST === "true" &&
  process.env.INTEGRATION_TEST_MYSQL !== "false";
const describeIf = shouldRun ? describe : describe.skip;

describeIf("[Integration] SnakeNamingStrategy", () => {
  let conn: TestConnectionResult;
  let authorTableName: string;
  let articleTableName: string;

  // Declare entity classes outside beforeAll so they're accessible in tests
  let AuthorEntity: any;
  let ArticleEntity: any;

  beforeAll(async () => {
    authorTableName = generateTableName("snake_author");
    articleTableName = generateTableName("snake_article");

    conn = await createTestConnection(
      {
        ...getMySqlConfig(),
        synchronize: true,
        logging: false,
        namingStrategy: new SnakeNamingStrategy(),
      },
      () => {
        const columnScanner = getScannerInstance(ColumnScanner);
        columnScanner.clear();

        // -- Author entity --
        AuthorEntity = class {} as any;
        Object.defineProperty(AuthorEntity, "name", {
          value: authorTableName.charAt(0).toUpperCase() + authorTableName.slice(1),
          writable: false,
        });

        Reflect.defineMetadata("design:type", Number, AuthorEntity.prototype, "id");
        PrimaryGeneratedColumn()(AuthorEntity.prototype, "id");

        Reflect.defineMetadata("design:type", String, AuthorEntity.prototype, "firstName");
        Column({ type: "varchar", length: 100 })(AuthorEntity.prototype, "firstName");

        Reflect.defineMetadata("design:type", String, AuthorEntity.prototype, "lastName");
        Column({ type: "varchar", length: 100 })(AuthorEntity.prototype, "lastName");

        Reflect.defineMetadata("design:type", Number, AuthorEntity.prototype, "postCount");
        Column({ type: "int", default: 0 })(AuthorEntity.prototype, "postCount");

        Reflect.defineMetadata("design:type", Boolean, AuthorEntity.prototype, "isActive");
        Column({ type: "boolean", nullable: true })(AuthorEntity.prototype, "isActive");

        Entity({ name: authorTableName })(AuthorEntity);

        // -- Article entity --
        ArticleEntity = class {} as any;
        Object.defineProperty(ArticleEntity, "name", {
          value: articleTableName.charAt(0).toUpperCase() + articleTableName.slice(1),
          writable: false,
        });

        Reflect.defineMetadata("design:type", Number, ArticleEntity.prototype, "id");
        PrimaryGeneratedColumn()(ArticleEntity.prototype, "id");

        Reflect.defineMetadata("design:type", String, ArticleEntity.prototype, "articleTitle");
        Column({ type: "varchar", length: 255 })(ArticleEntity.prototype, "articleTitle");

        Reflect.defineMetadata("design:type", String, ArticleEntity.prototype, "bodyContent");
        Column({ type: "text" })(ArticleEntity.prototype, "bodyContent");

        // Explicit name — should NOT be transformed by SnakeNamingStrategy
        Reflect.defineMetadata("design:type", String, ArticleEntity.prototype, "customField");
        Column({ type: "varchar", length: 50, name: "MY_CUSTOM_COL", nullable: true })(
          ArticleEntity.prototype,
          "customField",
        );

        Entity({ name: articleTableName })(ArticleEntity);

        return { entities: [AuthorEntity, ArticleEntity] };
      },
    );
  }, 30000);

  afterAll(async () => {
    try {
      await dropTestTable(articleTableName);
    } catch {}
    try {
      await dropTestTable(authorTableName);
    } catch {}
    await conn?.cleanup();
  }, 15000);

  beforeEach(async () => {
    try { await truncateTestTable(articleTableName); } catch {}
    try { await truncateTestTable(authorTableName); } catch {}
  });

  // ── Schema verification ─────────────────────────────

  it("should create table with snake_case column names", async () => {
    const driverType = DatabaseClient.getInstance().type;
    let columns: string[];

    if (driverType === "postgres") {
      const result = await rawQuery(
        `SELECT column_name FROM information_schema.columns WHERE table_name = '${authorTableName}'`,
      );
      columns = result.map((r: any) => r.column_name);
    } else {
      const result = await rawQuery(`SHOW COLUMNS FROM \`${authorTableName}\``);
      columns = result.map((r: any) => r.Field);
    }

    expect(columns).toContain("id");
    expect(columns).toContain("first_name");
    expect(columns).toContain("last_name");
    expect(columns).toContain("post_count");
    expect(columns).toContain("is_active");
    // Should NOT contain camelCase names
    expect(columns).not.toContain("firstName");
    expect(columns).not.toContain("lastName");
    expect(columns).not.toContain("postCount");
    expect(columns).not.toContain("isActive");
  });

  it("should preserve explicit @Column({ name }) without transformation", async () => {
    const driverType = DatabaseClient.getInstance().type;
    let columns: string[];

    if (driverType === "postgres") {
      const result = await rawQuery(
        `SELECT column_name FROM information_schema.columns WHERE table_name = '${articleTableName}'`,
      );
      columns = result.map((r: any) => r.column_name);
    } else {
      const result = await rawQuery(`SHOW COLUMNS FROM \`${articleTableName}\``);
      columns = result.map((r: any) => r.Field);
    }

    expect(columns).toContain("article_title");
    expect(columns).toContain("body_content");
    expect(columns).toContain("MY_CUSTOM_COL"); // explicit name preserved
  });

  // ── INSERT (save) ───────────────────────────────────

  it("should save entity with camelCase properties to snake_case columns", async () => {
    const em = conn.em as any;

    const saved = await em.save(AuthorEntity, {
      firstName: "John",
      lastName: "Doe",
      postCount: 5,
      isActive: true,
    });

    expect(saved).toBeDefined();
    expect(saved.id).toBeDefined();
    expect(saved.firstName).toBe("John");
    expect(saved.lastName).toBe("Doe");

    // Verify raw DB has snake_case columns
    const driverType = DatabaseClient.getInstance().type;
    const q = driverType === "postgres" ? `"` : "`";
    const rows = await rawQuery(
      `SELECT ${q}first_name${q}, ${q}last_name${q}, ${q}post_count${q} FROM ${q}${authorTableName}${q} WHERE ${q}id${q} = ${saved.id}`,
    );
    const row = Array.isArray(rows) ? rows[0] : (rows as any)?.rows?.[0];
    expect(row.first_name).toBe("John");
    expect(row.last_name).toBe("Doe");
    expect(Number(row.post_count)).toBe(5);
  });

  // ── SELECT (find) ──────────────────────────────────

  it("should find entities using camelCase property names in where clause", async () => {
    const em = conn.em as any;

    await em.save(AuthorEntity, { firstName: "Alice", lastName: "Smith", postCount: 3 });
    await em.save(AuthorEntity, { firstName: "Bob", lastName: "Jones", postCount: 7 });

    const results = await em.find(AuthorEntity, {
      where: { firstName: "Alice" },
    });

    expect(results).toHaveLength(1);
    expect(results[0].firstName).toBe("Alice");
    expect(results[0].lastName).toBe("Smith");
  });

  it("should support orderBy with camelCase property names", async () => {
    const em = conn.em as any;

    await em.save(AuthorEntity, { firstName: "Charlie", lastName: "A", postCount: 1 });
    await em.save(AuthorEntity, { firstName: "Alice", lastName: "B", postCount: 2 });
    await em.save(AuthorEntity, { firstName: "Bob", lastName: "C", postCount: 3 });

    const results = await em.find(AuthorEntity, {
      orderBy: { firstName: "ASC" },
    });

    expect(results).toHaveLength(3);
    expect(results[0].firstName).toBe("Alice");
    expect(results[1].firstName).toBe("Bob");
    expect(results[2].firstName).toBe("Charlie");
  });

  it("should support select with camelCase property names", async () => {
    const em = conn.em as any;

    await em.save(AuthorEntity, { firstName: "Diana", lastName: "Prince", postCount: 10 });

    const results = await em.find(AuthorEntity, {
      where: { firstName: "Diana" },
      select: ["id", "firstName"],
    });

    expect(results).toHaveLength(1);
    expect(results[0].firstName).toBe("Diana");
  });

  // ── UPDATE ─────────────────────────────────────────

  it("should update entities using camelCase property names", async () => {
    const em = conn.em as any;

    const saved = await em.save(AuthorEntity, {
      firstName: "Eve",
      lastName: "Original",
      postCount: 0,
    });

    saved.lastName = "Updated";
    saved.postCount = 42;
    const updated = await em.save(AuthorEntity, saved);

    expect(updated.lastName).toBe("Updated");
    expect(updated.postCount).toBe(42);

    // Verify in DB
    const found = await em.findOne(AuthorEntity, {
      where: { id: saved.id },
    });
    expect(found!.lastName).toBe("Updated");
    expect(found!.postCount).toBe(42);
  });

  it("should updateMany with camelCase data and where keys", async () => {
    const em = conn.em as any;

    await em.save(AuthorEntity, { firstName: "Frank", lastName: "Old", postCount: 0 });
    await em.save(AuthorEntity, { firstName: "Grace", lastName: "Old", postCount: 0 });

    const result = await em.updateMany(AuthorEntity, { postCount: 99 }, {
      where: { lastName: "Old" },
    });

    expect(result.affected).toBe(2);
  });

  // ── DELETE ─────────────────────────────────────────

  it("should delete entities using camelCase criteria", async () => {
    const em = conn.em as any;

    await em.save(AuthorEntity, { firstName: "ToDelete", lastName: "X", postCount: 0 });

    const result = await em.delete(AuthorEntity, { firstName: "ToDelete" });
    expect(result.affected).toBe(1);

    const remaining = await em.find(AuthorEntity, {
      where: { firstName: "ToDelete" },
    });
    expect(remaining).toHaveLength(0);
  });

  // ── Explicit name preserved ────────────────────────

  it("should read/write explicit @Column({ name }) correctly", async () => {
    const em = conn.em as any;

    const saved = await em.save(ArticleEntity, {
      articleTitle: "Test Title",
      bodyContent: "Test body",
      customField: "custom_value",
    });

    expect(saved.customField).toBe("custom_value");

    const found = await em.findOne(ArticleEntity, {
      where: { id: saved.id },
    });
    expect(found!.articleTitle).toBe("Test Title");
    expect(found!.customField).toBe("custom_value");
  });
});
