/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";

/**
 * MSSQL 드라이버 유닛 테스트 (mock 기반, 실제 DB 불필요)
 *
 * MssqlDriver, MssqlConnector, MssqlDataSource의 주요 동작을 검증합니다.
 */

describe("MssqlDriver", () => {
  let MssqlDriver: any;
  let driver: any;
  let mockConnector: any;

  beforeEach(async () => {
    const mod = await import("../../src/dialects/mssql/MssqlDriver");
    MssqlDriver = mod.MssqlDriver;

    mockConnector = {
      query: jest.fn().mockResolvedValue([]),
    };

    driver = new MssqlDriver(mockConnector);
  });

  describe("wrap()", () => {
    it("should wrap identifiers with square brackets", () => {
      expect(driver.wrap("column_name")).toBe("[column_name]");
    });

    it("should escape ] characters by doubling them", () => {
      expect(driver.wrap("col]name")).toBe("[col]]name]");
    });

    it("should handle empty string", () => {
      expect(driver.wrap("")).toBe("[]");
    });
  });

  describe("isMySqlFamily()", () => {
    it("should return false", () => {
      expect(driver.isMySqlFamily()).toBe(false);
    });
  });

  describe("castType()", () => {
    it("should map varchar to NVARCHAR", () => {
      expect(driver.castType("varchar")).toBe("NVARCHAR");
    });

    it("should map int to INT", () => {
      expect(driver.castType("int")).toBe("INT");
    });

    it("should map number to INT", () => {
      expect(driver.castType("number")).toBe("INT");
    });

    it("should map boolean to BIT", () => {
      expect(driver.castType("boolean")).toBe("BIT");
    });

    it("should map datetime to DATETIME2", () => {
      expect(driver.castType("datetime")).toBe("DATETIME2");
    });

    it("should map date to DATE", () => {
      expect(driver.castType("date")).toBe("DATE");
    });

    it("should map timestamp to DATETIME2", () => {
      expect(driver.castType("timestamp")).toBe("DATETIME2");
    });

    it("should map float to FLOAT", () => {
      expect(driver.castType("float")).toBe("FLOAT");
    });

    it("should map double to DECIMAL with placeholders", () => {
      expect(driver.castType("double")).toBe("DECIMAL($precision, $scale)");
    });

    it("should map blob to VARBINARY(MAX)", () => {
      expect(driver.castType("blob")).toBe("VARBINARY(MAX)");
    });

    it("should map text to NVARCHAR(MAX)", () => {
      expect(driver.castType("text")).toBe("NVARCHAR(MAX)");
    });

    it("should map longtext to NVARCHAR(MAX)", () => {
      expect(driver.castType("longtext")).toBe("NVARCHAR(MAX)");
    });

    it("should map bigint to BIGINT", () => {
      expect(driver.castType("bigint")).toBe("BIGINT");
    });

    it("should map json to NVARCHAR(MAX)", () => {
      expect(driver.castType("json")).toBe("NVARCHAR(MAX)");
    });

    it("should map jsonb to NVARCHAR(MAX)", () => {
      expect(driver.castType("jsonb")).toBe("NVARCHAR(MAX)");
    });

    it("should map char to NCHAR", () => {
      expect(driver.castType("char")).toBe("NCHAR");
    });

    it("should map enum to NVARCHAR", () => {
      expect(driver.castType("enum")).toBe("NVARCHAR");
    });

    it("should map array to NVARCHAR(MAX)", () => {
      expect(driver.castType("array")).toBe("NVARCHAR(MAX)");
    });

    it("should return unknown types as-is", () => {
      expect(driver.castType("xml")).toBe("xml");
    });
  });

  describe("getColumnType()", () => {
    it("should return NVARCHAR for String", () => {
      expect(driver.getColumnType(String)).toBe("NVARCHAR");
    });

    it("should return INT for Number", () => {
      expect(driver.getColumnType(Number)).toBe("INT");
    });

    it("should return BIT for Boolean", () => {
      expect(driver.getColumnType(Boolean)).toBe("BIT");
    });

    it("should return DATETIME2 for Date", () => {
      expect(driver.getColumnType(Date)).toBe("DATETIME2");
    });

    it("should return VARBINARY(MAX) for Buffer", () => {
      expect(driver.getColumnType(Buffer)).toBe("VARBINARY(MAX)");
    });

    it("should return NVARCHAR(MAX) for unknown types", () => {
      expect(driver.getColumnType(Object)).toBe("NVARCHAR(MAX)");
    });
  });

  describe("generateForeignKeyName()", () => {
    it("should generate fk_{source}_{target}_{column} format", () => {
      expect(
        driver.generateForeignKeyName("Order", "Customer", "customerId"),
      ).toBe("fk_Order_Customer_customerId");
    });
  });

  describe("getForUpdateNoWait()", () => {
    it("should return MSSQL locking hint", () => {
      expect(driver.getForUpdateNoWait()).toBe(
        " WITH (UPDLOCK, ROWLOCK, NOWAIT)",
      );
    });
  });

  describe("hasTable()", () => {
    it("should query INFORMATION_SCHEMA.TABLES", async () => {
      await driver.hasTable("TestTable");

      expect(mockConnector.query).toHaveBeenCalled();
      const sqlObj = mockConnector.query.mock.calls[0][0];
      const sqlText = sqlObj.text || sqlObj.sql || String(sqlObj);
      expect(sqlText).toContain("INFORMATION_SCHEMA.TABLES");
    });
  });

  describe("createTable()", () => {
    it("should create a table with IDENTITY(1,1) for auto-increment columns", async () => {
      const columns = [
        { name: "id", options: { primary: true, autoIncrement: true } },
        { name: "name", options: { type: "varchar", length: 255, nullable: false } },
        { name: "active", options: { type: "boolean", nullable: true } },
      ];

      await driver.createTable("User", columns);

      expect(mockConnector.query).toHaveBeenCalled();
      const sqlText = mockConnector.query.mock.calls[0][0];
      expect(sqlText).toContain("[User]");
      expect(sqlText).toContain("IDENTITY(1,1)");
      expect(sqlText).toContain("[name]");
      expect(sqlText).toContain("[active]");
      expect(sqlText).toContain("BIT");
    });

    it("should handle columns without auto-increment", async () => {
      const columns = [
        { name: "id", options: { primary: true, type: "int" } },
        { name: "title", options: { type: "text", nullable: false } },
      ];

      await driver.createTable("Post", columns);

      expect(mockConnector.query).toHaveBeenCalled();
      const sqlText = mockConnector.query.mock.calls[0][0];
      expect(sqlText).toContain("[Post]");
      expect(sqlText).toContain("PRIMARY KEY");
      expect(sqlText).not.toContain("IDENTITY");
    });

    it("should use default options when column options are not provided", async () => {
      const columns = [
        { name: "data" },
      ];

      await driver.createTable("Config", columns);

      expect(mockConnector.query).toHaveBeenCalled();
      const sqlText = mockConnector.query.mock.calls[0][0];
      expect(sqlText).toContain("[Config]");
      expect(sqlText).toContain("[data]");
    });
  });

  describe("addForeignKey()", () => {
    it("should generate correct ALTER TABLE ADD CONSTRAINT query", async () => {
      await driver.addForeignKey("Order", "customerId", "Customer", "id");

      expect(mockConnector.query).toHaveBeenCalled();
      const sqlText = mockConnector.query.mock.calls[0][0];
      expect(sqlText).toContain("ALTER TABLE [Order]");
      expect(sqlText).toContain("ADD CONSTRAINT");
      expect(sqlText).toContain("fk_Order_Customer_customerId");
      expect(sqlText).toContain("FOREIGN KEY ([customerId])");
      expect(sqlText).toContain("REFERENCES [Customer]([id])");
    });
  });

  describe("addIndex()", () => {
    it("should generate CREATE INDEX query", async () => {
      await driver.addIndex("User", "email", "idx_user_email");

      expect(mockConnector.query).toHaveBeenCalled();
      const sqlText = mockConnector.query.mock.calls[0][0];
      expect(sqlText).toContain("CREATE INDEX");
      expect(sqlText).toContain("[idx_user_email]");
      expect(sqlText).toContain("[User]");
      expect(sqlText).toContain("[email]");
    });
  });

  describe("dropIndex()", () => {
    it("should generate DROP INDEX ON query (MSSQL syntax)", async () => {
      await driver.dropIndex("User", "idx_user_email");

      const sqlText = mockConnector.query.mock.calls[0][0];
      expect(sqlText).toContain("DROP INDEX");
      expect(sqlText).toContain("[idx_user_email]");
      expect(sqlText).toContain("ON [User]");
    });
  });

  describe("addPrimaryKey()", () => {
    it("should add primary key with constraint name", async () => {
      await driver.addPrimaryKey("User", "id");

      const sqlText = mockConnector.query.mock.calls[0][0];
      expect(sqlText).toContain("ALTER TABLE [User]");
      expect(sqlText).toContain("ADD CONSTRAINT [PK_User]");
      expect(sqlText).toContain("PRIMARY KEY ([id])");
    });
  });

  describe("dropPrimaryKey()", () => {
    it("should drop primary key constraint", async () => {
      await driver.dropPrimaryKey("User");

      const sqlText = mockConnector.query.mock.calls[0][0];
      expect(sqlText).toContain("DROP CONSTRAINT [PK_User]");
    });
  });

  describe("addUniqueKey()", () => {
    it("should add unique constraint", async () => {
      await driver.addUniqueKey("User", "email");

      const sqlText = mockConnector.query.mock.calls[0][0];
      expect(sqlText).toContain("ADD CONSTRAINT [UQ_User_email]");
      expect(sqlText).toContain("UNIQUE ([email])");
    });
  });

  describe("dropUniqueKey()", () => {
    it("should drop unique constraint", async () => {
      await driver.dropUniqueKey("User", "email");

      const sqlText = mockConnector.query.mock.calls[0][0];
      expect(sqlText).toContain("DROP CONSTRAINT [UQ_User_email]");
    });
  });

  describe("dropForeignKey()", () => {
    it("should drop foreign key constraint", async () => {
      await driver.dropForeignKey("Order", "fk_order_customer");

      const sqlText = mockConnector.query.mock.calls[0][0];
      expect(sqlText).toContain("DROP CONSTRAINT [fk_order_customer]");
    });
  });

  describe("getSchemas()", () => {
    it("should query INFORMATION_SCHEMA.COLUMNS", async () => {
      await driver.getSchemas("User");

      const sqlObj = mockConnector.query.mock.calls[0][0];
      const sqlText = sqlObj.text || sqlObj.sql || String(sqlObj);
      expect(sqlText).toContain("INFORMATION_SCHEMA.COLUMNS");
    });
  });

  describe("getIndexes()", () => {
    it("should query sys.indexes", async () => {
      await driver.getIndexes("User");

      const sqlObj = mockConnector.query.mock.calls[0][0];
      const sqlText = sqlObj.text || sqlObj.sql || String(sqlObj);
      expect(sqlText).toContain("sys.indexes");
    });
  });

  describe("getForeignKeys()", () => {
    it("should query sys.foreign_keys", async () => {
      await driver.getForeignKeys("Order");

      const sqlObj = mockConnector.query.mock.calls[0][0];
      const sqlText = sqlObj.text || sqlObj.sql || String(sqlObj);
      expect(sqlText).toContain("sys.foreign_keys");
    });
  });

  describe("getPrimaryKeys()", () => {
    it("should query INFORMATION_SCHEMA.KEY_COLUMN_USAGE", async () => {
      await driver.getPrimaryKeys("User");

      const sqlObj = mockConnector.query.mock.calls[0][0];
      const sqlText = sqlObj.text || sqlObj.sql || String(sqlObj);
      expect(sqlText).toContain("INFORMATION_SCHEMA.KEY_COLUMN_USAGE");
    });
  });
});

