/* eslint-disable @typescript-eslint/no-explicit-any */
import { SqliteDriver } from "../../src/dialects/sqlite/SqliteDriver";

/**
 * SQLite 드라이버 유닛 테스트
 *
 * 실제 DB 연결 없이 SqliteDriver의 wrap(), wrapQualified(), castType(),
 * getColumnType(), isMySqlFamily(), getForUpdateNoWait() 등을 검증합니다.
 */

const mockConnector: any = {
  query: jest.fn().mockResolvedValue([]),
};

describe("SqliteDriver - wrap() 식별자 래핑", () => {
  let driver: SqliteDriver;

  beforeEach(() => {
    driver = new SqliteDriver(mockConnector);
  });

  it("should wrap normal column name with double quotes", () => {
    expect(driver.wrap("name")).toBe('"name"');
  });

  it("should wrap table name with double quotes", () => {
    expect(driver.wrap("users")).toBe('"users"');
  });

  it("should escape double quotes inside identifier", () => {
    expect(driver.wrap('name"injection')).toBe('"name""injection"');
  });

  it("should escape multiple double quotes", () => {
    expect(driver.wrap('col""umn')).toBe('"col""""umn"');
  });

  it("should handle empty string", () => {
    expect(driver.wrap("")).toBe('""');
  });

  it("should prevent SQL injection via double quote breakout", () => {
    const malicious = '" ; DROP TABLE users; --';
    const wrapped = driver.wrap(malicious);

    expect(wrapped).toBe('""" ; DROP TABLE users; --"');
    expect(wrapped.startsWith('"')).toBe(true);
    expect(wrapped.endsWith('"')).toBe(true);
  });

  it("should handle identifier with backticks (not affected by SQLite wrap)", () => {
    const result = driver.wrap("col`name");
    expect(result).toBe('"col`name"');
  });

  it("should handle identifier with single quotes", () => {
    const result = driver.wrap("col'name");
    expect(result).toBe('"col\'name"');
  });
});

describe("SqliteDriver - wrapQualified()", () => {
  it("should return wrap() result (no schema prefix)", () => {
    const driver = new SqliteDriver(mockConnector);
    expect(driver.wrapQualified("users")).toBe('"users"');
  });

  it("should escape quotes in table name", () => {
    const driver = new SqliteDriver(mockConnector);
    expect(driver.wrapQualified('my"table')).toBe('"my""table"');
  });
});

describe("SqliteDriver - castType()", () => {
  let driver: SqliteDriver;

  beforeEach(() => {
    driver = new SqliteDriver(mockConnector);
  });

  it("should map varchar to TEXT", () => {
    expect(driver.castType("varchar")).toBe("TEXT");
  });

  it("should map text to TEXT", () => {
    expect(driver.castType("text")).toBe("TEXT");
  });

  it("should map longtext to TEXT", () => {
    expect(driver.castType("longtext")).toBe("TEXT");
  });

  it("should map char to TEXT", () => {
    expect(driver.castType("char")).toBe("TEXT");
  });

  it("should map int to INTEGER", () => {
    expect(driver.castType("int")).toBe("INTEGER");
  });

  it("should map number to INTEGER", () => {
    expect(driver.castType("number")).toBe("INTEGER");
  });

  it("should map boolean to INTEGER", () => {
    expect(driver.castType("boolean")).toBe("INTEGER");
  });

  it("should map bigint to INTEGER", () => {
    expect(driver.castType("bigint")).toBe("INTEGER");
  });

  it("should map float to REAL", () => {
    expect(driver.castType("float")).toBe("REAL");
  });

  it("should map double to REAL", () => {
    expect(driver.castType("double")).toBe("REAL");
  });

  it("should map blob to BLOB", () => {
    expect(driver.castType("blob")).toBe("BLOB");
  });

  it("should map json to TEXT", () => {
    expect(driver.castType("json")).toBe("TEXT");
  });

  it("should map jsonb to TEXT", () => {
    expect(driver.castType("jsonb")).toBe("TEXT");
  });

  it("should map enum to TEXT", () => {
    expect(driver.castType("enum")).toBe("TEXT");
  });

  it("should map array to TEXT", () => {
    expect(driver.castType("array")).toBe("TEXT");
  });

  it("should map datetime to TEXT", () => {
    expect(driver.castType("datetime")).toBe("TEXT");
  });

  it("should map date to TEXT", () => {
    expect(driver.castType("date")).toBe("TEXT");
  });

  it("should map timestamp to TEXT", () => {
    expect(driver.castType("timestamp")).toBe("TEXT");
  });

  it("should return unknown type as-is", () => {
    expect(driver.castType("unknown_type" as any)).toBe("unknown_type");
  });
});

describe("SqliteDriver - getColumnType()", () => {
  let driver: SqliteDriver;

  beforeEach(() => {
    driver = new SqliteDriver(mockConnector);
  });

  it("should infer String as TEXT", () => {
    expect(driver.getColumnType(String)).toBe("TEXT");
  });

  it("should infer Number as INTEGER", () => {
    expect(driver.getColumnType(Number)).toBe("INTEGER");
  });

  it("should infer Boolean as INTEGER", () => {
    expect(driver.getColumnType(Boolean)).toBe("INTEGER");
  });

  it("should infer Date as TEXT", () => {
    expect(driver.getColumnType(Date)).toBe("TEXT");
  });

  it("should infer Buffer as BLOB", () => {
    expect(driver.getColumnType(Buffer)).toBe("BLOB");
  });

  it("should default to TEXT for unknown types", () => {
    expect(driver.getColumnType(Object)).toBe("TEXT");
  });
});

