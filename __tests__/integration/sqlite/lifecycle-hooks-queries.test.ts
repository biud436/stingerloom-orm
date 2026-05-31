/**
 * SQLite In-Memory: Lifecycle Hooks + Complex Queries
 *
 * Two feature groups tested against SQLite in-memory:
 * 1. Lifecycle Hooks — @BeforeInsert, @AfterInsert, @BeforeUpdate, @AfterUpdate
 *    via HOOK_TOKEN metadata on dynamic entity classes.
 * 2. Complex Queries — findAndCount(), pagination (limit tuple), orderBy,
 *    where operators (gt, lt, in, between, like, not), take.
 */

import "reflect-metadata";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
} from "../../../src";
import { HOOK_TOKEN } from "../../../src/decorators/Hooks";
import type { HookMetadata } from "../../../src/decorators/Hooks";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";
import { DatabaseClient } from "../../../src/DatabaseClient";

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function shortTableName(prefix: string): string {
  const ts = String(Date.now()).slice(-7);
  return `${prefix}_${ts}`;
}

function clearScanners(): void {
  getScannerInstance(ColumnScanner).clear();
}

/**
 * Creates an entity instance with prototype chain intact so that
 * hook methods are reachable via `item[methodName]()`.
 */
function createInstance(
  EntityClass: new () => any,
  data: Record<string, any>,
): any {
  const instance = Object.create(EntityClass.prototype);
  Object.assign(instance, data);
  return instance;
}

// ─────────────────────────────────────────────────────────
// 1. Lifecycle Hooks
// ─────────────────────────────────────────────────────────

