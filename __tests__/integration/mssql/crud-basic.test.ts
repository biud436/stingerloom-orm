/**
 * MSSQL 기본 CRUD 통합 테스트
 *
 * 실제 MSSQL 서버(Docker)에 연결하여 MssqlConnector + MssqlDriver의
 * CREATE TABLE / INSERT / SELECT / UPDATE / DELETE 전체 사이클을 검증합니다.
 *
 * 실행 전 필요 사항:
 *   - Docker로 MSSQL 서버 실행 중
 *   - INTEGRATION_TEST=true 환경변수 설정
 *   - MSSQL_HOST, MSSQL_PORT, MSSQL_USER, MSSQL_PASSWORD, MSSQL_DATABASE 환경변수 (또는 기본값 사용)
 *
 * @example
 *   INTEGRATION_TEST=true pnpm test -- --testPathPattern="mssql/crud"
 */

import "reflect-metadata";

const SKIP = process.env.INTEGRATION_TEST !== "true";

function getMssqlConfig() {
  return {
    type: "mssql" as const,
    host: process.env.MSSQL_HOST || "localhost",
    port: parseInt(process.env.MSSQL_PORT || "1433", 10),
    username: process.env.MSSQL_USER || "sa",
    password: process.env.MSSQL_PASSWORD || "YourStrong@Passw0rd",
    database: process.env.MSSQL_DATABASE || "master",
    logging: false,
  };
}

const describeIf = SKIP ? describe.skip : describe;

