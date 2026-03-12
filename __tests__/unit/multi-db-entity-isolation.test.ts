/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Multi-DB 엔티티 메타데이터 격리 테스트
 *
 * EntityManager가 entities 옵션을 올바르게 저장하고,
 * SchemaRegistrar가 해당 엔티티만 DDL 처리하는지 검증합니다.
 *
 * fixes #42
 */
import "reflect-metadata";
import { Entity, Column, PrimaryGeneratedColumn } from "../../src/decorators";

// ── 테스트 전용 엔티티 ──────────────────────────────────────

@Entity()
class UserA {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 100 })
  name!: string;
}

@Entity()
class UserB {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 100 })
  email!: string;
}

@Entity()
class SharedEntity {
  @PrimaryGeneratedColumn()
  id!: number;
}

// ── Mock 설정 ──────────────────────────────────────────────

function resetDatabaseClient() {
  const { DatabaseClient } = require("../../src/DatabaseClient");
  (DatabaseClient as any).instance = undefined;
  return DatabaseClient;
}

jest.mock("../../src/dialects/mysql/MySqlConnector", () => ({
  MySqlConnector: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("../../src/dialects/postgres/PostgresConnector", () => ({
  PostgresConnector: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("../../src/dialects/sqlite/SqliteConnector", () => ({
  SqliteConnector: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

const BASE_OPTIONS = {
  host: "localhost",
  username: "test",
  password: "test",
  database: "testdb",
};

describe("Multi-DB Entity Isolation (fixes #42)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetDatabaseClient();
  });

  describe("EntityManager._entities 저장", () => {
    it("connect() 후 getEntities()가 지정된 엔티티 목록을 반환해야 한다", async () => {
      const { EntityManager } = require("../../src/core/EntityManager");
      const em = new EntityManager();

      // register 대신 connect만 호출 (DDL 실행 방지)
      await em.connect(
        { ...BASE_OPTIONS, type: "mysql", port: 3306, entities: [UserA] },
        "db1",
      );

      // _ctx를 통해 getEntities 확인 — private이므로 any 캐스트
      const ctx = (em as any)._ctx;
      expect(ctx.getEntities()).toEqual([UserA]);
    });

    it("entities 미지정 시 빈 배열을 반환해야 한다 (하위 호환)", async () => {
      const { EntityManager } = require("../../src/core/EntityManager");
      const em = new EntityManager();

      await em.connect(
        { ...BASE_OPTIONS, type: "mysql", port: 3306, entities: [] },
        "default",
      );

      const ctx = (em as any)._ctx;
      expect(ctx.getEntities()).toEqual([]);
    });
  });

  describe("SchemaRegistrar 엔티티 필터", () => {
    it("entities가 지정되면 해당 엔티티 테이블만 생성해야 한다", async () => {
      const DatabaseClient = resetDatabaseClient();
      const client = DatabaseClient.getInstance();

      // MySQL 연결 등록
      await client.connect(
        { ...BASE_OPTIONS, type: "mysql", port: 3306, synchronize: true, entities: [UserA] },
        "db1",
      );

      const createdTables: string[] = [];
      const mockDriver = {
        hasTable: jest.fn().mockResolvedValue([]),
        createTable: jest.fn().mockImplementation((name: string) => {
          createdTables.push(name);
          return Promise.resolve();
        }),
        castType: jest.fn().mockReturnValue("INT"),
        getIndexes: jest.fn().mockResolvedValue([]),
        hasForeignKey: jest.fn().mockResolvedValue(false),
        addForeignKey: jest.fn().mockResolvedValue(undefined),
        executeRaw: jest.fn().mockResolvedValue(undefined),
        hasColumn: jest.fn().mockResolvedValue(true),
      };

      const { EntityManager } = require("../../src/core/EntityManager");
      const em = new EntityManager();
      await em.connect(
        { ...BASE_OPTIONS, type: "mysql", port: 3306, synchronize: true, entities: [UserA] },
        "db1",
      );

      // driver를 mock으로 교체
      (em as any).driver = mockDriver;

      // schemaRegistrar.registerEntities() 호출
      await (em as any).schemaRegistrar.registerEntities();

      // UserA만 테이블이 생성되어야 함 (UserB는 건너뜀)
      expect(createdTables).toContain("user_a");
      expect(createdTables).not.toContain("user_b");
      expect(createdTables).not.toContain("shared_entity");
    });

    it("entities가 빈 배열이면 모든 엔티티를 처리해야 한다 (하위 호환)", async () => {
      const DatabaseClient = resetDatabaseClient();
      const client = DatabaseClient.getInstance();

      await client.connect(
        { ...BASE_OPTIONS, type: "mysql", port: 3306, synchronize: true, entities: [] },
        "default",
      );

      const createdTables: string[] = [];
      const mockDriver = {
        hasTable: jest.fn().mockResolvedValue([]),
        createTable: jest.fn().mockImplementation((name: string) => {
          createdTables.push(name);
          return Promise.resolve();
        }),
        castType: jest.fn().mockReturnValue("INT"),
        getIndexes: jest.fn().mockResolvedValue([]),
        hasForeignKey: jest.fn().mockResolvedValue(false),
        addForeignKey: jest.fn().mockResolvedValue(undefined),
        executeRaw: jest.fn().mockResolvedValue(undefined),
        hasColumn: jest.fn().mockResolvedValue(true),
      };

      const { EntityManager } = require("../../src/core/EntityManager");
      const em = new EntityManager();
      await em.connect(
        { ...BASE_OPTIONS, type: "mysql", port: 3306, synchronize: true, entities: [] },
        "default",
      );

      (em as any).driver = mockDriver;
      await (em as any).schemaRegistrar.registerEntities();

      // entities가 빈 배열이면 모든 @Entity()가 처리됨
      expect(createdTables.length).toBeGreaterThanOrEqual(3);
      expect(createdTables).toContain("user_a");
      expect(createdTables).toContain("user_b");
      expect(createdTables).toContain("shared_entity");
    });
  });

  describe("getSynchronize() connectionName 수정", () => {
    it("각 EntityManager가 자기 연결의 synchronize 값을 읽어야 한다", async () => {
      const DatabaseClient = resetDatabaseClient();
      const client = DatabaseClient.getInstance();

      // db1: synchronize=true, db2: synchronize=false
      await client.connect(
        { ...BASE_OPTIONS, type: "mysql", port: 3306, synchronize: true, entities: [UserA] },
        "db1",
      );
      await client.connect(
        { ...BASE_OPTIONS, type: "mysql", port: 3306, synchronize: false, entities: [UserB] },
        "db2",
      );

      const { EntityManager } = require("../../src/core/EntityManager");

      const em1 = new EntityManager();
      await em1.connect(
        { ...BASE_OPTIONS, type: "mysql", port: 3306, synchronize: true, entities: [UserA] },
        "db1",
      );

      const em2 = new EntityManager();
      await em2.connect(
        { ...BASE_OPTIONS, type: "mysql", port: 3306, synchronize: false, entities: [UserB] },
        "db2",
      );

      const ctx1 = (em1 as any)._ctx;
      const ctx2 = (em2 as any)._ctx;

      expect(ctx1.getSynchronize()).toBe(true);
      expect(ctx2.getSynchronize()).toBe(false);
    });
  });

  describe("두 EntityManager 간 DDL 격리", () => {
    it("em1은 UserA만, em2는 UserB만 테이블을 생성해야 한다", async () => {
      const DatabaseClient = resetDatabaseClient();
      const client = DatabaseClient.getInstance();

      await client.connect(
        { ...BASE_OPTIONS, type: "mysql", port: 3306, synchronize: true, entities: [UserA] },
        "db1",
      );
      await client.connect(
        { ...BASE_OPTIONS, type: "mysql", port: 3306, synchronize: true, entities: [UserB] },
        "db2",
      );

      const { EntityManager } = require("../../src/core/EntityManager");

      // em1: UserA만
      const createdTablesDb1: string[] = [];
      const mockDriver1 = {
        hasTable: jest.fn().mockResolvedValue([]),
        createTable: jest.fn().mockImplementation((name: string) => {
          createdTablesDb1.push(name);
          return Promise.resolve();
        }),
        castType: jest.fn().mockReturnValue("INT"),
        getIndexes: jest.fn().mockResolvedValue([]),
        hasForeignKey: jest.fn().mockResolvedValue(false),
        executeRaw: jest.fn().mockResolvedValue(undefined),
        hasColumn: jest.fn().mockResolvedValue(true),
      };

      const em1 = new EntityManager();
      await em1.connect(
        { ...BASE_OPTIONS, type: "mysql", port: 3306, synchronize: true, entities: [UserA] },
        "db1",
      );
      (em1 as any).driver = mockDriver1;
      await (em1 as any).schemaRegistrar.registerEntities();

      expect(createdTablesDb1).toEqual(["user_a"]);

      // em2: UserB만
      const createdTablesDb2: string[] = [];
      const mockDriver2 = {
        hasTable: jest.fn().mockResolvedValue([]),
        createTable: jest.fn().mockImplementation((name: string) => {
          createdTablesDb2.push(name);
          return Promise.resolve();
        }),
        castType: jest.fn().mockReturnValue("INT"),
        getIndexes: jest.fn().mockResolvedValue([]),
        hasForeignKey: jest.fn().mockResolvedValue(false),
        executeRaw: jest.fn().mockResolvedValue(undefined),
        hasColumn: jest.fn().mockResolvedValue(true),
      };

      const em2 = new EntityManager();
      await em2.connect(
        { ...BASE_OPTIONS, type: "mysql", port: 3306, synchronize: true, entities: [UserB] },
        "db2",
      );
      (em2 as any).driver = mockDriver2;
      await (em2 as any).schemaRegistrar.registerEntities();

      expect(createdTablesDb2).toEqual(["user_b"]);
    });
  });
});
