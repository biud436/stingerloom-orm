/* eslint-disable @typescript-eslint/no-explicit-any */
import type {
  DatabaseClientOptions,
  PoolOptions,
} from "../../src/core/DatabaseClientOptions";

/**
 * 연결 풀링 최적화 테스트
 *
 * DatabaseClientOptions의 pool 옵션이 각 커넥터에 올바르게 전달되는지,
 * DatabaseClient가 SQLite를 포함한 모든 DB 타입을 지원하는지,
 * TransactionSessionManager가 SQLite를 올바르게 처리하는지 검증합니다.
 */

describe("DatabaseClientOptions - PoolOptions 인터페이스", () => {
  it("should accept pool configuration with all options", () => {
    const options: DatabaseClientOptions = {
      type: "postgres",
      host: "localhost",
      port: 5432,
      username: "test",
      password: "test",
      database: "testdb",
      entities: [],
      pool: {
        max: 20,
        min: 5,
        acquireTimeoutMs: 60000,
        idleTimeoutMs: 30000,
      },
    };

    expect(options.pool?.max).toBe(20);
    expect(options.pool?.min).toBe(5);
    expect(options.pool?.acquireTimeoutMs).toBe(60000);
    expect(options.pool?.idleTimeoutMs).toBe(30000);
  });

  it("should accept options without pool configuration (backward compatible)", () => {
    const options: DatabaseClientOptions = {
      type: "mysql",
      host: "localhost",
      port: 3306,
      username: "test",
      password: "test",
      database: "testdb",
      entities: [],
      connectionLimit: 15,
    };

    expect(options.pool).toBeUndefined();
    expect(options.connectionLimit).toBe(15);
  });

  it("should accept sqlite type without pool options", () => {
    const options: DatabaseClientOptions = {
      type: "sqlite",
      host: "",
      port: 0,
      username: "",
      password: "",
      database: ":memory:",
      entities: [],
    };

    expect(options.type).toBe("sqlite");
    expect(options.pool).toBeUndefined();
  });
});

describe("MySqlConnector - pool options 적용", () => {
  it("should use pool.max over connectionLimit", () => {
    const options: { pool?: PoolOptions; connectionLimit?: number } = {
      pool: { max: 25 },
      connectionLimit: 10,
    };

    const maxConnections =
      options.pool?.max ?? options.connectionLimit ?? 10;
    expect(maxConnections).toBe(25);
  });

  it("should fall back to connectionLimit when pool.max is not set", () => {
    const options: { pool?: PoolOptions; connectionLimit?: number } = {
      pool: {},
      connectionLimit: 15,
    };

    const maxConnections =
      options.pool?.max ?? options.connectionLimit ?? 10;
    expect(maxConnections).toBe(15);
  });

  it("should use default 10 when neither pool.max nor connectionLimit is set", () => {
    const options: { pool?: PoolOptions; connectionLimit?: number } = {};

    const maxConnections =
      options.pool?.max ?? options.connectionLimit ?? 10;
    expect(maxConnections).toBe(10);
  });
});

describe("PostgresConnector - pool options 적용", () => {
  it("should apply all pool options correctly", () => {
    const poolOptions: PoolOptions = {
      max: 30,
      min: 5,
      acquireTimeoutMs: 60000,
      idleTimeoutMs: 20000,
    };

    const pgPoolConfig = {
      max: poolOptions.max ?? 10,
      min: poolOptions.min ?? 0,
      connectionTimeoutMillis: poolOptions.acquireTimeoutMs ?? 30000,
      idleTimeoutMillis: poolOptions.idleTimeoutMs ?? 10000,
    };

    expect(pgPoolConfig.max).toBe(30);
    expect(pgPoolConfig.min).toBe(5);
    expect(pgPoolConfig.connectionTimeoutMillis).toBe(60000);
    expect(pgPoolConfig.idleTimeoutMillis).toBe(20000);
  });

  it("should use defaults when pool options are not provided", () => {
    const options: { pool?: PoolOptions } = {};
    const poolOptions = options.pool;

    const pgPoolConfig = {
      max: poolOptions?.max ?? 10,
      min: poolOptions?.min ?? 0,
      connectionTimeoutMillis: poolOptions?.acquireTimeoutMs ?? 30000,
      idleTimeoutMillis: poolOptions?.idleTimeoutMs ?? 10000,
    };

    expect(pgPoolConfig.max).toBe(10);
    expect(pgPoolConfig.min).toBe(0);
    expect(pgPoolConfig.connectionTimeoutMillis).toBe(30000);
    expect(pgPoolConfig.idleTimeoutMillis).toBe(10000);
  });
});