describe("[Integration] SQLite: Lifecycle Hooks", () => {
  let conn: TestConnectionResult;
  let HookEntity: new () => any;
  let tableName: string;
  let hookCalls: string[];

  beforeAll(async () => {
    tableName = shortTableName("hooks");
    hookCalls = [];

    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: false,
        logging: false,
      },
      () => {
        clearScanners();

        const DC = class {} as any;
        Object.defineProperty(DC, "name", { value: tableName });

        // Define hook methods on the prototype
        DC.prototype.onBeforeInsert = function () {
          hookCalls.push("beforeInsert");
          this.name = "HOOK_" + this.name;
        };
        DC.prototype.onAfterInsert = function () {
          hookCalls.push("afterInsert");
        };
        DC.prototype.onBeforeUpdate = function () {
          hookCalls.push("beforeUpdate");
          this.name = "UPD_" + this.name;
        };
        DC.prototype.onAfterUpdate = function () {
          hookCalls.push("afterUpdate");
        };

        // id
        Reflect.defineMetadata("design:type", Number, DC.prototype, "id");
        PrimaryGeneratedColumn()(DC.prototype, "id");

        // name
        Reflect.defineMetadata("design:type", String, DC.prototype, "name");
        Column()(DC.prototype, "name");

        // age
        Reflect.defineMetadata("design:type", Number, DC.prototype, "age");
        Column({ type: "int" })(DC.prototype, "age");

        // Register hooks via HOOK_TOKEN metadata
        const hooks: HookMetadata[] = [
          { methodName: "onBeforeInsert", event: "beforeInsert" },
          { methodName: "onAfterInsert", event: "afterInsert" },
          { methodName: "onBeforeUpdate", event: "beforeUpdate" },
          { methodName: "onAfterUpdate", event: "afterUpdate" },
        ];
        Reflect.defineMetadata(HOOK_TOKEN, hooks, DC);

        Entity()(DC);
        HookEntity = DC;
        return { entities: [DC] };
      },
    );

    // Manual CREATE TABLE
    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(`
      CREATE TABLE IF NOT EXISTS "${tableName}" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "name" TEXT NOT NULL,
        "age" INTEGER NOT NULL
      )
    `);
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  beforeEach(async () => {
    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(`DELETE FROM "${tableName}"`);
    hookCalls = [];
  });

  // Helper to create a proper prototype-based instance
  function inst(data: Record<string, any>) {
    return createInstance(HookEntity, data);
  }

  it("@BeforeInsert should modify entity state before INSERT", async () => {
    const instance = inst({ name: "Alice", age: 25 });
    const saved = await conn.em.save(HookEntity, instance);

    // The beforeInsert hook prepends "HOOK_" to the name
    expect(instance.name).toBe("HOOK_Alice");
    expect(hookCalls).toContain("beforeInsert");

    // Verify in DB
    const connector = DatabaseClient.getInstance().getConnection();
    const rows = await connector.query(
      `SELECT "name" FROM "${tableName}" WHERE "id" = ${saved.id}`,
    );
    expect(rows[0].name).toBe("HOOK_Alice");
  });

  it("@AfterInsert should run after entity is saved", async () => {
    await conn.em.save(HookEntity, inst({ name: "Bob", age: 30 }));

    expect(hookCalls).toContain("afterInsert");

    // afterInsert should come after beforeInsert
    const beforeIdx = hookCalls.indexOf("beforeInsert");
    const afterIdx = hookCalls.indexOf("afterInsert");
    expect(beforeIdx).toBeGreaterThanOrEqual(0);
    expect(afterIdx).toBeGreaterThanOrEqual(0);
    expect(beforeIdx).toBeLessThan(afterIdx);
  });

  it("@BeforeUpdate should modify entity before UPDATE", async () => {
    const saved = await conn.em.save(HookEntity, inst({ name: "Charlie", age: 20 }));
    hookCalls = [];

    // Update with PK to trigger update hooks
    const updated = await conn.em.save(
      HookEntity,
      inst({ id: saved.id, name: "HOOK_Charlie", age: 21 }),
    );

    expect(hookCalls).toContain("beforeUpdate");

    // The beforeUpdate hook prepends "UPD_"
    const connector = DatabaseClient.getInstance().getConnection();
    const rows = await connector.query(
      `SELECT "name" FROM "${tableName}" WHERE "id" = ${saved.id}`,
    );
    expect(rows[0].name).toContain("UPD_");
  });

  it("@AfterUpdate should run after UPDATE completes", async () => {
    const saved = await conn.em.save(HookEntity, inst({ name: "Diana", age: 28 }));
    hookCalls = [];

    await conn.em.save(
      HookEntity,
      inst({ id: saved.id, name: "HOOK_Diana", age: 29 }),
    );

    expect(hookCalls).toContain("afterUpdate");

    const beforeIdx = hookCalls.indexOf("beforeUpdate");
    const afterIdx = hookCalls.indexOf("afterUpdate");
    expect(beforeIdx).toBeGreaterThanOrEqual(0);
    expect(afterIdx).toBeGreaterThanOrEqual(0);
    expect(beforeIdx).toBeLessThan(afterIdx);
  });

  it("INSERT hooks should NOT run on UPDATE", async () => {
    const saved = await conn.em.save(HookEntity, inst({ name: "Eve", age: 22 }));
    hookCalls = [];

    await conn.em.save(
      HookEntity,
      inst({ id: saved.id, name: "HOOK_Eve Modified", age: 23 }),
    );

    expect(hookCalls).not.toContain("beforeInsert");
    expect(hookCalls).not.toContain("afterInsert");
    expect(hookCalls).toContain("beforeUpdate");
    expect(hookCalls).toContain("afterUpdate");
  });

  it("full lifecycle: INSERT hooks then UPDATE hooks in correct order", async () => {
    // INSERT phase
    const saved = await conn.em.save(HookEntity, inst({ name: "Frank", age: 40 }));
    expect(hookCalls).toEqual(["beforeInsert", "afterInsert"]);

    hookCalls = [];

    // UPDATE phase
    await conn.em.save(
      HookEntity,
      inst({ id: saved.id, name: "HOOK_Frank Updated", age: 41 }),
    );
    expect(hookCalls).toEqual(["beforeUpdate", "afterUpdate"]);
  });
});

// ─────────────────────────────────────────────────────────
// 2. Complex Queries
// ─────────────────────────────────────────────────────────

