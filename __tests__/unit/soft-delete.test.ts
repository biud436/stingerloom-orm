/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { DeletedAt, DELETED_AT_TOKEN } from "../../src/decorators/DeletedAt";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";

// ─── @DeletedAt decorator tests ─────────────────────────────

describe("@DeletedAt decorator", () => {
  @Entity()
  class SoftUser {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column()
    name!: string;

    @DeletedAt()
    deletedAt!: Date | null;
  }

  @Entity()
  class HardUser {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column()
    name!: string;
  }

  it("DELETED_AT_TOKEN 메타데이터에 컬럼명을 저장해야 함", () => {
    const column = Reflect.getMetadata(DELETED_AT_TOKEN, SoftUser);
    expect(column).toBe("deletedAt");
  });

  it("@DeletedAt가 없는 엔티티는 DELETED_AT_TOKEN이 undefined", () => {
    const column = Reflect.getMetadata(DELETED_AT_TOKEN, HardUser);
    expect(column).toBeUndefined();
  });

  it("@DeletedAt 컬럼은 Column 메타데이터에도 등록되어야 함", () => {
    const columns = Reflect.getMetadata(
      Symbol.for("STG_COLUMN"),
      SoftUser.prototype,
    ) as any[];
    const deletedAtCol = columns?.find((c: any) => c.name === "deletedAt");
    expect(deletedAtCol).toBeDefined();
    expect(deletedAtCol.options.type).toBe("datetime");
    expect(deletedAtCol.options.nullable).toBe(true);
  });
});

// ─── EntityManager soft delete SQL generation tests ─────────

// We mock TransactionSessionManager and DatabaseClient to test SQL generation
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

const mockDbConnect = jest.fn().mockResolvedValue({
  query: jest.fn(),
});
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