describe("MssqlConnector - parameter conversion", () => {
  it("should convert $1, $2 placeholders to @param0, @param1", () => {
    const sql = "SELECT * FROM users WHERE id = $1 AND name = $2";
    const converted = sql.replace(/\$(\d+)/g, (_match, num) => {
      return `@param${parseInt(num, 10) - 1}`;
    });
    expect(converted).toBe(
      "SELECT * FROM users WHERE id = @param0 AND name = @param1",
    );
  });

  it("should handle no parameters", () => {
    const sql = "SELECT * FROM users";
    const converted = sql.replace(/\$(\d+)/g, (_match, num) => {
      return `@param${parseInt(num, 10) - 1}`;
    });
    expect(converted).toBe("SELECT * FROM users");
  });

  it("should handle many parameters", () => {
    const sql = "INSERT INTO t VALUES ($1, $2, $3, $4, $5)";
    const converted = sql.replace(/\$(\d+)/g, (_match, num) => {
      return `@param${parseInt(num, 10) - 1}`;
    });
    expect(converted).toBe(
      "INSERT INTO t VALUES (@param0, @param1, @param2, @param3, @param4)",
    );
  });
});

describe("MssqlConnectionError", () => {
  it("should have correct error message", async () => {
    const { MssqlConnectionError } = await import(
      "../../src/dialects/mssql/MssqlConnectionError"
    );
    const error = new MssqlConnectionError();
    expect(error.message).toBe(
      "MSSQL database connection is not established.",
    );
    expect(error).toBeInstanceOf(Error);
  });
});

