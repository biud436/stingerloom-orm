/**
 * PostgreSQL Driver DDL Integration Tests
 *
 * Exercises the PostgresDriver's DDL methods (table/column/constraint/index/enum management)
 * against a real PostgreSQL database to verify correctness of generated SQL and
 * catalog introspection queries.
 *
 * ## Covered Methods
 * - listTables, hasTable
 * - addColumn, dropColumn
 * - addPrimaryKey, dropPrimaryKey
 * - addUniqueKey, dropUniqueKey
 * - addForeignKey, dropForeignKey
 * - addIndex, hasIndex, dropIndex
 * - moveTableToSchema
 * - addAutoIncrement
 * - executeRaw
 * - createEnumType, hasEnumType, addEnumValue, renameEnumValue, dropEnumType
 *
 * Run:
 *   INTEGRATION_TEST=true npx jest --testPathPattern="postgres-driver-ddl"
 *
 * Prerequisites:
 *   - PostgreSQL server running (PG_HOST / PG_PORT / PG_DATABASE / PG_USER / PG_PASSWORD)
 */

import "reflect-metadata";
import { PostgresDriver } from "../../src/dialects/postgres/PostgresDriver";
import { PostgresConnector } from "../../src/dialects/postgres/PostgresConnector";
import { DatabaseClientOptions } from "../../src/core/DatabaseClientOptions";

const INTEGRATION = process.env.INTEGRATION_TEST === "true";
const integrationDescribe = INTEGRATION ? describe : describe.skip;

/** Unique suffix to avoid table name collisions across parallel runs */
const SUFFIX = Date.now().toString().slice(-7);

const PG_OPTIONS: Partial<DatabaseClientOptions> = {
  type: "postgres",
  host: process.env.PG_HOST || "192.168.35.227",
  port: parseInt(process.env.PG_PORT || "5432", 10),
  username: process.env.PG_USER || "postgres",
  password: process.env.PG_PASSWORD || "postgres",
  database: process.env.PG_DATABASE || "multi_tenancy_db",
};

