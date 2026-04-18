/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Regression: composite primary keys must render as a single table-level
 * `PRIMARY KEY (col1, col2)` clause — not as inline `PRIMARY KEY` on each
 * column, which MySQL rejects with "Multiple primary key defined".
 *
 * Verifies the fix to `*Driver.createTable()` (MySQL / PostgreSQL / SQLite)
 * for @PrimaryColumn composite keys surfaced by the Synchronize path.
 */

import { MySqlDriver } from "../../src/dialects/mysql/MySqlDriver";
import { PostgresDriver } from "../../src/dialects/postgres/PostgresDriver";
import { SqliteDriver } from "../../src/dialects/sqlite/SqliteDriver";
import type { SchemaOptions } from "../../src/types/SchemaOption";

interface CapturedQuery {
  sql: string;
}

function makeMockConnector(): { captured: CapturedQuery[]; connector: any } {
  const captured: CapturedQuery[] = [];
  const connector = {
    query: jest.fn((arg: any) => {
      const sql =
        typeof arg === "string"
          ? arg
          : arg && typeof arg === "object" && "sql" in arg
            ? String((arg as any).sql ?? (arg as any).text ?? "")
            : String(arg);
      captured.push({ sql });
      return Promise.resolve([]);
    }),
  };
  return { captured, connector };
}

const compositeCols: SchemaOptions[] = [
  {
    name: "ancestor",
    propertyKey: "ancestor",
    options: { type: "int", primary: true, nullable: false },
  } as any,
  {
    name: "descendant",
    propertyKey: "descendant",
    options: { type: "int", primary: true, nullable: false },
  } as any,
  {
    name: "depth",
    propertyKey: "depth",
    options: { type: "int", nullable: false },
  } as any,
];

const singleCols: SchemaOptions[] = [
  {
    name: "id",
    propertyKey: "id",
    options: { type: "int", primary: true, nullable: false },
  } as any,
  {
    name: "name",
    propertyKey: "name",
    options: { type: "varchar", length: 50, nullable: false },
  } as any,
];

describe("Driver.createTable composite PK regression (#bug)", () => {
  describe("MySqlDriver", () => {
    it("emits one table-level PRIMARY KEY, no inline PRIMARY KEY on pk columns", async () => {
      const { captured, connector } = makeMockConnector();
      const driver = new MySqlDriver(connector);
      await driver.createTable("cedge", compositeCols);

      expect(captured).toHaveLength(1);
      const sqlText = captured[0].sql;
      // Exactly one PRIMARY KEY clause appears
      expect(sqlText.match(/PRIMARY KEY/g)).toHaveLength(1);
      // Table-level PK lists both columns, backtick-wrapped
      expect(sqlText).toContain("PRIMARY KEY (`ancestor`, `descendant`)");
      // No inline PK on individual columns
      expect(sqlText).not.toMatch(/`ancestor`[^,]*PRIMARY KEY/);
      expect(sqlText).not.toMatch(/`descendant`[^,]*PRIMARY KEY/);
    });

    it("keeps inline PRIMARY KEY for single-PK tables", async () => {
      const { captured, connector } = makeMockConnector();
      const driver = new MySqlDriver(connector);
      await driver.createTable("single", singleCols);

      const sqlText = captured[0].sql;
      expect(sqlText.match(/PRIMARY KEY/g)).toHaveLength(1);
      // Single-PK form keeps inline, no table-level clause
      expect(sqlText).toMatch(/`id`[^,]*PRIMARY KEY/);
      expect(sqlText).not.toContain("PRIMARY KEY (");
    });
  });

  describe("PostgresDriver", () => {
    it("emits one table-level PRIMARY KEY for composite PK", async () => {
      const { captured, connector } = makeMockConnector();
      const driver = new PostgresDriver(connector);
      await driver.createTable("cedge", compositeCols);

      expect(captured).toHaveLength(1);
      const sqlText = captured[0].sql;
      expect(sqlText.match(/PRIMARY KEY/g)).toHaveLength(1);
      expect(sqlText).toContain(`PRIMARY KEY ("ancestor", "descendant")`);
      expect(sqlText).not.toMatch(/"ancestor"[^,]*PRIMARY KEY/);
      expect(sqlText).not.toMatch(/"descendant"[^,]*PRIMARY KEY/);
    });
  });

  describe("SqliteDriver", () => {
    it("emits one table-level PRIMARY KEY for composite PK", async () => {
      const { captured, connector } = makeMockConnector();
      const driver = new SqliteDriver(connector);
      await driver.createTable("cedge", compositeCols);

      expect(captured).toHaveLength(1);
      const sqlText = captured[0].sql;
      expect(sqlText.match(/PRIMARY KEY/g)).toHaveLength(1);
      expect(sqlText).toContain(`PRIMARY KEY ("ancestor", "descendant")`);
      expect(sqlText).not.toMatch(/"ancestor"[^,]*PRIMARY KEY/);
      expect(sqlText).not.toMatch(/"descendant"[^,]*PRIMARY KEY/);
    });
  });
});
