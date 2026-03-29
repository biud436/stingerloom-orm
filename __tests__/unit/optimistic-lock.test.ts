import "reflect-metadata";
import { getScannerInstance } from "../../src/scanner/ScannerContainer";
import { EntityManager } from "../../src/core/EntityManager";
import { Entity } from "../../src/decorators/Entity";
import { Column, COLUMN_TOKEN } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { Version, VERSION_TOKEN } from "../../src/decorators/Version";
import { OptimisticLockError } from "../../src/errors/OptimisticLockError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";
import { SchemaGenerator } from "../../src/core/generators/SchemaGenerator";
import { MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";

// ─────────────────────────────────────────────────
// Mock 모듈 설정
// ─────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────
// Test entities
// ─────────────────────────────────────────────────

@Entity()
class VersionedUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  name!: string;

  @Version()
  version!: number;
}

@Entity()
class PlainUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  name!: string;
}

// ─────────────────────────────────────────────────
// Helper: 엔티티 메타데이터 기반 EntityManager 생성
// ─────────────────────────────────────────────────

function createMySqlEntityManager(
  entityMetadata: any,
  resolveEntityFn?: (em: any) => void,
) {
  const em = new EntityManager();
  (em as any).driver = {
    wrap: (name: string) => `\`${name}\``,
  };
  // resolveEntityMetadata를 직접 오버라이드
  (em as any).resolveEntityMetadata = jest.fn().mockReturnValue(entityMetadata);
  // resolveManyToOneMetadata 빈 배열 반환
  (em as any).resolveManyToOneMetadata = jest.fn().mockReturnValue([]);
  // cascadeSaveManyToOne, cascadeSaveOneToMany 스텁
  (em as any).cascadeSaveManyToOne = jest.fn().mockResolvedValue(undefined);
  (em as any).cascadeSaveOneToMany = jest.fn().mockResolvedValue(undefined);
  // isMySqlFamily / isPostgres
  (em as any).isMySqlFamily = jest.fn().mockReturnValue(true);
  (em as any).isPostgres = jest.fn().mockReturnValue(false);
  // wrap
  (em as any).wrap = (name: string) => `\`${name}\``;
  // EventEmitter / Subscriber / hooks / tracker / validator 스텁
  (em as any).eventEmitter = {
    emit: jest.fn().mockResolvedValue(undefined),
  };
  (em as any).notifySubscribers = jest.fn().mockResolvedValue(undefined);
  (em as any).runHooks = jest.fn().mockResolvedValue(undefined);
  (em as any).beginTrackQuery = jest.fn();
  (em as any).trackQuery = jest.fn();
  // findOne 스텁 (save 후 반환값)
  (em as any).findOne = jest.fn().mockResolvedValue({ id: 1, name: "test", version: 2 });
  // dbType
  (em as any).dbType = "mysql";

  if (resolveEntityFn) {
    resolveEntityFn(em);
  }

  return em;
}

function createPostgresEntityManager(entityMetadata: any) {
  const em = createMySqlEntityManager(entityMetadata);
  (em as any).isMySqlFamily = jest.fn().mockReturnValue(false);
  (em as any).isPostgres = jest.fn().mockReturnValue(true);
  (em as any).wrap = (name: string) => `"${name}"`;
  (em as any).dbType = "postgres";
  return em;
}

const versionedUserMetadata = {
  name: "VersionedUser",
  target: VersionedUser,
  columns: [
    { name: "id", options: { primary: true, autoIncrement: true } },
    { name: "name", options: {} },
    { name: "version", options: { type: "int", nullable: false, length: 11 } },
  ],
};

const plainUserMetadata = {
  name: "PlainUser",
  target: PlainUser,
  columns: [
    { name: "id", options: { primary: true, autoIncrement: true } },
    { name: "name", options: {} },
  ],
};

// ─────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────

