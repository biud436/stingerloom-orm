/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { DeletedAt } from "../../src/decorators/DeletedAt";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";

// ─── Mocks (mirror soft-delete.test.ts) ─────────────────────
// We mock TransactionSessionManager + DatabaseClient so we can assert the SQL
// that count()/sum()/avg()/min()/max()/exists() emit when onlyDeleted is set.

const mockQuery = jest.fn();
const mockCommit = jest.fn();
const mockRollback = jest.fn();
const mockClose = jest.fn();
const mockConnect = jest.fn();
const mockStartTransaction = jest.fn();

jest.mock("../../src/dialects/TransactionSessionManager", () => ({
  TransactionSessionManager: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    startTransaction: mockStartTransaction,
    query: mockQuery,
    commit: mockCommit,
    rollback: mockRollback,
    close: mockClose,
  })),
}));

const mockDbConnect = jest.fn().mockResolvedValue({ query: jest.fn() });
const mockDbClose = jest.fn();
const mockDbGetConnection = jest.fn();
const mockDbGetOptions = jest.fn().mockReturnValue({ synchronize: false });

jest.mock("../../src/DatabaseClient", () => ({
  DatabaseClient: {
    getInstance: () => ({
      connect: mockDbConnect,
      close: mockDbClose,
      getConnection: mockDbGetConnection,
      getOptions: mockDbGetOptions,
      type: "postgres",
    }),
  },
}));

// Import after mocks are set up
import { EntityManager } from "../../src/core/EntityManager";
import { AggregateQueryHandler } from "../../src/core/AggregateQueryHandler";