integrationDescribe("[Integration] PostgreSQL Driver DDL", () => {
  let connector: PostgresConnector;
  let driver: PostgresDriver;

  // Table names
  const mainTable = `pg_ddl_main_${SUFFIX}`;
  const refTable = `pg_ddl_ref_${SUFFIX}`;
  const moveTable = `pg_ddl_move_${SUFFIX}`;
  const noPkTable = `pg_ddl_nopk_${SUFFIX}`;
  const testSchema = `test_schema_${SUFFIX}`;
  const testEnum = `test_status_${SUFFIX}`;

  beforeAll(async () => {
    connector = new PostgresConnector();
    await connector.connect(PG_OPTIONS as DatabaseClientOptions);
    driver = new PostgresDriver(connector, "postgres");

    // Create main test table (no PK auto-increment — raw table for DDL testing)
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "public"."${mainTable}" (
        "id" INTEGER NOT NULL,
        "name" VARCHAR(100) NOT NULL,
        "age" INTEGER
      )`,
    );

    // Create reference table (for FK tests)
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "public"."${refTable}" (
        "id" SERIAL PRIMARY KEY,
        "label" VARCHAR(50) NOT NULL
      )`,
    );

    // Create table for moveTableToSchema test
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "public"."${moveTable}" (
        "id" SERIAL PRIMARY KEY,
        "data" TEXT
      )`,
    );

    // Create table without PK (for addPrimaryKey / dropPrimaryKey tests)
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "public"."${noPkTable}" (
        "col_a" INTEGER NOT NULL,
        "col_b" VARCHAR(50)
      )`,
    );

    // Create test schema for moveTableToSchema
    await connector.query(
      `CREATE SCHEMA IF NOT EXISTS "${testSchema}"`,
    );
  }, 30000);

  afterAll(async () => {
    // Clean up tables
    const tables = [mainTable, refTable, noPkTable];
    for (const t of tables) {
      try {
        await connector.query(`DROP TABLE IF EXISTS "public"."${t}" CASCADE`);
      } catch {
        // ignore
      }
    }

    // moveTable may be in testSchema after the move test
    try {
      await connector.query(`DROP TABLE IF EXISTS "${testSchema}"."${moveTable}" CASCADE`);
    } catch {
      // ignore
    }
    try {
      await connector.query(`DROP TABLE IF EXISTS "public"."${moveTable}" CASCADE`);
    } catch {
      // ignore
    }

    // Drop test schema
    try {
      await connector.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
    } catch {
      // ignore
    }

    // Drop test enum
    try {
      await connector.query(`DROP TYPE IF EXISTS "public"."${testEnum}" CASCADE`);
    } catch {
      // ignore
    }

    await connector.close();
  }, 15000);

  // ──────────────────────────────────────────────
  // listTables / hasTable
  // ──────────────────────────────────────────────

  it("listTables() should return an array including the test tables", async () => {
    const rows: any[] = await driver.listTables("public");
    expect(Array.isArray(rows)).toBe(true);

    const tableNames = rows.map((r: any) => r.tablename);
    expect(tableNames).toContain(mainTable);
    expect(tableNames).toContain(refTable);
  });

  it("hasTable() should return rows for an existing table", async () => {
    const rows: any[] = await driver.hasTable(mainTable);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].tablename).toBe(mainTable);
  });

  it("hasTable() should return empty array for a non-existent table", async () => {
    const rows: any[] = await driver.hasTable("nonexistent_table_xyz_999");
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(0);
  });

  // ──────────────────────────────────────────────
  // addColumn / dropColumn
  // ──────────────────────────────────────────────

  it("addColumn() should add a new column to the table", async () => {
    await driver.addColumn(mainTable, "email", "VARCHAR(200)");

    const cols: any[] = await connector.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = '${mainTable}' AND column_name = 'email'`,
    );
    expect(cols.length).toBe(1);
    expect(cols[0].column_name).toBe("email");
  });

  it("dropColumn() should remove the column from the table", async () => {
    await driver.dropColumn(mainTable, "email");

    const cols: any[] = await connector.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = '${mainTable}' AND column_name = 'email'`,
    );
    expect(cols.length).toBe(0);
  });

  // ──────────────────────────────────────────────
  // addPrimaryKey / dropPrimaryKey
  // ──────────────────────────────────────────────

  it("addPrimaryKey() should add a primary key constraint", async () => {
    await driver.addPrimaryKey(noPkTable, "col_a");

    const rows: any[] = await connector.query(
      `SELECT constraint_name FROM information_schema.table_constraints
       WHERE table_schema = 'public' AND table_name = '${noPkTable}' AND constraint_type = 'PRIMARY KEY'`,
    );
    expect(rows.length).toBe(1);
  });

  it("dropPrimaryKey() should remove the primary key constraint", async () => {
    await driver.dropPrimaryKey(noPkTable);

    const rows: any[] = await connector.query(
      `SELECT constraint_name FROM information_schema.table_constraints
       WHERE table_schema = 'public' AND table_name = '${noPkTable}' AND constraint_type = 'PRIMARY KEY'`,
    );
    expect(rows.length).toBe(0);
  });

  it("dropPrimaryKey() should throw when table has no primary key", async () => {
    // noPkTable now has no PK (dropped in previous test)
    await expect(driver.dropPrimaryKey(noPkTable)).rejects.toThrow();
  });

  // ──────────────────────────────────────────────
  // addUniqueKey / dropUniqueKey
  // ──────────────────────────────────────────────

  it("addUniqueKey() should add a unique constraint on a column", async () => {
    await driver.addUniqueKey(mainTable, "name");

    const rows: any[] = await connector.query(
      `SELECT constraint_name FROM information_schema.table_constraints
       WHERE table_schema = 'public' AND table_name = '${mainTable}' AND constraint_type = 'UNIQUE'`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("dropUniqueKey() should remove the unique constraint", async () => {
    await driver.dropUniqueKey(mainTable, "name");

    const rows: any[] = await connector.query(
      `SELECT c.conname
       FROM pg_constraint c
       JOIN pg_class t ON c.conrelid = t.oid
       JOIN pg_namespace n ON t.relnamespace = n.oid
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
       WHERE c.contype = 'u' AND t.relname = '${mainTable}' AND n.nspname = 'public' AND a.attname = 'name'`,
    );
    expect(rows.length).toBe(0);
  });

  it("dropUniqueKey() should throw when no unique constraint exists on column", async () => {
    await expect(driver.dropUniqueKey(mainTable, "age")).rejects.toThrow();
  });

  // ──────────────────────────────────────────────
  // addForeignKey / dropForeignKey
  // ──────────────────────────────────────────────

  it("addForeignKey() should create a foreign key constraint", async () => {
    // First, add a column that references refTable.id
    await driver.addColumn(mainTable, "ref_id", "INTEGER");
    await driver.addForeignKey(mainTable, "ref_id", refTable, "id");

    const rows: any[] = await connector.query(
      `SELECT constraint_name FROM information_schema.table_constraints
       WHERE table_schema = 'public' AND table_name = '${mainTable}' AND constraint_type = 'FOREIGN KEY'`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("dropForeignKey() should remove the foreign key constraint", async () => {
    await driver.dropForeignKey(mainTable, "ref_id");

    const rows: any[] = await connector.query(
      `SELECT c.conname
       FROM pg_constraint c
       JOIN pg_class t ON c.conrelid = t.oid
       JOIN pg_namespace n ON t.relnamespace = n.oid
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
       WHERE c.contype = 'f' AND t.relname = '${mainTable}' AND n.nspname = 'public' AND a.attname = 'ref_id'`,
    );
    expect(rows.length).toBe(0);

    // Clean up the ref_id column
    await driver.dropColumn(mainTable, "ref_id");
  });

  it("dropForeignKey() should throw when no FK exists on column", async () => {
    await expect(driver.dropForeignKey(mainTable, "name")).rejects.toThrow();
  });

  // ──────────────────────────────────────────────
  // addIndex / hasIndex / dropIndex
  // ──────────────────────────────────────────────

  it("addIndex() should create an index on a column", async () => {
    const indexName = `idx_${mainTable}_age`;
    await driver.addIndex(mainTable, "age", indexName);

    const rows: any[] = await connector.query(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = '${mainTable}' AND indexname = '${indexName}'`,
    );
    expect(rows.length).toBe(1);
  });

  it("hasIndex() should return count > 0 for existing index", async () => {
    const indexName = `idx_${mainTable}_age`;
    const rows: any[] = await driver.hasIndex(mainTable, indexName);
    expect(rows.length).toBeGreaterThanOrEqual(1);

    const count = parseInt(rows[0].count, 10);
    expect(count).toBeGreaterThan(0);
  });

  it("hasIndex() should return count = 0 for non-existent index", async () => {
    const rows: any[] = await driver.hasIndex(mainTable, "nonexistent_index_xyz");
    expect(rows.length).toBeGreaterThanOrEqual(1);

    const count = parseInt(rows[0].count, 10);
    expect(count).toBe(0);
  });

  it("dropIndex() should remove the index", async () => {
    const indexName = `idx_${mainTable}_age`;
    await driver.dropIndex(mainTable, indexName);

    const rows: any[] = await connector.query(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = '${mainTable}' AND indexname = '${indexName}'`,
    );
    expect(rows.length).toBe(0);
  });

  // ──────────────────────────────────────────────
  // moveTableToSchema
  // ──────────────────────────────────────────────

  it("moveTableToSchema() should move a table to a different schema", async () => {
    await driver.moveTableToSchema(moveTable, testSchema);

    // Verify table no longer exists in public
    const publicRows: any[] = await connector.query(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tablename = '${moveTable}'`,
    );
    expect(publicRows.length).toBe(0);

    // Verify table exists in test schema
    const schemaRows: any[] = await connector.query(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = '${testSchema}' AND tablename = '${moveTable}'`,
    );
    expect(schemaRows.length).toBe(1);
  });

  // ──────────────────────────────────────────────
  // addAutoIncrement
  // ──────────────────────────────────────────────

  it("addAutoIncrement() should add GENERATED ALWAYS AS IDENTITY to a column", async () => {
    // Use noPkTable's col_a (INTEGER NOT NULL, no PK anymore)
    await driver.addAutoIncrement(noPkTable, "col_a");

    const cols: any[] = await connector.query(
      `SELECT is_identity, identity_generation FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = '${noPkTable}' AND column_name = 'col_a'`,
    );
    expect(cols.length).toBe(1);
    expect(cols[0].is_identity).toBe("YES");
    expect(cols[0].identity_generation).toBe("ALWAYS");
  });

  // ──────────────────────────────────────────────
  // executeRaw
  // ──────────────────────────────────────────────

  it("executeRaw() should execute arbitrary SQL and return results", async () => {
    const rows: any[] = await driver.executeRaw("SELECT 1 + 1 AS result");
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(1);
    expect(rows[0].result).toBe(2);
  });

  it("executeRaw() should be able to create and query a temp table", async () => {
    const tempTable = `pg_ddl_temp_${SUFFIX}`;
    await driver.executeRaw(
      `CREATE TEMP TABLE "${tempTable}" ("val" INTEGER)`,
    );
    await driver.executeRaw(
      `INSERT INTO "${tempTable}" ("val") VALUES (42), (99)`,
    );
    const rows: any[] = await driver.executeRaw(
      `SELECT "val" FROM "${tempTable}" ORDER BY "val"`,
    );
    expect(rows.length).toBe(2);
    expect(rows[0].val).toBe(42);
    expect(rows[1].val).toBe(99);

    await driver.executeRaw(`DROP TABLE "${tempTable}"`);
  });

  // ──────────────────────────────────────────────
  // ENUM: createEnumType / hasEnumType / addEnumValue / renameEnumValue / dropEnumType
  // ──────────────────────────────────────────────

  it("createEnumType() should create a new ENUM type", async () => {
    await driver.createEnumType(testEnum, ["active", "inactive", "pending"]);

    const rows: any[] = await driver.hasEnumType(testEnum);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].typname).toBe(testEnum);
  });

  it("hasEnumType() should return empty array for non-existent enum", async () => {
    const rows: any[] = await driver.hasEnumType("nonexistent_enum_xyz_999");
    expect(rows.length).toBe(0);
  });

  it("addEnumValue() should add a new value to the ENUM", async () => {
    await driver.addEnumValue(testEnum, "archived");

    const values: any[] = await driver.listEnumValues(testEnum);
    const labels = values.map((v: any) => v.enumlabel);
    expect(labels).toContain("archived");
  });

  it("addEnumValue() with placement should insert value at correct position", async () => {
    await driver.addEnumValue(testEnum, "suspended", { after: "active" });

    const values: any[] = await driver.listEnumValues(testEnum);
    const labels = values.map((v: any) => v.enumlabel);
    const activeIdx = labels.indexOf("active");
    const suspendedIdx = labels.indexOf("suspended");
    expect(suspendedIdx).toBeGreaterThan(activeIdx);
  });

  it("renameEnumValue() should rename an existing enum value", async () => {
    await driver.renameEnumValue(testEnum, "pending", "waiting");

    const values: any[] = await driver.listEnumValues(testEnum);
    const labels = values.map((v: any) => v.enumlabel);
    expect(labels).not.toContain("pending");
    expect(labels).toContain("waiting");
  });

  it("createEnumType() should sync values when enum already exists (add missing values)", async () => {
    // Call createEnumType again with an additional value — should add it, not error
    await driver.createEnumType(testEnum, [
      "active",
      "inactive",
      "waiting",
      "archived",
      "suspended",
      "deleted",
    ]);

    const values: any[] = await driver.listEnumValues(testEnum);
    const labels = values.map((v: any) => v.enumlabel);
    expect(labels).toContain("deleted");
  });

  it("dropEnumType() should remove the ENUM type", async () => {
    await driver.dropEnumType(testEnum, true);

    const rows: any[] = await driver.hasEnumType(testEnum);
    expect(rows.length).toBe(0);
  });

  it("dropEnumType() should not throw when dropping a non-existent enum (IF EXISTS)", async () => {
    // Should not throw because the driver uses DROP TYPE IF EXISTS
    await expect(
      driver.dropEnumType("nonexistent_enum_xyz_999"),
    ).resolves.not.toThrow();
  });
});