describeIf("[Integration] MSSQL: 기본 CRUD 테스트", () => {
  // Dynamic imports to avoid loading mssql when skipped
  let MssqlConnector: any;
  let MssqlDriver: any;
  let connector: any;
  let driver: any;
  const tableName = `mssql_crud_${Date.now()}`;

  beforeAll(async () => {
    const connModule = await import(
      "../../../src/dialects/mssql/MssqlConnector"
    );
    const drvModule = await import("../../../src/dialects/mssql/MssqlDriver");
    MssqlConnector = connModule.MssqlConnector;
    MssqlDriver = drvModule.MssqlDriver;

    connector = new MssqlConnector();
    await connector.connect(getMssqlConfig());
    driver = new MssqlDriver(connector);

    // 테스트 테이블 생성
    await connector.query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = '${tableName}')
      CREATE TABLE [${tableName}] (
        [id] INT IDENTITY(1,1) PRIMARY KEY,
        [name] NVARCHAR(255) NOT NULL,
        [age] INT NOT NULL DEFAULT 0,
        [email] NVARCHAR(255) NULL
      )
    `);
  }, 30000);

  afterAll(async () => {
    try {
      await connector.query(`DROP TABLE IF EXISTS [${tableName}]`);
    } catch {
      // ignore
    }
    await connector.close();
  }, 15000);

  beforeEach(async () => {
    await connector.query(`DELETE FROM [${tableName}]`);
    // IDENTITY 리셋
    await connector.query(
      `DBCC CHECKIDENT ('${tableName}', RESEED, 0)`,
    );
  });

  // ─── INSERT ───

  describe("Insert", () => {
    it("INSERT 후 결과가 반환되어야 한다", async () => {
      const result = await connector.query(
        `INSERT INTO [${tableName}] ([name], [age], [email]) VALUES ('Alice', 25, 'alice@test.com')`,
      );
      expect(result).toBeDefined();
    });

    it("여러 행을 순차 삽입할 수 있어야 한다", async () => {
      await connector.query(
        `INSERT INTO [${tableName}] ([name], [age]) VALUES ('User1', 20)`,
      );
      await connector.query(
        `INSERT INTO [${tableName}] ([name], [age]) VALUES ('User2', 25)`,
      );

      const rows = await connector.query(
        `SELECT COUNT(*) as cnt FROM [${tableName}]`,
      );
      expect(rows[0].cnt).toBe(2);
    });
  });

  // ─── SELECT ───

  describe("Select", () => {
    beforeEach(async () => {
      await connector.query(
        `INSERT INTO [${tableName}] ([name], [age], [email]) VALUES ('Alice', 25, 'alice@test.com')`,
      );
      await connector.query(
        `INSERT INTO [${tableName}] ([name], [age], [email]) VALUES ('Bob', 30, 'bob@test.com')`,
      );
      await connector.query(
        `INSERT INTO [${tableName}] ([name], [age], [email]) VALUES ('Charlie', 35, NULL)`,
      );
    });

    it("SELECT *로 전체 조회할 수 있어야 한다", async () => {
      const rows = await connector.query(
        `SELECT * FROM [${tableName}]`,
      );
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBe(3);
    });

    it("WHERE 조건으로 필터링할 수 있어야 한다", async () => {
      const rows = await connector.query(
        `SELECT * FROM [${tableName}] WHERE [name] = 'Alice'`,
      );
      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe("Alice");
    });

    it("COUNT로 집계할 수 있어야 한다", async () => {
      const rows = await connector.query(
        `SELECT COUNT(*) as cnt FROM [${tableName}] WHERE [age] >= 30`,
      );
      expect(rows[0].cnt).toBe(2);
    });

    it("ORDER BY로 정렬할 수 있어야 한다", async () => {
      const rows = await connector.query(
        `SELECT * FROM [${tableName}] ORDER BY [age] DESC`,
      );
      expect(rows[0].name).toBe("Charlie");
      expect(rows[2].name).toBe("Alice");
    });
  });

  // ─── UPDATE ───

  describe("Update", () => {
    it("UPDATE로 값을 변경할 수 있어야 한다", async () => {
      await connector.query(
        `INSERT INTO [${tableName}] ([name], [age]) VALUES ('Diana', 28)`,
      );

      await connector.query(
        `UPDATE [${tableName}] SET [name] = 'Diana Updated', [age] = 29 WHERE [name] = 'Diana'`,
      );

      const rows = await connector.query(
        `SELECT * FROM [${tableName}] WHERE [name] = 'Diana Updated'`,
      );
      expect(rows.length).toBe(1);
      expect(rows[0].age).toBe(29);
    });
  });

  // ─── DELETE ───

  describe("Delete", () => {
    it("DELETE로 행을 삭제할 수 있어야 한다", async () => {
      await connector.query(
        `INSERT INTO [${tableName}] ([name], [age]) VALUES ('ToDelete', 40)`,
      );

      await connector.query(
        `DELETE FROM [${tableName}] WHERE [name] = 'ToDelete'`,
      );

      const rows = await connector.query(
        `SELECT * FROM [${tableName}] WHERE [name] = 'ToDelete'`,
      );
      expect(rows.length).toBe(0);
    });
  });

  // ─── FULL LIFECYCLE ───

  describe("전체 라이프사이클", () => {
    it("C -> R -> U -> R -> D -> R 흐름이 동작해야 한다", async () => {
      // CREATE
      await connector.query(
        `INSERT INTO [${tableName}] ([name], [age], [email]) VALUES ('LC', 25, 'lc@test.com')`,
      );

      // READ
      let rows = await connector.query(
        `SELECT * FROM [${tableName}] WHERE [name] = 'LC'`,
      );
      expect(rows.length).toBe(1);
      const id = rows[0].id;

      // UPDATE
      await connector.query(
        `UPDATE [${tableName}] SET [name] = 'LC Updated' WHERE [id] = ${id}`,
      );

      // READ after UPDATE
      rows = await connector.query(
        `SELECT * FROM [${tableName}] WHERE [id] = ${id}`,
      );
      expect(rows[0].name).toBe("LC Updated");

      // DELETE
      await connector.query(
        `DELETE FROM [${tableName}] WHERE [id] = ${id}`,
      );

      // READ after DELETE
      rows = await connector.query(
        `SELECT * FROM [${tableName}] WHERE [id] = ${id}`,
      );
      expect(rows.length).toBe(0);
    });
  });
});
