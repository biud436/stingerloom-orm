/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import Container from "typedi";
import { EntityManager } from "../../src/core/EntityManager";
import { TransactionSessionManager } from "../../src/dialects/TransactionSessionManager";
import { MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";

/**
 * Connection reuse tests (GitHub Issue #30).
 *
 * 하나의 공개 메서드 호출 내에서 TransactionSessionManager가 1개만 생성되는지 검증합니다.
 * - find() + relation loading → 1 session
 * - saveMany() → 1 session
 * - save() (INSERT) + findOneInternal re-read → same session
 * - findAndCount() → 1 session
 * - 에러 시 rollback 동작 검증
 */

// Mock DatabaseClient
jest.mock("../../src/DatabaseClient", () => ({
  DatabaseClient: {
    getInstance: jest.fn().mockReturnValue({
      type: "mysql",
      getConnection: jest.fn(),
      getOptions: jest.fn().mockReturnValue({ synchronize: false }),
      connect: jest.fn(),
    }),
  },
}));

// Mock TransactionSessionManager — 인스턴스 생성 횟수를 추적합니다.
const mockQuery = jest.fn();
const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockStartTransaction = jest.fn().mockResolvedValue(undefined);
const mockCommit = jest.fn().mockResolvedValue(undefined);
const mockRollback = jest.fn().mockResolvedValue(undefined);
const mockClose = jest.fn().mockResolvedValue(undefined);

let sessionInstanceCount = 0;

jest.mock("../../src/dialects/TransactionSessionManager", () => {
  return {
    TransactionSessionManager: jest.fn().mockImplementation(() => {
      sessionInstanceCount++;
      return {
        connect: mockConnect,
        startTransaction: mockStartTransaction,
        query: mockQuery,
        commit: mockCommit,
        rollback: mockRollback,
        close: mockClose,
      };
    }),
  };
});

// 테스트용 엔티티 및 메타데이터
class User {
  id!: number;
  name!: string;
  email!: string;
}

class Post {
  id!: number;
  title!: string;
  userId!: number;
}

const userMetadata = {
  name: "User",
  target: User,
  columns: [
    { name: "id", options: { primary: true, autoIncrement: true } },
    { name: "name", options: {} },
    { name: "email", options: {} },
  ],
};

const postMetadata = {
  name: "Post",
  target: Post,
  columns: [
    { name: "id", options: { primary: true, autoIncrement: true } },
    { name: "title", options: {} },
    { name: "userId", options: {} },
  ],
};

function createTestEntityManager() {
  const em = new EntityManager();

  (em as any).driver = {
    wrap: (name: string) => `\`${name}\``,
    supportsExplain: () => false,
  };

  jest.spyOn((em as any).resolver, "resolveEntityMetadata").mockImplementation(
    (entity: any) => {
      if (entity === User) return userMetadata;
      if (entity === Post) return postMetadata;
      return null;
    },
  );

  jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);
  jest.spyOn(em as any, "isPostgres").mockReturnValue(false);
  jest.spyOn(em as any, "wrap").mockImplementation(
    (...args: any[]) => `\`${args[0]}\``,
  );
  jest.spyOn((em as any).resolver, "resolveOneToOneMetadata").mockReturnValue([]);
  jest.spyOn((em as any).resolver, "resolveManyToOneMetadata").mockReturnValue([]);
  jest.spyOn((em as any).resolver, "resolveOneToManyMetadata").mockReturnValue([]);
  jest.spyOn((em as any).cascadeHandler, "runHooks").mockResolvedValue(undefined);
  jest.spyOn((em as any).cascadeHandler, "cascadeSaveOneToMany").mockResolvedValue(undefined);
  jest.spyOn((em as any).cascadeHandler, "cascadeSaveManyToOne").mockResolvedValue(undefined);
  jest.spyOn((em as any).resolver, "getDeletedAtColumn").mockReturnValue(null);
  jest.spyOn((em as any).resolver, "getCreateTimestampColumn").mockReturnValue(null);
  jest.spyOn((em as any).resolver, "getUpdateTimestampColumn").mockReturnValue(null);
  return em;
}

