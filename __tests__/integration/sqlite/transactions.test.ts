/**
 * SQLite In-Memory 트랜잭션 통합 테스트
 *
 * SqliteConnector의 BEGIN / COMMIT / ROLLBACK 동작을 검증합니다.
 * SQLite는 in-memory이므로 외부 DB 불필요, CI에서 항상 실행 가능합니다.
 */

import "reflect-metadata";
import { SqliteConnector } from "../../../src/dialects/sqlite/SqliteConnector";
import { DatabaseClientOptions } from "../../../src/core/DatabaseClientOptions";

describe("[Integration] SQLite In-Memory: 트랜잭션 테스트", () => {
  let connector: SqliteConnector;

  beforeAll(async () => {
    connector = new SqliteConnector();
    await connector.connect({
      type: "sqlite",
      database: ":memory:",
      logging: false,
    } as DatabaseClientOptions);

    await connector.query(
      "CREATE TABLE IF NOT EXISTS \"txn_test\" (\"id\" INTEGER PRIMARY KEY AUTOINCREMENT, \"value\" TEXT NOT NULL)",
    );
  });

  afterAll(async () => {
    await connector.close();
  });

  beforeEach(async () => {
    await connector.query("DELETE FROM \"txn_test\"");
  });

  // ─────────────────────────────────────────────────────────
  // COMMIT
  // ─────────────────────────────────────────────────────────

  describe("Commit", () => {
    it("트랜잭션 내에서 INSERT 후 COMMIT하면 데이터가 유지되어야 한다", async () => {
      const db = await connector.getConnection();

      await connector.startTransaction(db);
      await connector.query(
        "INSERT INTO \"txn_test\" (\"value\") VALUES ('committed')",
        db,
      );
      await connector.commit(db);

      const rows = await connector.query("SELECT * FROM \"txn_test\"");
      expect(rows.length).toBe(1);
      expect(rows[0].value).toBe("committed");
    });

    it("COMMIT 후 여러 행이 모두 반영되어야 한다", async () => {
      const db = await connector.getConnection();

      await connector.startTransaction(db);
      await connector.query(
        "INSERT INTO \"txn_test\" (\"value\") VALUES ('a')",
        db,
      );
      await connector.query(
        "INSERT INTO \"txn_test\" (\"value\") VALUES ('b')",
        db,
      );
      await connector.query(
        "INSERT INTO \"txn_test\" (\"value\") VALUES ('c')",
        db,
      );
      await connector.commit(db);

      const rows = await connector.query("SELECT * FROM \"txn_test\"");
      expect(rows.length).toBe(3);
    });
  });

  // ─────────────────────────────────────────────────────────
  // ROLLBACK
  // ─────────────────────────────────────────────────────────

  describe("Rollback", () => {
    it("트랜잭션 내에서 INSERT 후 ROLLBACK하면 데이터가 사라져야 한다", async () => {
      const db = await connector.getConnection();

      await connector.startTransaction(db);
      await connector.query(
        "INSERT INTO \"txn_test\" (\"value\") VALUES ('rollback me')",
        db,
      );
      await connector.rollback(db);

      const rows = await connector.query("SELECT * FROM \"txn_test\"");
      expect(rows.length).toBe(0);
    });

    it("ROLLBACK 후 기존 데이터는 유지되어야 한다", async () => {
      // 먼저 커밋된 데이터 삽입
      await connector.query(
        "INSERT INTO \"txn_test\" (\"value\") VALUES ('existing')",
      );

      // 트랜잭션 시작 후 롤백
      const db = await connector.getConnection();
      await connector.startTransaction(db);
      await connector.query(
        "INSERT INTO \"txn_test\" (\"value\") VALUES ('should disappear')",
        db,
      );
      await connector.rollback(db);

      const rows = await connector.query("SELECT * FROM \"txn_test\"");
      expect(rows.length).toBe(1);
      expect(rows[0].value).toBe("existing");
    });

    it("UPDATE를 ROLLBACK하면 원래 값이 유지되어야 한다", async () => {
      await connector.query(
        "INSERT INTO \"txn_test\" (\"value\") VALUES ('original')",
      );

      const db = await connector.getConnection();
      await connector.startTransaction(db);
      await connector.query(
        "UPDATE \"txn_test\" SET \"value\" = 'modified'",
        db,
      );
      await connector.rollback(db);

      const rows = await connector.query("SELECT * FROM \"txn_test\"");
      expect(rows[0].value).toBe("original");
    });

    it("DELETE를 ROLLBACK하면 삭제된 행이 복원되어야 한다", async () => {
      await connector.query(
        "INSERT INTO \"txn_test\" (\"value\") VALUES ('keep me')",
      );

      const db = await connector.getConnection();
      await connector.startTransaction(db);
      await connector.query("DELETE FROM \"txn_test\"", db);
      await connector.rollback(db);

      const rows = await connector.query("SELECT * FROM \"txn_test\"");
      expect(rows.length).toBe(1);
      expect(rows[0].value).toBe("keep me");
    });
  });

  // ─────────────────────────────────────────────────────────
  // SAVEPOINT
  // ─────────────────────────────────────────────────────────

  describe("Savepoint", () => {
    it("SAVEPOINT로 부분 ROLLBACK이 가능해야 한다", async () => {
      const db = await connector.getConnection();

      await connector.startTransaction(db);

      // 첫 번째 INSERT
      await connector.query(
        "INSERT INTO \"txn_test\" (\"value\") VALUES ('before_sp')",
        db,
      );

      // SAVEPOINT 생성
      await connector.query("SAVEPOINT sp1", db);

      // 두 번째 INSERT (savepoint 이후)
      await connector.query(
        "INSERT INTO \"txn_test\" (\"value\") VALUES ('after_sp')",
        db,
      );

      // ROLLBACK TO SAVEPOINT
      await connector.query("ROLLBACK TO SAVEPOINT sp1", db);

      // COMMIT
      await connector.commit(db);

      const rows = await connector.query("SELECT * FROM \"txn_test\"");
      expect(rows.length).toBe(1);
      expect(rows[0].value).toBe("before_sp");
    });

    it("중첩 SAVEPOINT가 동작해야 한다", async () => {
      const db = await connector.getConnection();

      await connector.startTransaction(db);

      await connector.query(
        "INSERT INTO \"txn_test\" (\"value\") VALUES ('level0')",
        db,
      );
      await connector.query("SAVEPOINT sp1", db);

      await connector.query(
        "INSERT INTO \"txn_test\" (\"value\") VALUES ('level1')",
        db,
      );
      await connector.query("SAVEPOINT sp2", db);

      await connector.query(
        "INSERT INTO \"txn_test\" (\"value\") VALUES ('level2')",
        db,
      );

      // sp2 롤백 → level2 사라짐
      await connector.query("ROLLBACK TO SAVEPOINT sp2", db);

      await connector.commit(db);

      const rows = await connector.query(
        "SELECT * FROM \"txn_test\" ORDER BY \"id\"",
      );
      expect(rows.length).toBe(2);
      expect(rows[0].value).toBe("level0");
      expect(rows[1].value).toBe("level1");
    });
  });

  // ─────────────────────────────────────────────────────────
  // EDGE CASES
  // ─────────────────────────────────────────────────────────

  describe("엣지 케이스", () => {
    it("빈 트랜잭션을 COMMIT해도 에러가 발생하지 않아야 한다", async () => {
      const db = await connector.getConnection();

      await connector.startTransaction(db);
      await connector.commit(db);

      // 데이터 없어야 함
      const rows = await connector.query("SELECT * FROM \"txn_test\"");
      expect(rows.length).toBe(0);
    });

    it("빈 트랜잭션을 ROLLBACK해도 에러가 발생하지 않아야 한다", async () => {
      const db = await connector.getConnection();

      await connector.startTransaction(db);
      await connector.rollback(db);

      const rows = await connector.query("SELECT * FROM \"txn_test\"");
      expect(rows.length).toBe(0);
    });
  });
});
