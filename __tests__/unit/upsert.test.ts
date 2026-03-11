import "reflect-metadata";
import Container from "typedi";
import { EntityManager } from "../../src/core/EntityManager";
import { MySqlDriver } from "../../src/dialects/mysql/MySqlDriver";
import { PostgresDriver } from "../../src/dialects/postgres/PostgresDriver";
import { SqliteDriver } from "../../src/dialects/sqlite/SqliteDriver";
import { MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";

// Mock 모듈 설정
jest.mock("../../src/DatabaseClient", () => {
  return {
    DatabaseClient: {
      getInstance: jest.fn().mockReturnValue({
        type: "mysql",
        getConnection: jest.fn(),
        getOptions: jest.fn().mockReturnValue({ synchronize: false }),
        connect: jest.fn(),
      }),
    },
  };
});

const mockQuery = jest.fn().mockResolvedValue({ results: {}, fields: {} });
const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockStartTransaction = jest.fn().mockResolvedValue(undefined);
const mockCommit = jest.fn().mockResolvedValue(undefined);
const mockRollback = jest.fn().mockResolvedValue(undefined);
const mockClose = jest.fn().mockResolvedValue(undefined);

jest.mock("../../src/dialects/TransactionSessionManager", () => {
  return {
    TransactionSessionManager: jest.fn().mockImplementation(() => ({
      connect: mockConnect,
      startTransaction: mockStartTransaction,
      query: mockQuery,
      commit: mockCommit,
      rollback: mockRollback,
      close: mockClose,
    })),
  };
});

// 테스트용 엔티티 메타데이터
const UserEntity = class User {};
const userMetadata = {
  name: "User",
  target: UserEntity,
  columns: [
    { name: "id", options: { primary: true, autoIncrement: true } },
    { name: "email", options: {} },
    { name: "name", options: {} },
  ],
};

const ProductEntity = class Product {};
const productMetadata = {
  name: "Product",
  target: ProductEntity,
  columns: [
    { name: "sku", options: { primary: true } },
    { name: "name", options: {} },
    { name: "price", options: {} },
  ],
};

function createMySqlEntityManager() {
  const em = new EntityManager();
  (em as any).driver = new (jest.fn().mockImplementation(() => ({
    wrap: (name: string) => `\`${name}\``,
    buildUpsertSql: MySqlDriver.prototype.buildUpsertSql,
    isMySqlFamily: () => true,
  })))();
  return em;
}

function createEntityManagerWithDriver(driverType: string) {
  const em = new EntityManager();

  if (driverType === "mysql") {
    // Override client type
    const { DatabaseClient } = jest.requireMock("../../src/DatabaseClient");
    DatabaseClient.getInstance.mockReturnValue({
      type: "mysql",
      getConnection: jest.fn(),
      getOptions: jest.fn().mockReturnValue({ synchronize: false }),
      connect: jest.fn(),
    });
    (em as any).driver = {
      wrap: (name: string) => `\`${name}\``,
      buildUpsertSql: MySqlDriver.prototype.buildUpsertSql,
      isMySqlFamily: () => true,
    };
  } else if (driverType === "postgres") {
    const { DatabaseClient } = jest.requireMock("../../src/DatabaseClient");
    DatabaseClient.getInstance.mockReturnValue({
      type: "postgres",
      getConnection: jest.fn(),
      getOptions: jest.fn().mockReturnValue({ synchronize: false }),
      connect: jest.fn(),
    });
    (em as any).driver = {
      wrap: (name: string) => `"${name}"`,
      buildUpsertSql: PostgresDriver.prototype.buildUpsertSql,
      isMySqlFamily: () => false,
    };
  } else if (driverType === "sqlite") {
    const { DatabaseClient } = jest.requireMock("../../src/DatabaseClient");
    DatabaseClient.getInstance.mockReturnValue({
      type: "sqlite",
      getConnection: jest.fn(),
      getOptions: jest.fn().mockReturnValue({ synchronize: false }),
      connect: jest.fn(),
    });
    (em as any).driver = {
      wrap: (name: string) => `"${name}"`,
      buildUpsertSql: SqliteDriver.prototype.buildUpsertSql,
      isMySqlFamily: () => false,
    };
  }

  return em;
}

// ─────────────────────────────────────────────
// Driver-level buildUpsertSql 테스트
// ─────────────────────────────────────────────
describe("Driver.buildUpsertSql()", () => {
  const connector: any = { query: jest.fn() };

  describe("MySqlDriver", () => {
    const driver = new MySqlDriver(connector);

    it("should generate ON DUPLICATE KEY UPDATE SQL", () => {
      const result = driver.buildUpsertSql(
        "`User`",
        ["`id`", "`email`", "`name`"],
        ["`id`"],
        ["`email`", "`name`"],
      );

      expect(result).toContain("INSERT INTO `User`");
      expect(result).toContain("(`id`, `email`, `name`)");
      expect(result).toContain("VALUES (?, ?, ?)");
      expect(result).toContain("ON DUPLICATE KEY UPDATE");
      expect(result).toContain("`email` = VALUES(`email`)");
      expect(result).toContain("`name` = VALUES(`name`)");
    });
  });

  describe("PostgresDriver", () => {
    const driver = new PostgresDriver(connector);

    it("should generate ON CONFLICT DO UPDATE SQL", () => {
      const result = driver.buildUpsertSql(
        '"User"',
        ['"id"', '"email"', '"name"'],
        ['"id"'],
        ['"email"', '"name"'],
      );

      expect(result).toContain('INSERT INTO "User"');
      expect(result).toContain('("id", "email", "name")');
      expect(result).toContain("VALUES ($1, $2, $3)");
      expect(result).toContain('ON CONFLICT ("id")');
      expect(result).toContain("DO UPDATE SET");
      expect(result).toContain('"email" = EXCLUDED."email"');
      expect(result).toContain('"name" = EXCLUDED."name"');
    });
  });

  describe("SqliteDriver", () => {
    const driver = new SqliteDriver(connector);

    it("should generate ON CONFLICT DO UPDATE SQL", () => {
      const result = driver.buildUpsertSql(
        '"User"',
        ['"id"', '"email"', '"name"'],
        ['"id"'],
        ['"email"', '"name"'],
      );

      expect(result).toContain('INSERT INTO "User"');
      expect(result).toContain('("id", "email", "name")');
      expect(result).toContain("VALUES (?, ?, ?)");
      expect(result).toContain('ON CONFLICT ("id")');
      expect(result).toContain("DO UPDATE SET");
      expect(result).toContain('"email" = excluded."email"');
      expect(result).toContain('"name" = excluded."name"');
    });
  });

});

// ─────────────────────────────────────────────
// EntityManager.upsert() 테스트
// ─────────────────────────────────────────────
describe("EntityManager.upsert()", () => {
  let em: EntityManager;

  beforeEach(() => {
    MetadataLayerRegistry.reset();
    Container.reset();
    jest.clearAllMocks();
  });

  describe("with MySQL driver", () => {
    beforeEach(() => {
      em = createEntityManagerWithDriver("mysql");
    });

    it("should use PK columns as conflict columns when not specified", async () => {
      // resolveEntityMetadata를 모킹 (resolver 핸들러로 이동됨)
      (em as any).resolver.resolveEntityMetadata = jest.fn().mockReturnValue(userMetadata);

      await em.upsert(UserEntity, { id: 1, email: "test@test.com", name: "Test" });

      // 트랜잭션이 시작되고 커밋되었는지 확인
      expect(mockConnect).toHaveBeenCalled();
      expect(mockStartTransaction).toHaveBeenCalled();
      expect(mockQuery).toHaveBeenCalled();
      expect(mockCommit).toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalled();

      // SQL에 ON DUPLICATE KEY UPDATE가 포함되었는지 확인
      const queryCalls = mockQuery.mock.calls;
      const upsertCall = queryCalls.find((call: any[]) => {
        const sqlText = call[0]?.text || String(call[0]);
        return sqlText.includes("ON DUPLICATE KEY UPDATE");
      });
      expect(upsertCall).toBeDefined();
    });

    it("should use specified conflict columns", async () => {
      (em as any).resolver.resolveEntityMetadata = jest.fn().mockReturnValue(userMetadata);

      await em.upsert(
        UserEntity,
        { id: 1, email: "test@test.com", name: "Test" },
        ["email"],
      );

      expect(mockCommit).toHaveBeenCalled();
    });

    it("should throw if entity metadata is not found", async () => {
      (em as any).resolver.resolveEntityMetadata = jest.fn().mockReturnValue(null);

      await expect(
        em.upsert(UserEntity, { id: 1, email: "test@test.com" }),
      ).rejects.toThrow();
    });

    it("should return early if no insertable columns", async () => {
      const emptyMeta = {
        name: "Empty",
        target: class Empty {},
        columns: [
          { name: "id", options: { primary: true, autoIncrement: true } },
        ],
      };
      (em as any).resolver.resolveEntityMetadata = jest.fn().mockReturnValue(emptyMeta);

      // data에 id 값이 없어 autoIncrement 컬럼이 제외되어 insertable이 0
      await em.upsert(emptyMeta.target, {});

      expect(mockConnect).not.toHaveBeenCalled();
    });

    it("should rollback on query error", async () => {
      (em as any).resolver.resolveEntityMetadata = jest.fn().mockReturnValue(userMetadata);
      mockQuery.mockRejectedValueOnce(new Error("Query failed"));

      await expect(
        em.upsert(UserEntity, { id: 1, email: "err@test.com", name: "Err" }),
      ).rejects.toThrow("Query failed");

      expect(mockRollback).toHaveBeenCalled();
    });
  });

  describe("with PostgreSQL driver", () => {
    beforeEach(() => {
      em = createEntityManagerWithDriver("postgres");
    });

    it("should generate ON CONFLICT DO UPDATE SQL for PostgreSQL", async () => {
      (em as any).resolver.resolveEntityMetadata = jest.fn().mockReturnValue(productMetadata);

      await em.upsert(ProductEntity, { sku: "ABC123", name: "Widget", price: 9.99 });

      const queryCalls = mockQuery.mock.calls;
      const upsertCall = queryCalls.find((call: any[]) => {
        const sqlText = call[0]?.text || String(call[0]);
        return sqlText.includes("ON CONFLICT");
      });
      expect(upsertCall).toBeDefined();
    });
  });

  describe("with SQLite driver", () => {
    beforeEach(() => {
      em = createEntityManagerWithDriver("sqlite");
    });

    it("should generate ON CONFLICT DO UPDATE SQL for SQLite", async () => {
      (em as any).resolver.resolveEntityMetadata = jest.fn().mockReturnValue(productMetadata);

      await em.upsert(ProductEntity, { sku: "ABC123", name: "Widget", price: 9.99 });

      const queryCalls = mockQuery.mock.calls;
      const upsertCall = queryCalls.find((call: any[]) => {
        const sqlText = call[0]?.text || String(call[0]);
        return sqlText.includes("ON CONFLICT");
      });
      expect(upsertCall).toBeDefined();
    });
  });


  describe("conflict columns edge cases", () => {
    beforeEach(() => {
      em = createEntityManagerWithDriver("mysql");
    });

    it("should throw if no PK and no conflict columns specified", async () => {
      const noPkMeta = {
        name: "NoPk",
        target: class NoPk {},
        columns: [
          { name: "field1", options: {} },
          { name: "field2", options: {} },
        ],
      };
      (em as any).resolver.resolveEntityMetadata = jest.fn().mockReturnValue(noPkMeta);

      await expect(
        em.upsert(noPkMeta.target, { field1: "a", field2: "b" }),
      ).rejects.toThrow();
    });

    it("should skip update columns that are also conflict columns", async () => {
      (em as any).resolver.resolveEntityMetadata = jest.fn().mockReturnValue(productMetadata);

      // sku가 conflict 이자 유일한 컬럼인 경우
      await em.upsert(ProductEntity, { sku: "ONLY" }, ["sku"]);

      // 업데이트할 컬럼이 없으므로 트랜잭션이 시작되지 않아야 함
      expect(mockConnect).not.toHaveBeenCalled();
    });
  });
});

// ─────────────────────────────────────────────
// BaseRepository.upsert() 위임 테스트
// ─────────────────────────────────────────────
describe("BaseRepository.upsert()", () => {
  it("should delegate to EntityManager.upsert()", async () => {
    const mockEm = {
      upsert: jest.fn().mockResolvedValue(undefined),
    } as any;

    const { BaseRepository } = require("../../src/core/BaseRepository");
    const repo = new BaseRepository(UserEntity, mockEm);

    await repo.upsert({ id: 1, email: "repo@test.com" }, ["email"]);

    expect(mockEm.upsert).toHaveBeenCalledWith(
      UserEntity,
      { id: 1, email: "repo@test.com" },
      ["email"],
    );
  });

  it("should work without conflictColumns", async () => {
    const mockEm = {
      upsert: jest.fn().mockResolvedValue(undefined),
    } as any;

    const { BaseRepository } = require("../../src/core/BaseRepository");
    const repo = new BaseRepository(UserEntity, mockEm);

    await repo.upsert({ id: 1, name: "Test" });

    expect(mockEm.upsert).toHaveBeenCalledWith(
      UserEntity,
      { id: 1, name: "Test" },
      undefined,
    );
  });
});