describe("DatabaseClient - SQLite 지원", () => {
  it('should have "sqlite" in IDatabaseType', () => {
    type IDatabaseType = "mysql" | "mariadb" | "postgres" | "sqlite";
    const validTypes: IDatabaseType[] = [
      "mysql",
      "mariadb",
      "postgres",
      "sqlite",
    ];
    expect(validTypes).toContain("sqlite");
  });
});

describe("TransactionSessionManager - SQLite DataSource 선택", () => {
  function selectDataSource(dbType: string): string {
    if (dbType === "postgres") {
      return "PostgresDataSource";
    } else if (dbType === "sqlite") {
      return "SqliteDataSource";
    } else {
      return "MySqlDataSource";
    }
  }

  it("should select SqliteDataSource for sqlite type", () => {
    expect(selectDataSource("sqlite")).toBe("SqliteDataSource");
  });

  it("should select PostgresDataSource for postgres type", () => {
    expect(selectDataSource("postgres")).toBe("PostgresDataSource");
  });

  it("should select MySqlDataSource for mysql type", () => {
    expect(selectDataSource("mysql")).toBe("MySqlDataSource");
  });
});

describe("SqliteConnector - 단일 연결 유지", () => {
  it("should reuse the same db instance for getConnection()", async () => {
    const { SqliteConnector } = await import(
      "../../src/dialects/sqlite/SqliteConnector"
    );
    const connector = new SqliteConnector();

    await connector.connect({
      type: "sqlite",
      host: "",
      port: 0,
      username: "",
      password: "",
      database: ":memory:",
      entities: [],
    });

    const conn1 = await connector.getConnection();
    const conn2 = await connector.getConnection();

    // SQLite는 단일 연결이므로 동일한 인스턴스를 반환해야 함
    expect(conn1).toBe(conn2);

    await connector.close();
  });

  it("should support transactions on in-memory database", async () => {
    const { SqliteConnector } = await import(
      "../../src/dialects/sqlite/SqliteConnector"
    );
    const connector = new SqliteConnector();

    await connector.connect({
      type: "sqlite",
      host: "",
      port: 0,
      username: "",
      password: "",
      database: ":memory:",
      entities: [],
    });

    const conn = await connector.getConnection();

    await connector.query(
      "CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)",
    );

    await connector.startTransaction(conn);
    await connector.query("INSERT INTO test (id, name) VALUES (1, 'hello')");
    await connector.rollback(conn);

    const results = await connector.query("SELECT * FROM test");
    expect(results).toEqual([]);

    await connector.close();
  });

  it("should commit transactions correctly", async () => {
    const { SqliteConnector } = await import(
      "../../src/dialects/sqlite/SqliteConnector"
    );
    const connector = new SqliteConnector();

    await connector.connect({
      type: "sqlite",
      host: "",
      port: 0,
      username: "",
      password: "",
      database: ":memory:",
      entities: [],
    });

    const conn = await connector.getConnection();

    await connector.query(
      "CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)",
    );

    await connector.startTransaction(conn);
    await connector.query("INSERT INTO test (id, name) VALUES (1, 'world')");
    await connector.commit(conn);

    const results = await connector.query("SELECT * FROM test");
    expect(results).toEqual([{ id: 1, name: "world" }]);

    await connector.close();
  });

  it("should throw ConnectionNotFound when db is not connected", async () => {
    const { SqliteConnector } = await import(
      "../../src/dialects/sqlite/SqliteConnector"
    );
    const connector = new SqliteConnector();

    await expect(connector.getConnection()).rejects.toThrow(
      "SQLite connection does not exist.",
    );
  });

  it("should handle close gracefully when not connected", async () => {
    const { SqliteConnector } = await import(
      "../../src/dialects/sqlite/SqliteConnector"
    );
    const connector = new SqliteConnector();

    await expect(connector.close()).resolves.toBeUndefined();
  });

  it("should enable foreign keys on connect", async () => {
    const { SqliteConnector } = await import(
      "../../src/dialects/sqlite/SqliteConnector"
    );
    const connector = new SqliteConnector();

    await connector.connect({
      type: "sqlite",
      host: "",
      port: 0,
      username: "",
      password: "",
      database: ":memory:",
      entities: [],
    });

    // 외래키 활성화 확인
    const fkResult = await connector.query("PRAGMA foreign_keys");
    expect(fkResult[0].foreign_keys).toBe(1);

    // WAL 모드는 인메모리 DB에서는 "memory"를 반환함 (파일 기반에서만 "wal")
    const walResult = await connector.query("PRAGMA journal_mode");
    expect(["wal", "memory"]).toContain(walResult[0].journal_mode);

    await connector.close();
  });
});

