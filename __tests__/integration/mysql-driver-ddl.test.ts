/**
 * MySQL/MariaDB Driver DDL Integration Tests
 *
 * Exercises the MySqlDriver's DDL methods (table/column/constraint/index management)
 * against a real MySQL/MariaDB database to verify correctness of generated SQL and
 * INFORMATION_SCHEMA introspection queries.
 *
 * ## Covered Methods
 * - hasTable
 * - addColumn, dropColumn, hasColumn
 * - addPrimaryKey, dropPrimaryKey
 * - addUniqueKey, dropUniqueKey
 * - addForeignKey, dropForeignKey, hasForeignKey, generateForeignKeyName
 * - addIndex, hasIndex, dropIndex
 * - addAutoIncrement
 * - executeRaw
 * - queryWithOptions
 * - getSchemas, getIndexes, getForeignKeys, getPrimaryKeys
 * - clear
 *
 * Run:
 *   INTEGRATION_TEST=true DB_HOST=192.168.35.227 DB_PORT=3306 DB_NAME=cats_db \
 *     DB_USER=mariadb DB_PASSWORD=mariadb npx jest --testPathPattern="mysql-driver-ddl"
 *
 * Prerequisites:
 *   - MySQL/MariaDB server running with the above credentials
 */

import "reflect-metadata";
import sql from "sql-template-tag";
import { MySqlDriver } from "../../src/dialects/mysql/MySqlDriver";
import { MySqlConnector } from "../../src/dialects/mysql/MySqlConnector";
import { DatabaseClientOptions } from "../../src/core/DatabaseClientOptions";

const INTEGRATION = process.env.INTEGRATION_TEST === "true"
  && process.env.INTEGRATION_TEST_MYSQL !== "false";
const integrationDescribe = INTEGRATION ? describe : describe.skip;

/** Unique suffix to avoid table name collisions across parallel runs */
const SUFFIX = Date.now().toString().slice(-7);

const MYSQL_OPTIONS: Partial<DatabaseClientOptions> = {
  type: "mysql",
  host: process.env.DB_HOST || "192.168.35.227",
  port: parseInt(process.env.DB_PORT || "3306", 10),
  username: process.env.DB_USER || "mariadb",
  password: process.env.DB_PASSWORD || "mariadb",
  database: process.env.DB_NAME || "cats_db",
};