describe("Optimistic Locking (@Version)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // MySQL INSERT 기본 응답
    mockQuery.mockResolvedValue({
      results: { insertId: 1, affectedRows: 1 },
      fields: {},
    });
  });

  // ─────────────────────────────────────────────────
  // 1. 데코레이터 메타데이터 테스트
  // ─────────────────────────────────────────────────

  describe("@Version 데코레이터 메타데이터", () => {
    it("VERSION_TOKEN에 컬럼 이름(propertyKey)을 저장해야 함", () => {
      const column = Reflect.getMetadata(VERSION_TOKEN, VersionedUser);
      expect(column).toBe("version");
    });

    it("COLUMN_TOKEN에 int 컬럼으로 등록되어야 함", () => {
      const columns =
        Reflect.getMetadata(COLUMN_TOKEN, VersionedUser.prototype) ?? [];
      const versionCol = columns.find((c: any) => c.name === "version");
      expect(versionCol).toBeDefined();
      expect(versionCol.options.type).toBe("int");
      expect(versionCol.options.nullable).toBe(false);
    });

    it("@Version이 없는 엔티티에는 VERSION_TOKEN이 없어야 함", () => {
      const column = Reflect.getMetadata(VERSION_TOKEN, PlainUser);
      expect(column).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────
  // 2. DDL 생성 테스트
  // ─────────────────────────────────────────────────

  describe("DDL 생성", () => {
    it("MySQL: version 컬럼이 INT NOT NULL로 생성되어야 함", () => {
      const gen = new SchemaGenerator({ dialect: "mysql" });
      const ddl = gen.generateCreateTableDDL(VersionedUser);
      expect(ddl).toMatch(/`version`\s+INT(\(\d+\))?\s+NOT NULL/);
    });

    it("PostgreSQL: version 컬럼이 INTEGER NOT NULL로 생성되어야 함", () => {
      const gen = new SchemaGenerator({ dialect: "postgres" });
      const ddl = gen.generateCreateTableDDL(VersionedUser);
      expect(ddl).toMatch(/"version"\s+INTEGER(\(\d+\))?\s+NOT NULL/);
    });
  });

  // ─────────────────────────────────────────────────
  // 3. INSERT 시 version = 1 자동 설정
  // ─────────────────────────────────────────────────

  describe("INSERT 시 version 자동 초기화", () => {
    it("MySQL: INSERT 시 version이 1로 자동 설정되어야 함", async () => {
      const em = createMySqlEntityManager(versionedUserMetadata);

      await em.save(VersionedUser, { name: "Alice" });

      // query가 호출된 SQL을 검증 (SET autocommit 제외)
      const insertCall = mockQuery.mock.calls.find(
        (call: any) => {
          const sqlText = typeof call[0] === "string" ? call[0] : call[0]?.text ?? "";
          return sqlText.includes("INSERT INTO");
        },
      );

      expect(insertCall).toBeDefined();
      const sqlObj = insertCall![0];
      const sqlText = typeof sqlObj === "string" ? sqlObj : sqlObj?.text ?? "";

      // INSERT SQL에 version 컬럼이 포함되어야 함
      expect(sqlText).toMatch(/`version`/);

      // values 배열에서 version이 1로 설정되었는지 확인
      const sqlValues = sqlObj?.values ?? [];
      // name = 'Alice', version = 1
      expect(sqlValues).toContain(1);
    });

    it("MySQL: 사용자가 version 값을 명시해도 1로 오버라이드되어야 함", async () => {
      const em = createMySqlEntityManager(versionedUserMetadata);

      await em.save(VersionedUser, { name: "Bob", version: 99 } as any);

      const insertCall = mockQuery.mock.calls.find(
        (call: any) => {
          const sqlText = typeof call[0] === "string" ? call[0] : call[0]?.text ?? "";
          return sqlText.includes("INSERT INTO");
        },
      );

      expect(insertCall).toBeDefined();
      const sqlValues = insertCall![0]?.values ?? [];
      // version은 항상 1이어야 함 (사용자 값 무시)
      expect(sqlValues).toContain(1);
      expect(sqlValues).not.toContain(99);
    });
  });

  // ─────────────────────────────────────────────────
  // 4. UPDATE 시 version WHERE 조건 + version 증가
  // ─────────────────────────────────────────────────

  describe("UPDATE 시 Optimistic Locking", () => {
    it("MySQL: UPDATE SQL에 version WHERE 조건과 version + 1이 포함되어야 함", async () => {
      // UPDATE 응답: affectedRows = 1 (성공)
      mockQuery.mockResolvedValue({
        results: { affectedRows: 1 },
        fields: {},
      });

      const em = createMySqlEntityManager(versionedUserMetadata);

      await em.save(VersionedUser, { id: 1, name: "Alice Updated", version: 3 } as any);

      // SET autocommit=0, UPDATE 두 번의 query 호출 중 UPDATE를 찾음
      const updateCall = mockQuery.mock.calls.find(
        (call: any) => {
          const sqlText = typeof call[0] === "string" ? call[0] : call[0]?.text ?? "";
          return sqlText.includes("UPDATE");
        },
      );

      expect(updateCall).toBeDefined();
      const sqlObj = updateCall![0];
      const sqlText = typeof sqlObj === "string" ? sqlObj : sqlObj?.text ?? "";

      // SET 절에 version = version + 1 포함 확인
      expect(sqlText).toMatch(/`version`\s*=\s*`version`\s*\+\s*1/);

      // WHERE 절에 version = ? 포함 확인
      expect(sqlText).toMatch(/WHERE/i);
      expect(sqlText).toMatch(/`id`\s*=/);
      expect(sqlText).toMatch(/`version`\s*=/);

      // 파라미터에 currentVersion(3)이 포함되어야 함
      const sqlValues = sqlObj?.values ?? [];
      expect(sqlValues).toContain(3);
    });

    it("PostgreSQL: UPDATE SQL에 version WHERE 조건과 version + 1이 포함되어야 함", async () => {
      mockQuery.mockResolvedValue({
        results: [],
        fields: {},
        rowCount: 1,
      });

      const em = createPostgresEntityManager(versionedUserMetadata);

      await em.save(VersionedUser, { id: 1, name: "Alice Updated", version: 5 } as any);

      const updateCall = mockQuery.mock.calls.find(
        (call: any) => {
          const sqlText = typeof call[0] === "string" ? call[0] : call[0]?.text ?? "";
          return sqlText.includes("UPDATE");
        },
      );

      expect(updateCall).toBeDefined();
      const sqlObj = updateCall![0];
      const sqlText = typeof sqlObj === "string" ? sqlObj : sqlObj?.text ?? "";

      // PostgreSQL 식별자: "version"
      expect(sqlText).toMatch(/"version"\s*=\s*"version"\s*\+\s*1/);
      expect(sqlText).toMatch(/"version"\s*=/);

      // 파라미터에 currentVersion(5)이 포함
      const sqlValues = sqlObj?.values ?? [];
      expect(sqlValues).toContain(5);
    });
  });

  // ─────────────────────────────────────────────────
  // 5. 동시 수정 감지 — OptimisticLockError
  // ─────────────────────────────────────────────────

  describe("동시 수정 감지 (OptimisticLockError)", () => {
    it("MySQL: affectedRows === 0이면 OptimisticLockError를 throw해야 함", async () => {
      // 다른 트랜잭션이 먼저 수정하여 version이 바뀐 경우
      mockQuery.mockResolvedValue({
        results: { affectedRows: 0 },
        fields: {},
      });

      const em = createMySqlEntityManager(versionedUserMetadata);

      await expect(
        em.save(VersionedUser, { id: 1, name: "Conflict", version: 3 } as any),
      ).rejects.toThrow(OptimisticLockError);

      await expect(
        em.save(VersionedUser, { id: 1, name: "Conflict", version: 3 } as any),
      ).rejects.toThrow(/Optimistic lock failed/);
    });

    it("PostgreSQL: rowCount === 0이면 OptimisticLockError를 throw해야 함", async () => {
      mockQuery.mockResolvedValue({
        results: [],
        fields: {},
        rowCount: 0,
      });

      const em = createPostgresEntityManager(versionedUserMetadata);

      await expect(
        em.save(VersionedUser, { id: 1, name: "Conflict", version: 5 } as any),
      ).rejects.toThrow(OptimisticLockError);
    });

    it("OptimisticLockError의 코드가 OPTIMISTIC_LOCK_FAILED이어야 함", async () => {
      mockQuery.mockResolvedValue({
        results: { affectedRows: 0 },
        fields: {},
      });

      const em = createMySqlEntityManager(versionedUserMetadata);

      try {
        await em.save(VersionedUser, { id: 1, name: "Conflict", version: 2 } as any);
        fail("Should have thrown OptimisticLockError");
      } catch (e: any) {
        expect(e).toBeInstanceOf(OptimisticLockError);
        expect(e.code).toBe(OrmErrorCode.OPTIMISTIC_LOCK_FAILED);
        expect(e.message).toContain("expected version 2");
        expect(e.message).toContain("VersionedUser");
      }
    });

    it("UPDATE 실패 시 rollback이 호출되어야 함", async () => {
      mockQuery.mockResolvedValue({
        results: { affectedRows: 0 },
        fields: {},
      });

      const em = createMySqlEntityManager(versionedUserMetadata);

      await expect(
        em.save(VersionedUser, { id: 1, name: "Conflict", version: 3 } as any),
      ).rejects.toThrow(OptimisticLockError);

      expect(mockRollback).toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────
  // 6. version 컬럼이 없는 엔티티는 영향 없음
  // ─────────────────────────────────────────────────

  describe("@Version 없는 엔티티", () => {
    it("INSERT: version 관련 로직이 적용되지 않아야 함", async () => {
      mockQuery.mockResolvedValue({
        results: { insertId: 1, affectedRows: 1 },
        fields: {},
      });

      const em = createMySqlEntityManager(plainUserMetadata);

      await em.save(PlainUser, { name: "Charlie" });

      const insertCall = mockQuery.mock.calls.find(
        (call: any) => {
          const sqlText = typeof call[0] === "string" ? call[0] : call[0]?.text ?? "";
          return sqlText.includes("INSERT INTO");
        },
      );

      expect(insertCall).toBeDefined();
      const sqlText =
        typeof insertCall![0] === "string"
          ? insertCall![0]
          : insertCall![0]?.text ?? "";

      // version 컬럼이 없으므로 SQL에 version이 없어야 함
      expect(sqlText).not.toMatch(/version/i);
    });

    it("UPDATE: version WHERE 조건 없이 일반 UPDATE를 수행해야 함", async () => {
      mockQuery.mockResolvedValue({
        results: { affectedRows: 1 },
        fields: {},
      });

      const em = createMySqlEntityManager(plainUserMetadata);

      await em.save(PlainUser, { id: 1, name: "Charlie Updated" } as any);

      const updateCall = mockQuery.mock.calls.find(
        (call: any) => {
          const sqlText = typeof call[0] === "string" ? call[0] : call[0]?.text ?? "";
          return sqlText.includes("UPDATE");
        },
      );

      expect(updateCall).toBeDefined();
      const sqlText =
        typeof updateCall![0] === "string"
          ? updateCall![0]
          : updateCall![0]?.text ?? "";

      // version 관련 절이 없어야 함
      expect(sqlText).not.toMatch(/version/i);
    });

    it("UPDATE: affectedRows === 0이어도 OptimisticLockError를 throw하지 않아야 함", async () => {
      mockQuery.mockResolvedValue({
        results: { affectedRows: 0 },
        fields: {},
      });

      const em = createMySqlEntityManager(plainUserMetadata);

      // @Version이 없으므로 affectedRows === 0이어도 에러 없이 통과
      await expect(
        em.save(PlainUser, { id: 1, name: "No version" } as any),
      ).resolves.toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────
  // 7. UPDATE 성공 시 정상 동작
  // ─────────────────────────────────────────────────

  describe("UPDATE 성공 시", () => {
    it("MySQL: affectedRows === 1이면 정상적으로 반환되어야 함", async () => {
      mockQuery.mockResolvedValue({
        results: { affectedRows: 1 },
        fields: {},
      });

      const em = createMySqlEntityManager(versionedUserMetadata);
      (em as any).findOne = jest
        .fn()
        .mockResolvedValue({ id: 1, name: "Alice Updated", version: 4 });

      const result = await em.save(VersionedUser, {
        id: 1,
        name: "Alice Updated",
        version: 3,
      } as any);

      expect(result).toBeDefined();
      expect(mockCommit).toHaveBeenCalled();
      expect(mockRollback).not.toHaveBeenCalled();
    });

    it("PostgreSQL: rowCount === 1이면 정상적으로 반환되어야 함", async () => {
      mockQuery.mockResolvedValue({
        results: [],
        fields: {},
        rowCount: 1,
      });

      const em = createPostgresEntityManager(versionedUserMetadata);
      (em as any).findOne = jest
        .fn()
        .mockResolvedValue({ id: 1, name: "Alice Updated", version: 6 });

      const result = await em.save(VersionedUser, {
        id: 1,
        name: "Alice Updated",
        version: 5,
      } as any);

      expect(result).toBeDefined();
      expect(mockCommit).toHaveBeenCalled();
      expect(mockRollback).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────
  // 8. version이 undefined/null인 경우 (version 없이 UPDATE)
  // ─────────────────────────────────────────────────

  describe("version 값이 없는 UPDATE", () => {
    it("version이 undefined인 경우 version WHERE 조건을 추가하지 않아야 함", async () => {
      mockQuery.mockResolvedValue({
        results: { affectedRows: 1 },
        fields: {},
      });

      const em = createMySqlEntityManager(versionedUserMetadata);

      // version을 전달하지 않은 경우에도 version+1은 SET에 포함됨
      await em.save(VersionedUser, { id: 1, name: "No Version Passed" } as any);

      const updateCall = mockQuery.mock.calls.find(
        (call: any) => {
          const sqlText = typeof call[0] === "string" ? call[0] : call[0]?.text ?? "";
          return sqlText.includes("UPDATE");
        },
      );

      expect(updateCall).toBeDefined();
      const sqlText =
        typeof updateCall![0] === "string"
          ? updateCall![0]
          : updateCall![0]?.text ?? "";

      // SET 절에 version + 1은 있어야 함 (항상 증가)
      expect(sqlText).toMatch(/`version`\s*=\s*`version`\s*\+\s*1/);
    });
  });

  // ─────────────────────────────────────────────────
  // 9. OptimisticLockError 클래스 검증
  // ─────────────────────────────────────────────────

  describe("OptimisticLockError 클래스", () => {
    it("OrmError를 상속해야 함", () => {
      const error = new OptimisticLockError("TestEntity", 5);
      expect(error.name).toBe("OptimisticLockError");
      expect(error.code).toBe(OrmErrorCode.OPTIMISTIC_LOCK_FAILED);
      expect(error.message).toContain("TestEntity");
      expect(error.message).toContain("expected version 5");
    });

    it("Error 체인을 유지해야 함", () => {
      const error = new OptimisticLockError("User", 1);
      expect(error instanceof Error).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────
  // 10. OrmErrorCode 열거형 검증
  // ─────────────────────────────────────────────────

  describe("OrmErrorCode", () => {
    it("OPTIMISTIC_LOCK_FAILED 코드가 존재해야 함", () => {
      expect(OrmErrorCode.OPTIMISTIC_LOCK_FAILED).toBe(
        "ORM_OPTIMISTIC_LOCK_FAILED",
      );
    });
  });
});