describe("Connection Reuse (Issue #30)", () => {
  let em: EntityManager;

  beforeEach(() => {
    MetadataLayerRegistry.reset();
    Container.reset();
    // mockQuery의 once-queue를 확실히 비우기 위해 mockReset 사용
    mockQuery.mockReset();
    mockConnect.mockReset().mockResolvedValue(undefined);
    mockStartTransaction.mockReset().mockResolvedValue(undefined);
    mockCommit.mockReset().mockResolvedValue(undefined);
    mockRollback.mockReset().mockResolvedValue(undefined);
    mockClose.mockReset().mockResolvedValue(undefined);
    sessionInstanceCount = 0;
    em = createTestEntityManager();
  });

  describe("find() with relation loading", () => {
    it("should use exactly 1 TransactionSessionManager when loading relations", async () => {
      // OneToMany 관계 메타데이터 설정
      jest.spyOn((em as any).resolver, "resolveOneToManyMetadata").mockReturnValue([
        {
          propertyName: "posts",
          getMappingEntity: () => Post,
          joinColumn: "userId",
        },
      ]);

      // 메인 쿼리 (SET autocommit + SELECT users)
      mockQuery
        .mockResolvedValueOnce(undefined) // SET autocommit = 0
        .mockResolvedValueOnce({
          results: [{ id: 1, name: "Alice", email: "alice@test.com" }],
          fields: [],
        }) // SELECT users
        .mockResolvedValueOnce({
          results: [
            { id: 10, title: "Post 1", userId: 1 },
            { id: 11, title: "Post 2", userId: 1 },
          ],
          fields: [],
        }); // SELECT posts (relation loading)

      await em.find(User, { relations: ["posts"] });

      // 커넥션이 1개만 생성되어야 합니다
      expect(sessionInstanceCount).toBe(1);
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockStartTransaction).toHaveBeenCalledTimes(1);
      expect(mockCommit).toHaveBeenCalledTimes(1);
      expect(mockClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("saveMany()", () => {
    it("should use exactly 1 TransactionSessionManager for multiple saves", async () => {
      // 각 saveInternal 호출에 대해 INSERT + findOneInternal SELECT 쿼리 mock
      mockQuery
        .mockResolvedValueOnce(undefined) // SET autocommit = 0
        // 첫 번째 save: INSERT
        .mockResolvedValueOnce({
          results: { insertId: 1, affectedRows: 1 },
          fields: [],
        })
        // 첫 번째 save: findOneInternal → findInternal SELECT
        .mockResolvedValueOnce({
          results: [{ id: 1, name: "Alice", email: "a@test.com" }],
          fields: [],
        })
        // 두 번째 save: INSERT
        .mockResolvedValueOnce({
          results: { insertId: 2, affectedRows: 1 },
          fields: [],
        })
        // 두 번째 save: findOneInternal → findInternal SELECT
        .mockResolvedValueOnce({
          results: [{ id: 2, name: "Bob", email: "b@test.com" }],
          fields: [],
        })
        // 세 번째 save: INSERT
        .mockResolvedValueOnce({
          results: { insertId: 3, affectedRows: 1 },
          fields: [],
        })
        // 세 번째 save: findOneInternal → findInternal SELECT
        .mockResolvedValueOnce({
          results: [{ id: 3, name: "Charlie", email: "c@test.com" }],
          fields: [],
        });

      const result = await em.saveMany(User, [
        { name: "Alice", email: "a@test.com" },
        { name: "Bob", email: "b@test.com" },
        { name: "Charlie", email: "c@test.com" },
      ]);

      // 1개의 세션만 생성되어야 합니다 (3개 아님!)
      expect(sessionInstanceCount).toBe(1);
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockStartTransaction).toHaveBeenCalledTimes(1);
      expect(mockCommit).toHaveBeenCalledTimes(1);
      expect(mockClose).toHaveBeenCalledTimes(1);

      expect(result).toHaveLength(3);
    });
  });

  describe("save() INSERT with findOneInternal re-read", () => {
    it("should use same session for INSERT and re-read findOneInternal", async () => {
      mockQuery
        .mockResolvedValueOnce(undefined) // SET autocommit = 0
        .mockResolvedValueOnce({
          results: { insertId: 1, affectedRows: 1 },
          fields: [],
        }) // INSERT
        .mockResolvedValueOnce({
          results: [{ id: 1, name: "Alice", email: "alice@test.com" }],
          fields: [],
        }); // findOneInternal → findInternal SELECT

      const result = await em.save(User, {
        name: "Alice",
        email: "alice@test.com",
      });

      // save()는 1개의 세션으로 INSERT + 재조회를 모두 수행해야 합니다
      expect(sessionInstanceCount).toBe(1);
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockStartTransaction).toHaveBeenCalledTimes(1);
      expect(mockCommit).toHaveBeenCalledTimes(1);
      expect(mockClose).toHaveBeenCalledTimes(1);

      // INSERT + SELECT 쿼리가 모두 실행되어야 합니다
      // SET autocommit(1) + INSERT(1) + SELECT(1) = 3
      expect(mockQuery).toHaveBeenCalledTimes(3);
    });
  });

  describe("findAndCount()", () => {
    it("should use exactly 1 TransactionSessionManager for find + count", async () => {
      mockQuery
        .mockResolvedValueOnce(undefined) // SET autocommit = 0
        .mockResolvedValueOnce({
          results: [
            { id: 1, name: "Alice", email: "alice@test.com" },
            { id: 2, name: "Bob", email: "bob@test.com" },
          ],
          fields: [],
        }) // SELECT (find)
        .mockResolvedValueOnce({
          results: [{ result: 10 }],
          fields: [],
        }); // SELECT COUNT (aggregate)

      const [entities, count] = await em.findAndCount(User);

      // 1개의 세션으로 find + count를 모두 실행해야 합니다
      expect(sessionInstanceCount).toBe(1);
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockStartTransaction).toHaveBeenCalledTimes(1);
      expect(mockCommit).toHaveBeenCalledTimes(1);
      expect(mockClose).toHaveBeenCalledTimes(1);

      expect(entities).toHaveLength(2);
      expect(count).toBe(10);
    });
  });

  describe("error rollback", () => {
    it("should rollback and close when an error occurs", async () => {
      mockQuery
        .mockResolvedValueOnce(undefined) // SET autocommit = 0
        .mockRejectedValueOnce(new Error("Query failed")); // SELECT throws

      await expect(em.find(User, {})).rejects.toThrow("Query failed");

      // 에러 발생 시 rollback과 close가 호출되어야 합니다
      expect(sessionInstanceCount).toBe(1);
      expect(mockRollback).toHaveBeenCalledTimes(1);
      expect(mockClose).toHaveBeenCalledTimes(1);
      // commit은 호출되지 않아야 합니다
      expect(mockCommit).not.toHaveBeenCalled();
    });

    it("should rollback on saveMany error without leaking connections", async () => {
      mockQuery
        .mockResolvedValueOnce(undefined) // SET autocommit = 0
        // 첫 번째 save 성공
        .mockResolvedValueOnce({
          results: { insertId: 1, affectedRows: 1 },
          fields: [],
        })
        .mockResolvedValueOnce({
          results: [{ id: 1, name: "Ok" }],
          fields: [],
        })
        // 두 번째 save 실패
        .mockRejectedValueOnce(new Error("Constraint violation"));

      await expect(
        em.saveMany(User, [{ name: "Ok" }, { name: "Fail" }]),
      ).rejects.toThrow("Constraint violation");

      // 1개의 세션만 생성, rollback + close 호출됨
      expect(sessionInstanceCount).toBe(1);
      expect(mockRollback).toHaveBeenCalledTimes(1);
      expect(mockClose).toHaveBeenCalledTimes(1);
      expect(mockCommit).not.toHaveBeenCalled();
    });
  });

  describe("executeInTransaction session reuse", () => {
    it("should not create new session when existingSession is provided", async () => {
      const existingSession = {
        query: jest.fn().mockResolvedValue({
          results: [{ id: 1, name: "Alice" }],
          fields: [],
        }),
        connect: jest.fn(),
        startTransaction: jest.fn(),
        commit: jest.fn(),
        rollback: jest.fn(),
        close: jest.fn(),
      };

      // findInternal을 직접 호출하여 existingSession 전달 테스트
      const result = await (em as any).findInternal(User, {}, existingSession);

      // 새 세션이 생성되지 않아야 합니다
      expect(sessionInstanceCount).toBe(0);
      // 기존 세션의 commit/rollback/close가 호출되지 않아야 합니다
      expect(existingSession.commit).not.toHaveBeenCalled();
      expect(existingSession.rollback).not.toHaveBeenCalled();
      expect(existingSession.close).not.toHaveBeenCalled();
    });
  });

  describe("delete()", () => {
    it("should use exactly 1 TransactionSessionManager", async () => {
      mockQuery
        .mockResolvedValueOnce(undefined) // SET autocommit = 0
        .mockResolvedValueOnce({
          results: { affectedRows: 1 },
          fields: [],
        }); // DELETE

      await em.delete(User, { id: 1 } as any);

      expect(sessionInstanceCount).toBe(1);
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockCommit).toHaveBeenCalledTimes(1);
      expect(mockClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("insertMany()", () => {
    it("should use exactly 1 TransactionSessionManager", async () => {
      mockQuery
        .mockResolvedValueOnce(undefined) // SET autocommit = 0
        .mockResolvedValueOnce({
          results: { affectedRows: 3 },
          fields: [],
        }); // INSERT

      const result = await em.insertMany(User, [
        { name: "A", email: "a@test.com" },
        { name: "B", email: "b@test.com" },
        { name: "C", email: "c@test.com" },
      ]);

      expect(sessionInstanceCount).toBe(1);
      expect(result.affected).toBe(3);
    });
  });

  describe("deleteMany()", () => {
    it("should use exactly 1 TransactionSessionManager", async () => {
      mockQuery
        .mockResolvedValueOnce(undefined) // SET autocommit = 0
        .mockResolvedValueOnce({
          results: { affectedRows: 3 },
          fields: [],
        }); // DELETE

      const result = await em.deleteMany(User, [1, 2, 3]);

      expect(sessionInstanceCount).toBe(1);
      expect(result.affected).toBe(3);
    });
  });

  describe("@Transactional integration", () => {
    it("should reuse session from transactionStorage when @Transactional is active", async () => {
      // @Transactional이 AsyncLocalStorage에 저장하는 세션을 시뮬레이션
      const { transactionStorage } = require("../../src/decorators/Transactional");
      const externalSession = {
        query: jest.fn().mockResolvedValue({
          results: [{ id: 1, name: "Alice", email: "alice@test.com" }],
          fields: [],
        }),
        connect: jest.fn(),
        connectToNode: jest.fn(),
        startTransaction: jest.fn(),
        commit: jest.fn(),
        rollback: jest.fn(),
        close: jest.fn(),
      };

      // transactionStorage.run()으로 세션을 AsyncLocalStorage에 저장한 상태에서 find() 호출
      await transactionStorage.run(externalSession, async () => {
        await em.find(User, {});
      });

      // 새 TransactionSessionManager가 생성되지 않아야 합니다
      expect(sessionInstanceCount).toBe(0);
      // @Transactional의 세션으로 쿼리가 실행되어야 합니다
      expect(externalSession.query).toHaveBeenCalled();
      // 세션의 라이프사이클은 @Transactional이 관리하므로 commit/close 호출 안 됨
      expect(externalSession.commit).not.toHaveBeenCalled();
      expect(externalSession.close).not.toHaveBeenCalled();
    });

    it("should reuse @Transactional session across multiple EntityManager calls", async () => {
      const { transactionStorage } = require("../../src/decorators/Transactional");
      const externalSession = {
        query: jest.fn()
          // 첫 번째 save: INSERT
          .mockResolvedValueOnce({
            results: { insertId: 1, affectedRows: 1 },
            fields: [],
          })
          // 첫 번째 save: findOneInternal re-read
          .mockResolvedValueOnce({
            results: [{ id: 1, name: "Alice", email: "a@test.com" }],
            fields: [],
          })
          // 두 번째 save: INSERT
          .mockResolvedValueOnce({
            results: { insertId: 2, affectedRows: 1 },
            fields: [],
          })
          // 두 번째 save: findOneInternal re-read
          .mockResolvedValueOnce({
            results: [{ id: 2, name: "Bob", email: "b@test.com" }],
            fields: [],
          }),
        connect: jest.fn(),
        connectToNode: jest.fn(),
        startTransaction: jest.fn(),
        commit: jest.fn(),
        rollback: jest.fn(),
        close: jest.fn(),
      };

      await transactionStorage.run(externalSession, async () => {
        await em.save(User, { name: "Alice", email: "a@test.com" });
        await em.save(User, { name: "Bob", email: "b@test.com" });
      });

      // 새 세션이 생성되지 않고 @Transactional 세션을 재사용
      expect(sessionInstanceCount).toBe(0);
      expect(externalSession.query).toHaveBeenCalledTimes(4); // INSERT + SELECT × 2
      expect(externalSession.commit).not.toHaveBeenCalled();
      expect(externalSession.close).not.toHaveBeenCalled();
    });

    it("should create new session when no @Transactional and no existingSession", async () => {
      // transactionStorage에 아무것도 없는 상태
      mockQuery
        .mockResolvedValueOnce(undefined) // SET autocommit = 0
        .mockResolvedValueOnce({
          results: [{ id: 1, name: "Alice" }],
          fields: [],
        });

      await em.find(User, {});

      // @Transactional이 없으므로 새 세션이 생성되어야 합니다
      expect(sessionInstanceCount).toBe(1);
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockCommit).toHaveBeenCalledTimes(1);
      expect(mockClose).toHaveBeenCalledTimes(1);
    });
  });
});