integrationDescribe("[Integration] MySQL Driver DDL", () => {
  let connector: MySqlConnector;
  let driver: MySqlDriver;

  // Table names
  const mainTable = `my_ddl_main_${SUFFIX}`;
  const refTable = `my_ddl_ref_${SUFFIX}`;
  const noPkTable = `my_ddl_nopk_${SUFFIX}`;
  const clearTable = `my_ddl_clear_${SUFFIX}`;

  beforeAll(async () => {
    connector = new MySqlConnector();
    await connector.connect(MYSQL_OPTIONS as DatabaseClientOptions);
    driver = new MySqlDriver(connector, "mysql");

    // Create main test table (id without AUTO_INCREMENT so PK can be dropped)
    await connector.query(
      `CREATE TABLE IF NOT EXISTS \`${mainTable}\` (
        \`id\` INT NOT NULL,
        \`name\` VARCHAR(100) NOT NULL,
        \`age\` INT NULL,
        PRIMARY KEY (\`id\`)
      )`,
    );

    // Create reference table (for FK tests)
    await connector.query(
      `CREATE TABLE IF NOT EXISTS \`${refTable}\` (
        \`id\` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        \`label\` VARCHAR(50) NOT NULL
      )`,
    );

    // Create table without PK (for addPrimaryKey / dropPrimaryKey tests)
    await connector.query(
      `CREATE TABLE IF NOT EXISTS \`${noPkTable}\` (
        \`col_a\` INT NOT NULL,
        \`col_b\` VARCHAR(50) NULL
      )`,
    );

    // Create table for clear() test
    await connector.query(
      `CREATE TABLE IF NOT EXISTS \`${clearTable}\` (
        \`id\` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        \`val\` VARCHAR(50) NULL
      )`,
    );
  }, 30000);

  afterAll(async () => {
    const tables = [mainTable, refTable, noPkTable, clearTable];
    for (const t of tables) {
      try {
        await connector.query(`DROP TABLE IF EXISTS \`${t}\``);
      } catch {
        // ignore
      }
    }
    await connector.close();
  }, 15000);

  // ──────────────────────────────────────────────
  // hasTable
  // ──────────────────────────────────────────────

  it("hasTable() should return rows for an existing table", async () => {
    const rows: any[] = await driver.hasTable(mainTable);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("hasTable() should return empty array for a non-existent table", async () => {
    const rows: any[] = await driver.hasTable("nonexistent_table_xyz_999");
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(0);
  });

  // ──────────────────────────────────────────────
  // addColumn / hasColumn / dropColumn
  // ──────────────────────────────────────────────

  it("addColumn() should add a new column to the table", async () => {
    await driver.addColumn(mainTable, "email", "VARCHAR(200)");

    const exists = await driver.hasColumn(mainTable, "email");
    expect(exists).toBe(true);
  });

  it("hasColumn() should return false for a non-existent column", async () => {
    const exists = await driver.hasColumn(mainTable, "nonexistent_col_xyz");
    expect(exists).toBe(false);
  });

  it("dropColumn() should remove the column from the table", async () => {
    await driver.dropColumn(mainTable, "email");

    const exists = await driver.hasColumn(mainTable, "email");
    expect(exists).toBe(false);
  });

  // ──────────────────────────────────────────────
  // addPrimaryKey / dropPrimaryKey
  // ──────────────────────────────────────────────

  it("addPrimaryKey() should add a primary key constraint", async () => {
    await driver.addPrimaryKey(noPkTable, "col_a");

    const rows: any[] = await driver.getPrimaryKeys(noPkTable);
    expect(rows.length).toBe(1);
    expect(rows[0].COLUMN_NAME).toBe("col_a");
  });

  it("dropPrimaryKey() should remove the primary key constraint", async () => {
    await driver.dropPrimaryKey(noPkTable);

    const rows: any[] = await driver.getPrimaryKeys(noPkTable);
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

    // Verify via SHOW INDEXES — unique indexes have Non_unique = 0
    const indexes: any[] = await driver.getIndexes(mainTable);
    const uniqueOnName = indexes.find(
      (idx: any) => idx.Column_name === "name" && idx.Non_unique === 0,
    );
    expect(uniqueOnName).toBeDefined();
  });

  it("dropUniqueKey() should remove the unique constraint", async () => {
    await driver.dropUniqueKey(mainTable, "name");

    const indexes: any[] = await driver.getIndexes(mainTable);
    const uniqueOnName = indexes.find(
      (idx: any) => idx.Column_name === "name" && idx.Non_unique === 0 && idx.Key_name !== "PRIMARY",
    );
    expect(uniqueOnName).toBeUndefined();
  });

  // ──────────────────────────────────────────────
  // addForeignKey / hasForeignKey / dropForeignKey / generateForeignKeyName
  // ──────────────────────────────────────────────

  it("addForeignKey() should create a foreign key constraint", async () => {
    // Add a column that references refTable.id
    await driver.addColumn(mainTable, "ref_id", "INT NULL");
    await driver.addForeignKey(mainTable, "ref_id", refTable, "id");

    const rows: any[] = await driver.getForeignKeys(mainTable);
    const fk = rows.find((r: any) => r.COLUMN_NAME === "ref_id");
    expect(fk).toBeDefined();
    expect(fk.REFERENCED_TABLE_NAME).toBe(refTable);
    expect(fk.REFERENCED_COLUMN_NAME).toBe("id");
  });

  it("hasForeignKey() should return true for an existing FK constraint", async () => {
    const fkName = driver.generateForeignKeyName(mainTable, refTable, "ref_id");
    const exists = await driver.hasForeignKey(mainTable, fkName);
    expect(exists).toBe(true);
  });

  it("hasForeignKey() should return false for a non-existent FK constraint", async () => {
    const exists = await driver.hasForeignKey(mainTable, "nonexistent_fk_xyz");
    expect(exists).toBe(false);
  });

  it("generateForeignKeyName() should produce a deterministic FK name", () => {
    const name1 = driver.generateForeignKeyName("orders", "users", "user_id");
    const name2 = driver.generateForeignKeyName("orders", "users", "user_id");
    expect(name1).toBe(name2);
    expect(name1).toMatch(/^fk_/);
    expect(name1.length).toBeLessThanOrEqual(63);
  });

  it("dropForeignKey() should remove the foreign key constraint", async () => {
    await driver.dropForeignKey(mainTable, "ref_id");

    const rows: any[] = await driver.getForeignKeys(mainTable);
    const fk = rows.find((r: any) => r.COLUMN_NAME === "ref_id");
    expect(fk).toBeUndefined();

    // Clean up the ref_id column
    await driver.dropColumn(mainTable, "ref_id");
  });

  it("dropForeignKey() should throw when no FK exists on column", async () => {
    await expect(driver.dropForeignKey(mainTable, "name")).rejects.toThrow(
      /No foreign key constraint found/,
    );
  });

  // ──────────────────────────────────────────────
  // addIndex / hasIndex / dropIndex
  // ──────────────────────────────────────────────

  it("addIndex() should create an index on a column", async () => {
    const indexName = `idx_${mainTable}_age`;
    await driver.addIndex(mainTable, "age", indexName);

    const result: any[] = await driver.hasIndex(mainTable, indexName);
    const count = Number(result[0].count);
    expect(count).toBeGreaterThan(0);
  });

  it("hasIndex() should return count > 0 for existing index", async () => {
    const indexName = `idx_${mainTable}_age`;
    const result: any[] = await driver.hasIndex(mainTable, indexName);
    const count = Number(result[0].count);
    expect(count).toBeGreaterThan(0);
  });

  it("hasIndex() should return count = 0 for non-existent index", async () => {
    const result: any[] = await driver.hasIndex(mainTable, "nonexistent_idx_xyz");
    const count = Number(result[0].count);
    expect(count).toBe(0);
  });

  it("dropIndex() should remove the index", async () => {
    const indexName = `idx_${mainTable}_age`;
    await driver.dropIndex(mainTable, indexName);

    const result: any[] = await driver.hasIndex(mainTable, indexName);
    const count = Number(result[0].count);
    expect(count).toBe(0);
  });

  // ──────────────────────────────────────────────
  // addAutoIncrement
  // ──────────────────────────────────────────────

  it("addAutoIncrement() should modify a column to AUTO_INCREMENT", async () => {
    // noPkTable.col_a has no PK — need to add PK first for AUTO_INCREMENT
    await driver.addPrimaryKey(noPkTable, "col_a");
    await driver.addAutoIncrement(noPkTable, "col_a");

    const schemas: any[] = await driver.getSchemas(noPkTable);
    const colA = schemas.find((s: any) => s.Field === "col_a");
    expect(colA).toBeDefined();
    expect(colA.Extra).toMatch(/auto_increment/i);

    // Clean up: recreate the noPkTable without AUTO_INCREMENT for subsequent tests
    // (dropping PK on AUTO_INCREMENT column requires removing AUTO_INCREMENT first)
  });

  // ──────────────────────────────────────────────
  // getSchemas / getIndexes / getPrimaryKeys
  // ──────────────────────────────────────────────

  it("getSchemas() should return column definitions for a table", async () => {
    const schemas: any[] = await driver.getSchemas(mainTable);
    expect(Array.isArray(schemas)).toBe(true);
    expect(schemas.length).toBeGreaterThanOrEqual(3); // id, name, age

    const fieldNames = schemas.map((s: any) => s.Field);
    expect(fieldNames).toContain("id");
    expect(fieldNames).toContain("name");
    expect(fieldNames).toContain("age");
  });

  it("getIndexes() should return index information for a table", async () => {
    const indexes: any[] = await driver.getIndexes(mainTable);
    expect(Array.isArray(indexes)).toBe(true);
    // At minimum there's the PRIMARY key index
    expect(indexes.length).toBeGreaterThanOrEqual(1);
  });

  it("getPrimaryKeys() should return primary key columns", async () => {
    const pks: any[] = await driver.getPrimaryKeys(mainTable);
    expect(Array.isArray(pks)).toBe(true);
    expect(pks.length).toBe(1);
    expect(pks[0].COLUMN_NAME).toBe("id");
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
    const tempTable = `my_ddl_temp_${SUFFIX}`;
    await driver.executeRaw(
      `CREATE TEMPORARY TABLE \`${tempTable}\` (\`val\` INT)`,
    );
    await driver.executeRaw(
      `INSERT INTO \`${tempTable}\` (\`val\`) VALUES (42), (99)`,
    );
    const rows: any[] = await driver.executeRaw(
      `SELECT \`val\` FROM \`${tempTable}\` ORDER BY \`val\``,
    );
    expect(rows.length).toBe(2);
    expect(rows[0].val).toBe(42);
    expect(rows[1].val).toBe(99);

    await driver.executeRaw(`DROP TEMPORARY TABLE \`${tempTable}\``);
  });

  // ──────────────────────────────────────────────
  // queryWithOptions
  // ──────────────────────────────────────────────

  it("queryWithOptions() should execute a parameterized query", async () => {
    const query = sql`SELECT ${1} + ${2} AS result`;
    const rows: any[] = await driver.queryWithOptions(query, {});
    expect(rows.length).toBe(1);
    // Result might come back as string (typeCast default) or number
    expect(Number(rows[0].result)).toBe(3);
  });

  it("queryWithOptions() with arrayMode should return rows as arrays", async () => {
    const query = sql`SELECT 'hello' AS greeting, 42 AS num`;
    const rows: any[] = await driver.queryWithOptions(query, { arrayMode: true });
    expect(rows.length).toBe(1);
    // arrayMode: rows are arrays, not objects
    expect(Array.isArray(rows[0])).toBe(true);
  });

  // ──────────────────────────────────────────────
  // clear (TRUNCATE TABLE)
  // ──────────────────────────────────────────────

  it("clear() should truncate all rows from the table", async () => {
    // Insert some data first
    await connector.query(
      `INSERT INTO \`${clearTable}\` (\`val\`) VALUES ('a'), ('b'), ('c')`,
    );
    const beforeRows: any[] = await connector.query(
      `SELECT COUNT(*) AS cnt FROM \`${clearTable}\``,
    );
    expect(Number(beforeRows[0].cnt)).toBe(3);

    await driver.clear(clearTable);

    const afterRows: any[] = await connector.query(
      `SELECT COUNT(*) AS cnt FROM \`${clearTable}\``,
    );
    expect(Number(afterRows[0].cnt)).toBe(0);
  });

  // ──────────────────────────────────────────────
  // addCompositeUniqueIndex
  // ──────────────────────────────────────────────

  it("addCompositeUniqueIndex() should create a composite unique index", async () => {
    const indexName = `uq_${mainTable}_name_age`;
    await driver.addCompositeUniqueIndex(mainTable, ["name", "age"], indexName);

    const result: any[] = await driver.hasIndex(mainTable, indexName);
    const count = Number(result[0].count);
    expect(count).toBeGreaterThan(0);

    // Clean up
    await driver.dropIndex(mainTable, indexName);
  });
});
