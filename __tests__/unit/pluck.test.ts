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
class PluckUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @Column()
  email!: string;

  @Column()
  age!: number;
}

function lastQueryText(): string {
  const queryCall = mockQuery.mock.calls[mockQuery.mock.calls.length - 1][0];
  return typeof queryCall === "string" ? queryCall : queryCall.text;
}

describe("pluck()", () => {
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

  describe("EntityManager.pluck", () => {
    it("returns a flat array of the column values in row order", async () => {
      mockQuery.mockResolvedValue({
        results: [{ name: "Alice" }, { name: "Bob" }, { name: "Charlie" }],
        fields: [],
      });

      const names = await em.pluck(PluckUser, "name");

      expect(names).toEqual(["Alice", "Bob", "Charlie"]);
    });

    it("selects only the requested column (not * or other columns)", async () => {
      mockQuery.mockResolvedValue({
        results: [{ name: "Alice" }],
        fields: [],
      });

      await em.pluck(PluckUser, "name");

      const queryText = lastQueryText();
      expect(queryText).toContain('"name"');
      expect(queryText).not.toContain("*");
      expect(queryText).not.toContain('"email"');
      expect(queryText).not.toContain('"age"');
      expect(queryText).not.toContain('"id"');
    });

    it("honors the optional where filter (predicate appears in SQL)", async () => {
      mockQuery.mockResolvedValue({
        results: [{ id: 1 }, { id: 2 }],
        fields: [],
      });

      const ids = await em.pluck(PluckUser, "id", { age: 30 } as any);

      expect(ids).toEqual([1, 2]);

      const queryText = lastQueryText();
      expect(queryText).toContain('"id"');
      expect(queryText).toContain("WHERE");
      expect(queryText).toContain('"age"');
      // only the plucked column should be projected
      expect(queryText).not.toContain('"name"');
      expect(queryText).not.toContain('"email"');
    });

    it("returns an empty array when no rows match", async () => {
      mockQuery.mockResolvedValue({
        results: [],
        fields: [],
      });

      const emails = await em.pluck(PluckUser, "email", { id: 9999 } as any);

      expect(emails).toEqual([]);
    });

    it("does not add a WHERE clause when no filter is given", async () => {
      mockQuery.mockResolvedValue({
        results: [{ id: 1 }],
        fields: [],
      });

      await em.pluck(PluckUser, "id");

      const queryText = lastQueryText();
      expect(queryText).not.toContain("WHERE");
    });
  });

  describe("BaseRepository.pluck", () => {
    it("delegates to EntityManager.pluck and returns the same array", async () => {
      mockQuery.mockResolvedValue({
        results: [{ email: "a@test.com" }, { email: "b@test.com" }],
        fields: [],
      });

      const repo = em.getRepository(PluckUser);
      const spy = jest.spyOn(em, "pluck");

      const emails = await repo.pluck("email", { age: 20 } as any);

      expect(emails).toEqual(["a@test.com", "b@test.com"]);
      expect(spy).toHaveBeenCalledWith(PluckUser, "email", { age: 20 });

      const queryText = lastQueryText();
      expect(queryText).toContain('"email"');
      expect(queryText).not.toContain('"name"');
    });
  });
});
