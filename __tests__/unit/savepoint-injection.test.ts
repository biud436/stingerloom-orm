import { validateSavepointName } from "../../src/utils/validateSavepointName";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";
import { MySqlDataSource } from "../../src/dialects/mysql/MySqlDataSource";
import { PostgresDataSource } from "../../src/dialects/postgres/PostgresDataSource";
import { SqliteDataSource } from "../../src/dialects/sqlite/SqliteDataSource";

// ─────────────────────────────────────────────────────────
// validateSavepointName 유틸리티 함수 테스트
// ─────────────────────────────────────────────────────────

describe("validateSavepointName", () => {
  describe("유효한 savepoint 이름", () => {
    const validNames = [
      "sp1",
      "my_savepoint",
      "_private",
      "SAVEPOINT_NAME",
      "a",
      "A",
      "_",
      "sp_123",
      "camelCase",
      "PascalCase",
      "snake_case_name",
      "_leading_underscore",
      "a1b2c3",
    ];

    it.each(validNames)('"%s"은 통과해야 한다', (name) => {
      expect(() => validateSavepointName(name)).not.toThrow();
    });
  });

  describe("SQL Injection 시도 — 거부해야 한다", () => {
    const injectionAttempts = [
      'x; DROP TABLE users; --',
      "'; DELETE FROM accounts; --",
      "sp1; SELECT * FROM secrets",
      "name OR 1=1",
      "sp\"; DROP TABLE t; --",
      "sp`; DROP TABLE t; --",
    ];

    it.each(injectionAttempts)('"%s"은 거부해야 한다', (name) => {
      expect(() => validateSavepointName(name)).toThrow(OrmError);
      expect(() => validateSavepointName(name)).toThrow(
        /Invalid savepoint name/,
      );
    });

    it("SQL injection 에러의 코드가 INVALID_SAVEPOINT_NAME이어야 한다", () => {
      try {
        validateSavepointName("x; DROP TABLE users; --");
        fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(OrmError);
        expect((e as OrmError).code).toBe(
          OrmErrorCode.INVALID_SAVEPOINT_NAME,
        );
      }
    });
  });

  describe("유효하지 않은 이름 패턴", () => {
    const invalidNames = [
      "",              // 빈 문자열
      "123abc",        // 숫자로 시작
      "my-savepoint",  // 하이픈 포함
      "my savepoint",  // 공백 포함
      "my.savepoint",  // 점 포함
      "sp@name",       // 특수문자 포함
      "sp!name",       // 느낌표
      "sp#name",       // 해시
      "sp$name",       // 달러 기호
      "name\ttab",     // 탭 문자
      "name\nnewline", // 개행 문자
      "한글이름",        // 비 ASCII 문자
    ];

    it.each(invalidNames)('"%s"은 거부해야 한다', (name) => {
      expect(() => validateSavepointName(name)).toThrow(OrmError);
    });
  });
});

// ─────────────────────────────────────────────────────────
// DataSource 수준에서 savepoint/rollbackTo 검증
// ─────────────────────────────────────────────────────────