describe("Aggregate onlyDeleted (count the trash)", () => {
  let em: EntityManager;

  @Entity()
  class Article {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column()
    title!: string;

    @Column()
    views!: number;

    @DeletedAt()
    deletedAt!: Date | null;
  }

  @Entity()
  class Comment {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column()
    body!: string;
  }

  // Pull the aggregate SELECT text out of the mock query calls, mirroring the
  // extraction the soft-delete find() tests use.
  const aggregateSql = (): string => {
    const call = mockQuery.mock.calls.find((c: any[]) => {
      const sqlObj = c[0];
      const sqlText =
        typeof sqlObj === "string" ? sqlObj : sqlObj?.sql || sqlObj?.text || "";
      return sqlText.includes("SELECT");
    });
    expect(call).toBeDefined();
    const sqlObj = call![0];
    return sqlObj?.sql || sqlObj?.text || "";
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    em = new EntityManager();
    await em.connect({
      type: "postgres",
      host: "localhost",
      port: 5432,
      username: "test",
      password: "test",
      database: "testdb",
      entities: [],
    });
  });

  describe("count()", () => {
    it("count(Entity, where, false, true)는 deleted_at IS NOT NULL을 emit하고 IS NULL은 emit하지 않아야 함", async () => {
      mockQuery.mockResolvedValue({ results: [{ result: 3 }], fields: [] });

      const result = await em.count(Article, undefined, false, true);

      expect(result).toBe(3);
      const sqlText = aggregateSql();
      expect(sqlText).toMatch(/"deletedAt"\s+IS\s+NOT\s+NULL/);
      expect(sqlText).not.toMatch(/"deletedAt"\s+IS\s+NULL/);
    });

    it("onlyDeleted는 withDeleted보다 우선해야 함 (둘 다 true면 IS NOT NULL)", async () => {
      mockQuery.mockResolvedValue({ results: [{ result: 2 }], fields: [] });

      await em.count(Article, undefined, true, true);

      const sqlText = aggregateSql();
      expect(sqlText).toMatch(/"deletedAt"\s+IS\s+NOT\s+NULL/);
      expect(sqlText).not.toMatch(/"deletedAt"\s+IS\s+NULL/);
    });

    it("onlyDeleted는 사용자 where와 AND로 결합되어야 함", async () => {
      mockQuery.mockResolvedValue({ results: [{ result: 1 }], fields: [] });

      await em.count(Article, { title: "Trashed" } as any, false, true);

      const sqlText = aggregateSql();
      expect(sqlText).toMatch(/"title"/);
      expect(sqlText).toMatch(/"deletedAt"\s+IS\s+NOT\s+NULL/);
      expect(sqlText).toMatch(/AND/i);
    });

    it("회귀: 플래그 없으면 기존 동작(IS NULL)이 유지되어야 함", async () => {
      mockQuery.mockResolvedValue({ results: [{ result: 7 }], fields: [] });

      await em.count(Article);

      const sqlText = aggregateSql();
      expect(sqlText).toMatch(/"deletedAt"\s+IS\s+NULL/);
      expect(sqlText).not.toMatch(/IS\s+NOT\s+NULL/);
    });

    it("@DeletedAt 컬럼이 없는 엔티티에 onlyDeleted는 no-op이어야 함", async () => {
      mockQuery.mockResolvedValue({ results: [{ result: 1 }], fields: [] });

      await em.count(Comment, undefined, false, true);

      const sqlText = aggregateSql();
      expect(sqlText).not.toMatch(/IS\s+NOT\s+NULL/);
      expect(sqlText).not.toMatch(/IS\s+NULL/);
    });
  });

  describe("sum() / avg() / min() / max()", () => {
    it("sum(...,false,true)는 SUM과 deleted_at IS NOT NULL을 emit해야 함", async () => {
      mockQuery.mockResolvedValue({ results: [{ result: 100 }], fields: [] });

      await em.sum(Article, "views", undefined, false, true);

      const sqlText = aggregateSql();
      expect(sqlText).toMatch(/SUM/i);
      expect(sqlText).toMatch(/"deletedAt"\s+IS\s+NOT\s+NULL/);
      expect(sqlText).not.toMatch(/"deletedAt"\s+IS\s+NULL/);
    });

    it("회귀: sum에 플래그가 없으면 IS NULL이 유지되어야 함", async () => {
      mockQuery.mockResolvedValue({ results: [{ result: 100 }], fields: [] });

      await em.sum(Article, "views");

      const sqlText = aggregateSql();
      expect(sqlText).toMatch(/"deletedAt"\s+IS\s+NULL/);
      expect(sqlText).not.toMatch(/IS\s+NOT\s+NULL/);
    });

    it("avg/min/max는 onlyDeleted 플래그를 aggregate()로 그대로 전달해야 함", async () => {
      // aggregate(entity, fn, field, where?, existingSession?, withDeleted?, onlyDeleted?)
      // → onlyDeleted is the 7th positional arg (index 6).
      const spy = jest
        .spyOn(AggregateQueryHandler.prototype, "aggregate")
        .mockResolvedValue(0);

      try {
        await em.avg(Article, "views", undefined, false, true);
        await em.min(Article, "views", { title: "x" } as any, false, true);
        await em.max(Article, "views", undefined, true, true);

        expect(spy.mock.calls.map((c) => c[1])).toEqual(["AVG", "MIN", "MAX"]);
        for (const call of spy.mock.calls) {
          expect(call[6]).toBe(true);
        }
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("exists()", () => {
    it("exists(Entity, where, false, true)는 soft-deleted 존재를 검사해야 함 (IS NOT NULL)", async () => {
      mockQuery.mockResolvedValue({ results: [{ result: 1 }], fields: [] });

      const result = await em.exists(Article, undefined, false, true);

      expect(result).toBe(true);
      const sqlText = aggregateSql();
      expect(sqlText).toMatch(/"deletedAt"\s+IS\s+NOT\s+NULL/);
      expect(sqlText).not.toMatch(/"deletedAt"\s+IS\s+NULL/);
    });

    it("회귀: exists에 플래그가 없으면 활성 행만 검사(IS NULL)해야 함", async () => {
      mockQuery.mockResolvedValue({ results: [{ result: 0 }], fields: [] });

      await em.exists(Article);

      const sqlText = aggregateSql();
      expect(sqlText).toMatch(/"deletedAt"\s+IS\s+NULL/);
      expect(sqlText).not.toMatch(/IS\s+NOT\s+NULL/);
    });
  });

  describe("BaseRepository 위임", () => {
    it("repo.count(where, false, true)가 onlyDeleted를 전달해 IS NOT NULL을 emit해야 함", async () => {
      mockQuery.mockResolvedValue({ results: [{ result: 4 }], fields: [] });

      const repo = em.getRepository(Article);
      const result = await repo.count(undefined, false, true);

      expect(result).toBe(4);
      const sqlText = aggregateSql();
      expect(sqlText).toMatch(/"deletedAt"\s+IS\s+NOT\s+NULL/);
      expect(sqlText).not.toMatch(/"deletedAt"\s+IS\s+NULL/);
    });

    it("repo.sum(field, where, false, true)도 onlyDeleted를 전달해야 함", async () => {
      mockQuery.mockResolvedValue({ results: [{ result: 50 }], fields: [] });

      const repo = em.getRepository(Article);
      await repo.sum("views", undefined, false, true);

      const sqlText = aggregateSql();
      expect(sqlText).toMatch(/SUM/i);
      expect(sqlText).toMatch(/"deletedAt"\s+IS\s+NOT\s+NULL/);
      expect(sqlText).not.toMatch(/"deletedAt"\s+IS\s+NULL/);
    });
  });
});
