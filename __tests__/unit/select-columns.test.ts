import "reflect-metadata";

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockQuery = jest.fn();
const mockCommit = jest.fn();
const mockRollback = jest.fn();
const mockClose = jest.fn();
const mockTxConnect = jest.fn();
const mockStartTransaction = jest.fn();

jest.mock("../../src/dialects/TransactionSessionManager", () => ({
  TransactionSessionManager: jest.fn().mockImplementation(() => ({
    connect: mockTxConnect,
    startTransaction: mockStartTransaction,
    query: mockQuery,
    commit: mockCommit,
    rollback: mockRollback,
    close: mockClose,
  })),
}));

jest.mock("../../src/DatabaseClient", () => ({
  DatabaseClient: {
    getInstance: () => ({
      connect: jest.fn().mockResolvedValue({ query: jest.fn() }),
      close: jest.fn(),
      getConnection: jest.fn(),
      getOptions: jest.fn().mockReturnValue({ synchronize: false }),
      type: "postgres",
    }),
  },
}));

import { EntityManager } from "../../src/core/EntityManager";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";

@Entity()
class SelectUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @Column()
  email!: string;

  @Column()
  age!: number;
}

describe("Select 특정 컬럼 지원", () => {
  let em: EntityManager;

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

  describe("배열 형태 select", () => {
    it('select: ["id", "name"]일 때 해당 컬럼만 SELECT해야 한다', async () => {
      mockQuery.mockResolvedValue({
        results: [{ id: 1, name: "Alice" }],
        fields: [],
      });

      await em.find(SelectUser, {
        select: ["id", "name"],
      });

      const queryCall = mockQuery.mock.calls[0][0];
      const queryText =
        typeof queryCall === "string" ? queryCall : queryCall.text;

      // "id"와 "name" 컬럼이 포함되어야 한다
      expect(queryText).toContain('"id"');
      expect(queryText).toContain('"name"');
      // "email"과 "age"는 포함되지 않아야 한다
      expect(queryText).not.toContain('"email"');
      expect(queryText).not.toContain('"age"');
    });

    it('select: ["email"]일 때 email 컬럼만 SELECT해야 한다', async () => {
      mockQuery.mockResolvedValue({
        results: [{ email: "alice@test.com" }],
        fields: [],
      });

      await em.find(SelectUser, {
        select: ["email"],
      });

      const queryCall = mockQuery.mock.calls[0][0];
      const queryText =
        typeof queryCall === "string" ? queryCall : queryCall.text;

      expect(queryText).toContain('"email"');
      expect(queryText).not.toContain('"name"');
      expect(queryText).not.toContain('"age"');
    });
  });

  describe("객체 형태 select", () => {
    it("{ id: true, name: true }일 때 해당 컬럼만 SELECT해야 한다", async () => {
      mockQuery.mockResolvedValue({
        results: [{ id: 1, name: "Bob" }],
        fields: [],
      });

      await em.find(SelectUser, {
        select: { id: true, name: true } as any,
      });

      const queryCall = mockQuery.mock.calls[0][0];
      const queryText =
        typeof queryCall === "string" ? queryCall : queryCall.text;

      expect(queryText).toContain('"id"');
      expect(queryText).toContain('"name"');
      expect(queryText).not.toContain('"email"');
      expect(queryText).not.toContain('"age"');
    });
  });

  describe("select 없음 (기본 동작)", () => {
    it("select가 없으면 모든 컬럼이 SELECT되어야 한다", async () => {
      mockQuery.mockResolvedValue({
        results: [{ id: 1, name: "Charlie", email: "c@test.com", age: 30 }],
        fields: [],
      });

      await em.find(SelectUser, {});

      const queryCall = mockQuery.mock.calls[0][0];
      const queryText =
        typeof queryCall === "string" ? queryCall : queryCall.text;

      expect(queryText).toContain('"id"');
      expect(queryText).toContain('"name"');
      expect(queryText).toContain('"email"');
      expect(queryText).toContain('"age"');
    });
  });

  describe("select + where 조합", () => {
    it("select와 where를 함께 사용할 수 있어야 한다", async () => {
      mockQuery.mockResolvedValue({
        results: [{ name: "Dave" }],
        fields: [],
      });

      await em.find(SelectUser, {
        select: ["name"],
        where: { id: 1 } as any,
      });

      const queryCall = mockQuery.mock.calls[0][0];
      const queryText =
        typeof queryCall === "string" ? queryCall : queryCall.text;

      expect(queryText).toContain('"name"');
      expect(queryText).toContain("WHERE");
    });
  });

  describe("select + limit 조합", () => {
    it("select와 limit을 함께 사용할 수 있어야 한다", async () => {
      mockQuery.mockResolvedValue({
        results: [{ id: 1 }],
        fields: [],
      });

      await em.findOne(SelectUser, {
        select: ["id"],
        where: { name: "Eve" } as any,
      });

      const queryCall = mockQuery.mock.calls[0][0];
      const queryText =
        typeof queryCall === "string" ? queryCall : queryCall.text;

      expect(queryText).toContain('"id"');
      expect(queryText).not.toContain('"email"');
    });
  });

  describe("SQL 인젝션 방지", () => {
    it("컬럼명이 escapeIdentifier로 래핑되어야 한다", async () => {
      mockQuery.mockResolvedValue({
        results: [{ id: 1, name: "test" }],
        fields: [],
      });

      await em.find(SelectUser, {
        select: ["id", "name"],
      });

      const queryCall = mockQuery.mock.calls[0][0];
      const queryText =
        typeof queryCall === "string" ? queryCall : queryCall.text;

      // PostgreSQL에서는 큰따옴표로 래핑
      expect(queryText).toMatch(/"id"/);
      expect(queryText).toMatch(/"name"/);
    });
  });
});