describe("SqliteDriver - isMySqlFamily()", () => {
  it("should return false", () => {
    const driver = new SqliteDriver(mockConnector);
    expect(driver.isMySqlFamily()).toBe(false);
  });
});

describe("SqliteDriver - getForUpdateNoWait()", () => {
  it("should return empty string (SQLite does not support row-level locking)", () => {
    const driver = new SqliteDriver(mockConnector);
    expect(driver.getForUpdateNoWait()).toBe("");
  });
});

describe("SqliteDriver - generateForeignKeyName()", () => {
  it("should generate fk_source_target_column format", () => {
    const driver = new SqliteDriver(mockConnector);
    expect(driver.generateForeignKeyName("orders", "users", "user_id")).toBe(
      "fk_orders_users_user_id",
    );
  });
});

describe("SqliteDriver - DDL query generation", () => {
  let driver: SqliteDriver;
  let querySpy: jest.Mock;

  beforeEach(() => {
    querySpy = jest.fn().mockResolvedValue([]);
    driver = new SqliteDriver({ query: querySpy } as any);
  });

  it("hasTable should query sqlite_master", async () => {
    await driver.hasTable("users");
    expect(querySpy).toHaveBeenCalledTimes(1);
    const call = querySpy.mock.calls[0][0];
    expect(call.sql || call).toContain("sqlite_master");
  });

  it("addColumn should use ALTER TABLE ADD COLUMN", async () => {
    await driver.addColumn("users", "email", "TEXT");
    expect(querySpy).toHaveBeenCalledWith(
      'ALTER TABLE "users" ADD COLUMN "email" TEXT',
    );
  });

  it("dropColumn should use ALTER TABLE DROP COLUMN", async () => {
    await driver.dropColumn("users", "email");
    expect(querySpy).toHaveBeenCalledWith(
      'ALTER TABLE "users" DROP COLUMN "email"',
    );
  });

  it("addIndex should use CREATE INDEX", async () => {
    await driver.addIndex("users", "email", "idx_users_email");
    expect(querySpy).toHaveBeenCalledWith(
      'CREATE INDEX "idx_users_email" ON "users" ("email")',
    );
  });

  it("dropIndex should use DROP INDEX IF EXISTS", async () => {
    await driver.dropIndex("users", "idx_users_email");
    expect(querySpy).toHaveBeenCalledWith(
      'DROP INDEX IF EXISTS "idx_users_email"',
    );
  });

  it("addUniqueKey should use CREATE UNIQUE INDEX", async () => {
    await driver.addUniqueKey("users", "email");
    expect(querySpy).toHaveBeenCalledWith(
      'CREATE UNIQUE INDEX "uq_users_email" ON "users" ("email")',
    );
  });

  it("dropUniqueKey should use DROP INDEX IF EXISTS", async () => {
    await driver.dropUniqueKey("users", "email");
    expect(querySpy).toHaveBeenCalledWith(
      'DROP INDEX IF EXISTS "uq_users_email"',
    );
  });

  it("createTable should generate valid SQLite DDL", async () => {
    await driver.createTable("users", [
      {
        name: "id",
        options: {
          type: "int",
          length: 11,
          nullable: false,
          primary: true,
          autoIncrement: true,
        },
      },
      {
        name: "name",
        options: {
          type: "varchar",
          length: 255,
          nullable: false,
        },
      },
      {
        name: "active",
        options: {
          type: "boolean",
          length: 1,
          nullable: false,
        },
      },
    ]);

    expect(querySpy).toHaveBeenCalledTimes(1);
    const query = querySpy.mock.calls[0][0];
    expect(query).toContain('CREATE TABLE IF NOT EXISTS "users"');
    expect(query).toContain('"id" INTEGER PRIMARY KEY AUTOINCREMENT');
    expect(query).toContain('"name" TEXT(255) NOT NULL');
    expect(query).toContain('"active" INTEGER NOT NULL');
  });
});

describe("SqliteDriver - hasColumn()", () => {
  it("should return true when column exists in PRAGMA table_info result", async () => {
    const querySpy = jest.fn().mockResolvedValue([
      { cid: 0, name: "id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 1 },
      { cid: 1, name: "author_id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
    ]);
    const driver = new SqliteDriver({ query: querySpy } as any);

    const result = await driver.hasColumn("posts", "author_id");
    expect(result).toBe(true);
    expect(querySpy).toHaveBeenCalledWith('PRAGMA table_info("posts")');
  });

  it("should return false when column does not exist", async () => {
    const querySpy = jest.fn().mockResolvedValue([
      { cid: 0, name: "id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 1 },
    ]);
    const driver = new SqliteDriver({ query: querySpy } as any);

    const result = await driver.hasColumn("posts", "author_id");
    expect(result).toBe(false);
  });

  it("should return false when table has no columns (empty result)", async () => {
    const querySpy = jest.fn().mockResolvedValue([]);
    const driver = new SqliteDriver({ query: querySpy } as any);

    const result = await driver.hasColumn("posts", "author_id");
    expect(result).toBe(false);
  });

  it("should be case-insensitive", async () => {
    const querySpy = jest.fn().mockResolvedValue([
      { cid: 0, name: "Author_Id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
    ]);
    const driver = new SqliteDriver({ query: querySpy } as any);

    const result = await driver.hasColumn("posts", "author_id");
    expect(result).toBe(true);
  });
});