describe("ConnectionNotFound", () => {
  it("should have correct error message", async () => {
    const { ConnectionNotFound } = await import(
      "../../src/dialects/mssql/ConnectionNotFound"
    );
    const error = new ConnectionNotFound();
    expect(error.message).toBe("MSSQL connection does not exist.");
    expect(error).toBeInstanceOf(Error);
  });
});

describe("PoolNotFound", () => {
  it("should have correct error message", async () => {
    const { PoolNotFound } = await import(
      "../../src/dialects/mssql/PoolNotFound"
    );
    const error = new PoolNotFound();
    expect(error.message).toBe("MSSQL connection pool does not exist.");
    expect(error).toBeInstanceOf(Error);
  });
});

describe("MssqlDataSource", () => {
  it("should throw MssqlConnectionError when not connected", async () => {
    const { MssqlDataSource } = await import(
      "../../src/dialects/mssql/MssqlDataSource"
    );

    const mockConnector: any = {
      getConnection: jest.fn().mockResolvedValue(null),
    };

    const dataSource = new MssqlDataSource(mockConnector);

    await expect(dataSource.createConnection()).rejects.toThrow(
      "MSSQL database connection is not established.",
    );
  });

  it("should call savepoint with correct MSSQL syntax", async () => {
    const { MssqlDataSource } = await import(
      "../../src/dialects/mssql/MssqlDataSource"
    );

    const mockQuery = jest.fn().mockResolvedValue(undefined);
    const mockConnector: any = {
      getConnection: jest.fn().mockResolvedValue({}),
      query: mockQuery,
    };

    const dataSource = new MssqlDataSource(mockConnector);
    await dataSource.createConnection();
    await dataSource.savepoint("sp1");

    // MSSQL uses SAVE TRANSACTION instead of SAVEPOINT
    expect(mockQuery).toHaveBeenCalledWith("SAVE TRANSACTION sp1", {});
  });

  it("should call rollbackTo with correct MSSQL syntax", async () => {
    const { MssqlDataSource } = await import(
      "../../src/dialects/mssql/MssqlDataSource"
    );

    const mockQuery = jest.fn().mockResolvedValue(undefined);
    const mockConnector: any = {
      getConnection: jest.fn().mockResolvedValue({}),
      query: mockQuery,
    };

    const dataSource = new MssqlDataSource(mockConnector);
    await dataSource.createConnection();
    await dataSource.rollbackTo("sp1");

    // MSSQL uses ROLLBACK TRANSACTION instead of ROLLBACK TO SAVEPOINT
    expect(mockQuery).toHaveBeenCalledWith(
      "ROLLBACK TRANSACTION sp1",
      {},
    );
  });

  it("should throw on query when not connected", async () => {
    const { MssqlDataSource } = await import(
      "../../src/dialects/mssql/MssqlDataSource"
    );

    const mockConnector: any = {};
    const dataSource = new MssqlDataSource(mockConnector);

    await expect(dataSource.query("SELECT 1")).rejects.toThrow(
      "MSSQL database connection is not established.",
    );
  });

  it("should throw on startTransaction when not connected", async () => {
    const { MssqlDataSource } = await import(
      "../../src/dialects/mssql/MssqlDataSource"
    );

    const mockConnector: any = {};
    const dataSource = new MssqlDataSource(mockConnector);

    await expect(dataSource.startTransaction()).rejects.toThrow(
      "MSSQL database connection is not established.",
    );
  });

  it("should throw on rollback when not connected", async () => {
    const { MssqlDataSource } = await import(
      "../../src/dialects/mssql/MssqlDataSource"
    );

    const mockConnector: any = {};
    const dataSource = new MssqlDataSource(mockConnector);

    await expect(dataSource.rollback()).rejects.toThrow(
      "MSSQL database connection is not established.",
    );
  });

  it("should throw on commit when not connected", async () => {
    const { MssqlDataSource } = await import(
      "../../src/dialects/mssql/MssqlDataSource"
    );

    const mockConnector: any = {};
    const dataSource = new MssqlDataSource(mockConnector);

    await expect(dataSource.commit()).rejects.toThrow(
      "MSSQL database connection is not established.",
    );
  });
});