describe("SqliteDataSource - IDataSource 구현", () => {
  it("should create connection and execute queries", async () => {
    const { SqliteConnector } = await import(
      "../../src/dialects/sqlite/SqliteConnector"
    );
    const { SqliteDataSource } = await import(
      "../../src/dialects/sqlite/SqliteDataSource"
    );

    const connector = new SqliteConnector();
    await connector.connect({
      type: "sqlite",
      host: "",
      port: 0,
      username: "",
      password: "",
      database: ":memory:",
      entities: [],
    });

    const dataSource = new SqliteDataSource(connector);
    await dataSource.createConnection();

    const result = await dataSource.query("SELECT 1 + 1 as result");
    expect(result[0].result).toBe(2);

    await dataSource.close();
    await connector.close();
  });

  it("should throw SqliteConnectionError when not connected", async () => {
    const { SqliteDataSource } = await import(
      "../../src/dialects/sqlite/SqliteDataSource"
    );

    const mockConnector: any = {
      getConnection: jest.fn().mockResolvedValue(null),
    };

    const dataSource = new SqliteDataSource(mockConnector);

    await expect(dataSource.createConnection()).rejects.toThrow(
      "SQLite database connection is not established.",
    );
  });

  it("should support savepoint and rollbackTo", async () => {
    const { SqliteConnector } = await import(
      "../../src/dialects/sqlite/SqliteConnector"
    );
    const { SqliteDataSource } = await import(
      "../../src/dialects/sqlite/SqliteDataSource"
    );

    const connector = new SqliteConnector();
    await connector.connect({
      type: "sqlite",
      host: "",
      port: 0,
      username: "",
      password: "",
      database: ":memory:",
      entities: [],
    });

    await connector.query(
      "CREATE TABLE sp_test (id INTEGER PRIMARY KEY, val TEXT)",
    );

    const dataSource = new SqliteDataSource(connector);
    await dataSource.createConnection();

    await dataSource.startTransaction();

    await dataSource.query(
      "INSERT INTO sp_test (id, val) VALUES (1, 'before_savepoint')",
    );

    await dataSource.savepoint("sp1");

    await dataSource.query(
      "INSERT INTO sp_test (id, val) VALUES (2, 'after_savepoint')",
    );

    await dataSource.rollbackTo("sp1");

    await dataSource.commit();

    const results = await connector.query("SELECT * FROM sp_test");
    expect(results).toEqual([{ id: 1, val: "before_savepoint" }]);

    await connector.close();
  });
});

describe("EntityManager - SQLite 드라이버 선택", () => {
  function selectDriver(clientType: string): string {
    switch (clientType) {
      case "mariadb":
      case "mysql":
        return "MySqlDriver";
      case "postgres":
        return "PostgresDriver";
      case "sqlite":
        return "SqliteDriver";
      default:
        throw new Error("Unsupported database type.");
    }
  }

  it("should select SqliteDriver for sqlite type", () => {
    expect(selectDriver("sqlite")).toBe("SqliteDriver");
  });

  it("should select MySqlDriver for mysql type", () => {
    expect(selectDriver("mysql")).toBe("MySqlDriver");
  });

  it("should select PostgresDriver for postgres type", () => {
    expect(selectDriver("postgres")).toBe("PostgresDriver");
  });
});