describe("[Integration] SQLite: Complex Queries", () => {
  let conn: TestConnectionResult;
  let QEntity: new () => any;
  let tableName: string;

  beforeAll(async () => {
    tableName = shortTableName("query");

    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: false,
        logging: false,
      },
      () => {
        clearScanners();

        const DC = class {} as any;
        Object.defineProperty(DC, "name", { value: tableName });

        // id
        Reflect.defineMetadata("design:type", Number, DC.prototype, "id");
        PrimaryGeneratedColumn()(DC.prototype, "id");

        // name
        Reflect.defineMetadata("design:type", String, DC.prototype, "name");
        Column()(DC.prototype, "name");

        // age
        Reflect.defineMetadata("design:type", Number, DC.prototype, "age");
        Column({ type: "int" })(DC.prototype, "age");

        // email (nullable)
        Reflect.defineMetadata("design:type", String, DC.prototype, "email");
        Column({ type: "varchar", length: 255, nullable: true })(DC.prototype, "email");

        Entity()(DC);
        QEntity = DC;
        return { entities: [DC] };
      },
    );

    // Manual CREATE TABLE
    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(`
      CREATE TABLE IF NOT EXISTS "${tableName}" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "name" TEXT NOT NULL,
        "age" INTEGER NOT NULL,
        "email" TEXT
      )
    `);

    // Seed 10 rows with varying ages and names
    const seedData = [
      { name: "Alice",   age: 20, email: "alice@test.com" },
      { name: "Bob",     age: 25, email: "bob@test.com" },
      { name: "Charlie", age: 30, email: "charlie@test.com" },
      { name: "Diana",   age: 35, email: "diana@test.com" },
      { name: "Eve",     age: 40, email: null },
      { name: "Frank",   age: 22, email: "frank@test.com" },
      { name: "Grace",   age: 28, email: "grace@test.com" },
      { name: "Hank",    age: 33, email: null },
      { name: "Ivy",     age: 27, email: "ivy@test.com" },
      { name: "Jack",    age: 45, email: "jack@test.com" },
    ];

    for (const row of seedData) {
      await conn.em.save(QEntity, row as any);
    }
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  // ─── findAndCount ─────────────────────────────────────

  it("findAndCount() should return [items, totalCount]", async () => {
    const [items, count] = await conn.em.findAndCount(QEntity, {});

    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBe(10);
    expect(count).toBe(10);
  });

  it("findAndCount() with where should filter and return correct count", async () => {
    const [items, count] = await conn.em.findAndCount(QEntity, {
      where: { age: { gt: 30 } } as any,
    });

    // ages > 30: Diana(35), Eve(40), Hank(33), Jack(45) = 4
    expect(items.length).toBe(4);
    expect(count).toBe(4);
    for (const item of items) {
      expect((item as any).age).toBeGreaterThan(30);
    }
  });

  // ─── pagination with limit [offset, count] ───────────

  it("pagination with limit [offset, count] should return correct slice", async () => {
    const results = await conn.em.find(QEntity, {
      orderBy: { age: "ASC" } as any,
      limit: [2, 3],
    });

    // ASC by age: 20, 22, 25, 27, 28, 30, 33, 35, 40, 45
    // offset 2, count 3 → ages 25, 27, 28
    expect(results.length).toBe(3);
    expect((results[0] as any).age).toBe(25);
    expect((results[1] as any).age).toBe(27);
    expect((results[2] as any).age).toBe(28);
  });

  it("limit [offset, 0] should return an empty array (#364)", async () => {
    // An explicit count of 0 means "no rows" (LIMIT 0); the validator permits
    // it. Previously the count was silently rewritten to 1.
    const none = await conn.em.find(QEntity, {
      orderBy: { age: "ASC" } as any,
      limit: [0, 0],
    });
    expect(none).toEqual([]);

    const noneOffset = await conn.em.find(QEntity, {
      orderBy: { age: "ASC" } as any,
      limit: [5, 0],
    });
    expect(noneOffset).toEqual([]);
  });

  // ─── orderBy ──────────────────────────────────────────

  it("orderBy ASC should sort in ascending order", async () => {
    const results = await conn.em.find(QEntity, {
      orderBy: { age: "ASC" } as any,
    });

    expect(results.length).toBe(10);
    for (let i = 1; i < results.length; i++) {
      expect((results[i] as any).age).toBeGreaterThanOrEqual(
        (results[i - 1] as any).age,
      );
    }
  });

  it("orderBy DESC should sort in descending order", async () => {
    const results = await conn.em.find(QEntity, {
      orderBy: { age: "DESC" } as any,
    });

    expect(results.length).toBe(10);
    for (let i = 1; i < results.length; i++) {
      expect((results[i] as any).age).toBeLessThanOrEqual(
        (results[i - 1] as any).age,
      );
    }
  });

  // ─── where operators ──────────────────────────────────

  it("where with gt operator should filter correctly", async () => {
    const results = await conn.em.find(QEntity, {
      where: { age: { gt: 35 } } as any,
    });

    // ages > 35: Eve(40), Jack(45)
    expect(results.length).toBe(2);
    for (const item of results) {
      expect((item as any).age).toBeGreaterThan(35);
    }
  });

  it("where with lt operator should filter correctly", async () => {
    const results = await conn.em.find(QEntity, {
      where: { age: { lt: 25 } } as any,
    });

    // ages < 25: Alice(20), Frank(22)
    expect(results.length).toBe(2);
    for (const item of results) {
      expect((item as any).age).toBeLessThan(25);
    }
  });

  it("where with in operator should filter correctly", async () => {
    const results = await conn.em.find(QEntity, {
      where: { age: { in: [20, 30, 45] } } as any,
    });

    // ages in [20, 30, 45]: Alice(20), Charlie(30), Jack(45)
    expect(results.length).toBe(3);
    const ages = results.map((r: any) => r.age).sort((a: number, b: number) => a - b);
    expect(ages).toEqual([20, 30, 45]);
  });

  it("where with between operator should filter correctly", async () => {
    const results = await conn.em.find(QEntity, {
      where: { age: { between: [25, 33] } } as any,
    });

    // ages 25..33 inclusive: Bob(25), Charlie(30), Grace(28), Hank(33), Ivy(27)
    expect(results.length).toBe(5);
    for (const item of results) {
      expect((item as any).age).toBeGreaterThanOrEqual(25);
      expect((item as any).age).toBeLessThanOrEqual(33);
    }
  });

  it("where with like operator should filter correctly", async () => {
    const results = await conn.em.find(QEntity, {
      where: { name: { like: "%an%" } } as any,
    });

    // names containing "an": Diana, Frank, Hank
    expect(results.length).toBeGreaterThanOrEqual(2);
    for (const item of results) {
      expect((item as any).name.toLowerCase()).toContain("an");
    }
  });

  it("where with not operator should filter correctly", async () => {
    const results = await conn.em.find(QEntity, {
      where: { age: { not: 25 } } as any,
    });

    // All except Bob(25) → 9 rows
    expect(results.length).toBe(9);
    for (const item of results) {
      expect((item as any).age).not.toBe(25);
    }
  });

  // ─── take option ──────────────────────────────────────

  it("take option should limit result count", async () => {
    const results = await conn.em.find(QEntity, {
      take: 5,
    });

    expect(results.length).toBe(5);
  });

  // ─── combined where + orderBy + limit ─────────────────

  it("combined where + orderBy + limit should work together", async () => {
    const results = await conn.em.find(QEntity, {
      where: { age: { gt: 22 } } as any,
      orderBy: { age: "DESC" } as any,
      limit: [0, 3],
    });

    // ages > 22: 25, 27, 28, 30, 33, 35, 40, 45 → DESC → 45, 40, 35 (first 3)
    expect(results.length).toBe(3);
    expect((results[0] as any).age).toBe(45);
    expect((results[1] as any).age).toBe(40);
    expect((results[2] as any).age).toBe(35);
  });

  it("findAndCount with limit should return limited items but full count", async () => {
    const [items, count] = await conn.em.findAndCount(QEntity, {
      limit: 3,
      orderBy: { name: "ASC" } as any,
    });

    expect(items.length).toBe(3);
    expect(count).toBe(10);
  });
});