describe("EntityManager soft delete", () => {
  let em: EntityManager;

  // Define test entities locally — these are fresh for each suite
  @Entity()
  class Article {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column()
    title!: string;

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

  describe("softDelete()", () => {
    it("@DeletedAt 컬럼이 있는 엔티티에 UPDATE ... SET deleted_at = NOW() 쿼리를 생성해야 함", async () => {
      mockQuery.mockResolvedValue({
        results: [], rowCount: 1,
        fields: [],
      });

      const result = await em.softDelete(Article, { id: 1 } as any);

      expect(mockQuery).toHaveBeenCalled();

      // Find the UPDATE query call
      const updateCall = mockQuery.mock.calls.find((call: any[]) => {
        const sqlObj = call[0];
        const sqlText =
          typeof sqlObj === "string" ? sqlObj : sqlObj?.sql || sqlObj?.text || "";
        return sqlText.includes("UPDATE");
      });

      expect(updateCall).toBeDefined();
      const sqlObj = updateCall![0];
      const sqlText = sqlObj?.sql || sqlObj?.text || "";
      expect(sqlText).toMatch(/UPDATE\s+"article"/i);
      expect(sqlText).toMatch(/SET\s+"deletedAt"\s*=\s*NOW\(\)/);
      expect(sqlText).toMatch(/WHERE/);
      expect(result.affected).toBe(1);
    });

    it("@DeletedAt 컬럼이 없는 엔티티에 softDelete()를 호출하면 에러를 던져야 함", async () => {
      await expect(
        em.softDelete(Comment, { id: 1 } as any),
      ).rejects.toThrow("does not have a @DeletedAt column");
    });

    it("조건 없이 softDelete()를 호출하면 에러를 던져야 함", async () => {
      await expect(em.softDelete(Article, {} as any)).rejects.toThrow(
        "without conditions is not allowed",
      );
    });
  });

  describe("restore()", () => {
    it("@DeletedAt 컬럼이 있는 엔티티에 UPDATE ... SET deleted_at = NULL 쿼리를 생성해야 함", async () => {
      mockQuery.mockResolvedValue({
        results: [], rowCount: 2,
        fields: [],
      });

      const result = await em.restore(Article, { id: 1 } as any);

      expect(mockQuery).toHaveBeenCalled();

      const updateCall = mockQuery.mock.calls.find((call: any[]) => {
        const sqlObj = call[0];
        const sqlText =
          typeof sqlObj === "string" ? sqlObj : sqlObj?.sql || sqlObj?.text || "";
        return sqlText.includes("UPDATE");
      });

      expect(updateCall).toBeDefined();
      const sqlObj = updateCall![0];
      const sqlText = sqlObj?.sql || sqlObj?.text || "";
      expect(sqlText).toMatch(/UPDATE\s+"article"/i);
      expect(sqlText).toMatch(/SET\s+"deletedAt"\s*=\s*NULL/);
      expect(sqlText).toMatch(/WHERE/);
      expect(result.affected).toBe(2);
    });

    it("@DeletedAt 컬럼이 없는 엔티티에 restore()를 호출하면 에러를 던져야 함", async () => {
      await expect(
        em.restore(Comment, { id: 1 } as any),
      ).rejects.toThrow("does not have a @DeletedAt column");
    });

    it("조건 없이 restore()를 호출하면 에러를 던져야 함", async () => {
      await expect(em.restore(Article, {} as any)).rejects.toThrow(
        "without conditions is not allowed",
      );
    });
  });

  describe("find() auto-filter", () => {
    it("@DeletedAt 컬럼이 있는 엔티티의 find()는 WHERE deleted_at IS NULL 조건이 포함되어야 함", async () => {
      mockQuery.mockResolvedValue({
        results: [{ id: 1, title: "Test", deletedAt: null }],
        fields: [],
      });

      await em.find(Article);

      const selectCall = mockQuery.mock.calls.find((call: any[]) => {
        const sqlObj = call[0];
        const sqlText =
          typeof sqlObj === "string" ? sqlObj : sqlObj?.sql || sqlObj?.text || "";
        return sqlText.includes("SELECT");
      });

      expect(selectCall).toBeDefined();
      const sqlObj = selectCall![0];
      const sqlText = sqlObj?.sql || sqlObj?.text || "";
      expect(sqlText).toMatch(/"deletedAt"\s+IS\s+NULL/);
    });

    it("withDeleted: true이면 deleted_at IS NULL 조건이 추가되지 않아야 함", async () => {
      mockQuery.mockResolvedValue({
        results: [
          { id: 1, title: "Test", deletedAt: null },
          { id: 2, title: "Deleted", deletedAt: "2026-01-01" },
        ],
        fields: [],
      });

      await em.find(Article, { withDeleted: true } as any);

      const selectCall = mockQuery.mock.calls.find((call: any[]) => {
        const sqlObj = call[0];
        const sqlText =
          typeof sqlObj === "string" ? sqlObj : sqlObj?.sql || sqlObj?.text || "";
        return sqlText.includes("SELECT");
      });

      expect(selectCall).toBeDefined();
      const sqlObj = selectCall![0];
      const sqlText = sqlObj?.sql || sqlObj?.text || "";
      expect(sqlText).not.toMatch(/"deletedAt"\s+IS\s+NULL/);
    });

    it("@DeletedAt가 없는 엔티티의 find()는 IS NULL 조건이 추가되지 않아야 함", async () => {
      mockQuery.mockResolvedValue({
        results: [{ id: 1, body: "Hello" }],
        fields: [],
      });

      await em.find(Comment);

      const selectCall = mockQuery.mock.calls.find((call: any[]) => {
        const sqlObj = call[0];
        const sqlText =
          typeof sqlObj === "string" ? sqlObj : sqlObj?.sql || sqlObj?.text || "";
        return sqlText.includes("SELECT");
      });

      expect(selectCall).toBeDefined();
      const sqlObj = selectCall![0];
      const sqlText = sqlObj?.sql || sqlObj?.text || "";
      expect(sqlText).not.toMatch(/IS\s+NULL/);
    });
  });

  describe("BaseRepository softDelete/restore delegation", () => {
    it("BaseRepository.softDelete()가 EntityManager.softDelete()를 호출해야 함", async () => {
      const repo = em.getRepository(Article);

      mockQuery.mockResolvedValue({
        results: [], rowCount: 1,
        fields: [],
      });

      const result = await repo.softDelete({ id: 1 } as any);
      expect(result.affected).toBe(1);
    });

    it("BaseRepository.restore()가 EntityManager.restore()를 호출해야 함", async () => {
      const repo = em.getRepository(Article);

      mockQuery.mockResolvedValue({
        results: [], rowCount: 1,
        fields: [],
      });

      const result = await repo.restore({ id: 1 } as any);
      expect(result.affected).toBe(1);
    });
  });
});
