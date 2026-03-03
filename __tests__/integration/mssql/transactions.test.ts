/**
 * MSSQL 트랜잭션 통합 테스트
 *
 * 실제 MSSQL 서버(Docker)에 연결하여 트랜잭션의
 * COMMIT / ROLLBACK 동작을 검증합니다.
 *
 * 실행 조건:
 *   INTEGRATION_TEST=true pnpm test -- --testPathPattern="mssql/transactions"
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

describeIf("[Integration] MSSQL: 트랜잭션 테스트", () => {
  let connector: any;
  const tableName = `mssql_txn_${Date.now()}`;

  beforeAll(async () => {
    const { MssqlConnector } = await import(
      "../../../src/dialects/mssql/MssqlConnector"
    );
    connector = new MssqlConnector();
    await connector.connect(getMssqlConfig());

    await connector.query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = '${tableName}')
      CREATE TABLE [${tableName}] (
        [id] INT IDENTITY(1,1) PRIMARY KEY,
        [value] NVARCHAR(255) NOT NULL
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
  });

  describe("Commit", () => {
    it("COMMIT 후 데이터가 유지되어야 한다", async () => {
      const pool = await connector.getConnection();
      await connector.startTransaction(pool);

      await connector.query(
        `INSERT INTO [${tableName}] ([value]) VALUES ('committed')`,
        pool,
      );
      await connector.commit(pool);

      const rows = await connector.query(
        `SELECT * FROM [${tableName}]`,
      );
      expect(rows.length).toBe(1);
      expect(rows[0].value).toBe("committed");
    });
  });

  describe("Rollback", () => {
    it("ROLLBACK 후 데이터가 사라져야 한다", async () => {
      const pool = await connector.getConnection();
      await connector.startTransaction(pool);

      await connector.query(
        `INSERT INTO [${tableName}] ([value]) VALUES ('rolled back')`,
        pool,
      );
      await connector.rollback(pool);

      const rows = await connector.query(
        `SELECT * FROM [${tableName}]`,
      );
      expect(rows.length).toBe(0);
    });

    it("ROLLBACK 후 기존 데이터는 유지되어야 한다", async () => {
      // 먼저 커밋된 데이터 삽입
      await connector.query(
        `INSERT INTO [${tableName}] ([value]) VALUES ('existing')`,
      );

      const pool = await connector.getConnection();
      await connector.startTransaction(pool);
      await connector.query(
        `INSERT INTO [${tableName}] ([value]) VALUES ('should disappear')`,
        pool,
      );
      await connector.rollback(pool);

      const rows = await connector.query(
        `SELECT * FROM [${tableName}]`,
      );
      expect(rows.length).toBe(1);
      expect(rows[0].value).toBe("existing");
    });
  });
});