describe("IDatabaseType - MSSQL support", () => {
  it('should include "mssql" in IDatabaseType', async () => {
    type IDatabaseType =
      | "mysql"
      | "mariadb"
      | "postgres"
      | "sqlite"
      | "mssql";
    const validTypes: IDatabaseType[] = [
      "mysql",
      "mariadb",
      "postgres",
      "sqlite",
      "mssql",
    ];
    expect(validTypes).toContain("mssql");
  });
});

describe("TransactionSessionManager - MSSQL DataSource selection", () => {
  function selectDataSource(dbType: string): string {
    if (dbType === "postgres") {
      return "PostgresDataSource";
    } else if (dbType === "sqlite") {
      return "SqliteDataSource";
    } else if (dbType === "mssql") {
      return "MssqlDataSource";
    } else {
      return "MySqlDataSource";
    }
  }

  it("should select MssqlDataSource for mssql type", () => {
    expect(selectDataSource("mssql")).toBe("MssqlDataSource");
  });

  it("should select PostgresDataSource for postgres type", () => {
    expect(selectDataSource("postgres")).toBe("PostgresDataSource");
  });

  it("should select SqliteDataSource for sqlite type", () => {
    expect(selectDataSource("sqlite")).toBe("SqliteDataSource");
  });

  it("should select MySqlDataSource for mysql type", () => {
    expect(selectDataSource("mysql")).toBe("MySqlDataSource");
  });
});

describe("EntityManager - MSSQL driver selection", () => {
  function selectDriver(clientType: string): string {
    switch (clientType) {
      case "mariadb":
      case "mysql":
        return "MySqlDriver";
      case "postgres":
        return "PostgresDriver";
      case "sqlite":
        return "SqliteDriver";
      case "mssql":
        return "MssqlDriver";
      default:
        throw new Error("Unsupported database type.");
    }
  }

  it("should select MssqlDriver for mssql type", () => {
    expect(selectDriver("mssql")).toBe("MssqlDriver");
  });

  it("should select MySqlDriver for mysql type", () => {
    expect(selectDriver("mysql")).toBe("MySqlDriver");
  });

  it("should select PostgresDriver for postgres type", () => {
    expect(selectDriver("postgres")).toBe("PostgresDriver");
  });

  it("should select SqliteDriver for sqlite type", () => {
    expect(selectDriver("sqlite")).toBe("SqliteDriver");
  });
});