describe("DataSource savepoint name validation", () => {
  // 공통 mock connector
  const mockConnector = {
    getConnection: jest.fn().mockResolvedValue({
      release: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
    }),
    connect: jest.fn(),
    close: jest.fn(),
    query: jest.fn().mockResolvedValue([]),
    startTransaction: jest.fn(),
    rollback: jest.fn(),
    commit: jest.fn(),
  };

  describe("MySqlDataSource", () => {
    let ds: MySqlDataSource;

    beforeEach(async () => {
      ds = new MySqlDataSource(mockConnector as any);
      await ds.createConnection();
    });

    it("유효한 이름으로 savepoint 호출 시 에러 없이 실행", async () => {
      await expect(ds.savepoint("sp_valid")).resolves.not.toThrow();
    });

    it("SQL injection 이름으로 savepoint 호출 시 OrmError throw", async () => {
      await expect(
        ds.savepoint("x; DROP TABLE users; --"),
      ).rejects.toThrow(OrmError);
    });

    it("SQL injection 이름으로 rollbackTo 호출 시 OrmError throw", async () => {
      await expect(
        ds.rollbackTo("x; DROP TABLE users; --"),
      ).rejects.toThrow(OrmError);
    });
  });

  describe("PostgresDataSource", () => {
    let ds: PostgresDataSource;

    beforeEach(async () => {
      ds = new PostgresDataSource(mockConnector as any);
      await ds.createConnection();
    });

    it("유효한 이름으로 savepoint 호출 시 에러 없이 실행", async () => {
      await expect(ds.savepoint("sp_valid")).resolves.not.toThrow();
    });

    it("SQL injection 이름으로 savepoint 호출 시 OrmError throw", async () => {
      await expect(
        ds.savepoint("x; DROP TABLE users; --"),
      ).rejects.toThrow(OrmError);
    });

    it("SQL injection 이름으로 rollbackTo 호출 시 OrmError throw", async () => {
      await expect(
        ds.rollbackTo("x; DROP TABLE users; --"),
      ).rejects.toThrow(OrmError);
    });
  });

  describe("SqliteDataSource", () => {
    let ds: SqliteDataSource;

    beforeEach(async () => {
      ds = new SqliteDataSource(mockConnector as any);
      await ds.createConnection();
    });

    it("유효한 이름으로 savepoint 호출 시 에러 없이 실행", async () => {
      await expect(ds.savepoint("sp_valid")).resolves.not.toThrow();
    });

    it("SQL injection 이름으로 savepoint 호출 시 OrmError throw", async () => {
      await expect(
        ds.savepoint("x; DROP TABLE users; --"),
      ).rejects.toThrow(OrmError);
    });

    it("SQL injection 이름으로 rollbackTo 호출 시 OrmError throw", async () => {
      await expect(
        ds.rollbackTo("x; DROP TABLE users; --"),
      ).rejects.toThrow(OrmError);
    });
  });
});

// ─────────────────────────────────────────────────────────
// Driver 수준에서 savepoint SQL 생성 검증
// ─────────────────────────────────────────────────────────

describe("Driver savepoint SQL methods validation", () => {
  // 최소 mock connector for driver instantiation
  const mockConnector = {
    query: jest.fn(),
    getConnection: jest.fn(),
    connect: jest.fn(),
    close: jest.fn(),
    startTransaction: jest.fn(),
    rollback: jest.fn(),
    commit: jest.fn(),
  };

  // lazy import to avoid issues with reflect-metadata
  let MySqlDriver: any;
  let PostgresDriver: any;
  let SqliteDriver: any;

  beforeAll(() => {
    MySqlDriver =
      require("../../src/dialects/mysql/MySqlDriver").MySqlDriver;
    PostgresDriver =
      require("../../src/dialects/postgres/PostgresDriver").PostgresDriver;
    SqliteDriver =
      require("../../src/dialects/sqlite/SqliteDriver").SqliteDriver;
  });

  describe.each(["MySqlDriver", "PostgresDriver", "SqliteDriver"])(
    "%s",
    (driverName) => {
      let driver: any;

      beforeEach(() => {
        if (driverName === "MySqlDriver") {
          driver = new MySqlDriver(mockConnector);
        } else if (driverName === "PostgresDriver") {
          driver = new PostgresDriver(mockConnector);
        } else {
          driver = new SqliteDriver(mockConnector);
        }
      });

      it("createSavepointSql — 유효한 이름은 통과", () => {
        expect(() => driver.createSavepointSql("sp_1")).not.toThrow();
      });

      it("createSavepointSql — 유효하지 않은 이름은 거부", () => {
        expect(() =>
          driver.createSavepointSql("x; DROP TABLE users; --"),
        ).toThrow(OrmError);
      });

      it("rollbackToSavepointSql — 유효하지 않은 이름은 거부", () => {
        expect(() =>
          driver.rollbackToSavepointSql("x; DROP TABLE users; --"),
        ).toThrow(OrmError);
      });

      it("releaseSavepointSql — 유효하지 않은 이름은 거부", () => {
        expect(() =>
          driver.releaseSavepointSql("x; DROP TABLE users; --"),
        ).toThrow(OrmError);
      });
    },
  );
});
