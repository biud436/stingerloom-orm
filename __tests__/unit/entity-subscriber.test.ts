/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import {
  EntitySubscriber,
  InsertEvent,
  UpdateEvent,
  DeleteEvent,
} from "../../src/core/EntitySubscriber";
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

const mockQuery = jest.fn();
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

// 테스트용 엔티티 클래스
class User {
  id!: number;
  name!: string;
  email!: string;
}

class Post {
  id!: number;
  title!: string;
}

// 메타데이터 모의 객체
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
  ],
};

describe("EntitySubscriber", () => {
  let em: EntityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    em = new EntityManager();

    // resolveEntityMetadata mock
    jest.spyOn(em as any, "resolveEntityMetadata").mockImplementation(
      (entity: any) => {
        if (entity === User) return userMetadata;
        if (entity === Post) return postMetadata;
        return null;
      },
    );

    // isMySqlFamily mock
    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);

    // isPostgres mock
    jest.spyOn(em as any, "isPostgres").mockReturnValue(false);

    // wrap mock (identity wrapper)
    jest.spyOn(em as any, "wrap").mockImplementation((...args: any[]) => `\`${args[0]}\``);

    // resolveOneToOneMetadata mock
    jest.spyOn(em as any, "resolveOneToOneMetadata").mockReturnValue([]);

    // resolveManyToOneMetadata mock
    jest.spyOn(em as any, "resolveManyToOneMetadata").mockReturnValue([]);

    // resolveOneToManyMetadata mock
    jest.spyOn(em as any, "resolveOneToManyMetadata").mockReturnValue([]);

    // runHooks mock
    jest.spyOn(em as any, "runHooks").mockResolvedValue(undefined);

    // cascadeSaveOneToMany mock
    jest.spyOn(em as any, "cascadeSaveOneToMany").mockResolvedValue(undefined);

    // getDeletedAtColumn mock
    jest.spyOn(em as any, "getDeletedAtColumn").mockReturnValue(null);

    // findOneInternal mock (for save — internal re-read after INSERT/UPDATE)
    jest.spyOn(em as any, "findOneInternal").mockResolvedValue(undefined);
  });

  describe("addSubscriber / removeSubscriber", () => {
    it("should add a subscriber", () => {
      const sub: EntitySubscriber<User> = {
        listenTo: () => User,
      };

      em.addSubscriber(sub);
      expect((em as any).subscribers).toContain(sub);
    });

    it("should remove a subscriber", () => {
      const sub: EntitySubscriber<User> = {
        listenTo: () => User,
      };

      em.addSubscriber(sub);
      em.removeSubscriber(sub);
      expect((em as any).subscribers).not.toContain(sub);
    });

    it("should not throw when removing a subscriber that was never added", () => {
      const sub: EntitySubscriber<User> = {
        listenTo: () => User,
      };

      expect(() => em.removeSubscriber(sub)).not.toThrow();
    });

    it("should support multiple subscribers", () => {
      const sub1: EntitySubscriber<User> = { listenTo: () => User };
      const sub2: EntitySubscriber<Post> = { listenTo: () => Post };

      em.addSubscriber(sub1);
      em.addSubscriber(sub2);
      expect((em as any).subscribers).toHaveLength(2);
    });
  });

  describe("save() — Insert path subscriber notifications", () => {
    beforeEach(() => {
      mockQuery
        .mockResolvedValueOnce(undefined) // SET autocommit = 0
        .mockResolvedValueOnce({
          results: { insertId: 1, affectedRows: 1 },
          fields: [],
        });
    });

    it("should call beforeInsert on matching subscriber", async () => {
      const beforeInsertSpy = jest.fn();
      const sub: EntitySubscriber<User> = {
        listenTo: () => User,
        beforeInsert: beforeInsertSpy,
      };

      em.addSubscriber(sub);
      await em.save(User, { name: "Alice", email: "alice@test.com" });

      expect(beforeInsertSpy).toHaveBeenCalledTimes(1);
      const event: InsertEvent<User> = beforeInsertSpy.mock.calls[0][0];
      expect(event.entity).toEqual({ name: "Alice", email: "alice@test.com" });
      expect(event.manager).toBe(em);
    });

    it("should call afterInsert on matching subscriber", async () => {
      const afterInsertSpy = jest.fn();
      const sub: EntitySubscriber<User> = {
        listenTo: () => User,
        afterInsert: afterInsertSpy,
      };

      em.addSubscriber(sub);
      await em.save(User, { name: "Bob", email: "bob@test.com" });

      expect(afterInsertSpy).toHaveBeenCalledTimes(1);
      const event: InsertEvent<User> = afterInsertSpy.mock.calls[0][0];
      expect(event.manager).toBe(em);
    });

    it("should NOT call subscriber for a different entity", async () => {
      const beforeInsertSpy = jest.fn();
      const sub: EntitySubscriber<Post> = {
        listenTo: () => Post,
        beforeInsert: beforeInsertSpy,
      };

      em.addSubscriber(sub);
      await em.save(User, { name: "Alice", email: "alice@test.com" });

      expect(beforeInsertSpy).not.toHaveBeenCalled();
    });

    it("should call both beforeInsert and afterInsert in order", async () => {
      const order: string[] = [];
      const sub: EntitySubscriber<User> = {
        listenTo: () => User,
        beforeInsert: () => { order.push("beforeInsert"); },
        afterInsert: () => { order.push("afterInsert"); },
      };

      em.addSubscriber(sub);
      await em.save(User, { name: "Alice", email: "alice@test.com" });

      expect(order).toEqual(["beforeInsert", "afterInsert"]);
    });
  });

  describe("save() — Update path subscriber notifications", () => {
    beforeEach(() => {
      mockQuery
        .mockResolvedValueOnce(undefined) // SET autocommit = 0
        .mockResolvedValueOnce({
          results: { affectedRows: 1 },
          fields: [],
        });
    });

    it("should call beforeUpdate and afterUpdate on matching subscriber", async () => {
      const beforeUpdateSpy = jest.fn();
      const afterUpdateSpy = jest.fn();
      const sub: EntitySubscriber<User> = {
        listenTo: () => User,
        beforeUpdate: beforeUpdateSpy,
        afterUpdate: afterUpdateSpy,
      };

      em.addSubscriber(sub);
      // Pass an entity with a PK value to trigger update path
      await em.save(User, { id: 1, name: "Updated" } as any);

      expect(beforeUpdateSpy).toHaveBeenCalledTimes(1);
      expect(afterUpdateSpy).toHaveBeenCalledTimes(1);

      const event: UpdateEvent<User> = beforeUpdateSpy.mock.calls[0][0];
      expect(event.manager).toBe(em);
    });
  });

  describe("delete() subscriber notifications", () => {
    beforeEach(() => {
      mockQuery
        .mockResolvedValueOnce(undefined) // SET autocommit = 0
        .mockResolvedValueOnce({
          results: { affectedRows: 1 },
          fields: [],
        });
    });

    it("should call beforeDelete on matching subscriber", async () => {
      const beforeDeleteSpy = jest.fn();
      const sub: EntitySubscriber<User> = {
        listenTo: () => User,
        beforeDelete: beforeDeleteSpy,
      };

      em.addSubscriber(sub);
      await em.delete(User, { id: 1 } as any);

      expect(beforeDeleteSpy).toHaveBeenCalledTimes(1);
      const event: DeleteEvent<User> = beforeDeleteSpy.mock.calls[0][0];
      expect(event.entityClass).toBe(User);
      expect(event.criteria).toEqual({ id: 1 });
      expect(event.manager).toBe(em);
    });

    it("should call afterDelete on matching subscriber", async () => {
      const afterDeleteSpy = jest.fn();
      const sub: EntitySubscriber<User> = {
        listenTo: () => User,
        afterDelete: afterDeleteSpy,
      };

      em.addSubscriber(sub);
      await em.delete(User, { id: 1 } as any);

      expect(afterDeleteSpy).toHaveBeenCalledTimes(1);
    });

    it("should NOT call delete subscriber for a different entity", async () => {
      const beforeDeleteSpy = jest.fn();
      const sub: EntitySubscriber<Post> = {
        listenTo: () => Post,
        beforeDelete: beforeDeleteSpy,
      };

      em.addSubscriber(sub);
      await em.delete(User, { id: 1 } as any);

      expect(beforeDeleteSpy).not.toHaveBeenCalled();
    });
  });

  describe("multiple subscribers", () => {
    beforeEach(() => {
      mockQuery
        .mockResolvedValueOnce(undefined) // SET autocommit = 0
        .mockResolvedValueOnce({
          results: { insertId: 1, affectedRows: 1 },
          fields: [],
        });
    });

    it("should notify all matching subscribers for the same entity", async () => {
      const spy1 = jest.fn();
      const spy2 = jest.fn();

      const sub1: EntitySubscriber<User> = {
        listenTo: () => User,
        beforeInsert: spy1,
      };
      const sub2: EntitySubscriber<User> = {
        listenTo: () => User,
        beforeInsert: spy2,
      };

      em.addSubscriber(sub1);
      em.addSubscriber(sub2);
      await em.save(User, { name: "Alice", email: "alice@test.com" });

      expect(spy1).toHaveBeenCalledTimes(1);
      expect(spy2).toHaveBeenCalledTimes(1);
    });

    it("should only notify the subscriber matching the entity", async () => {
      const userSpy = jest.fn();
      const postSpy = jest.fn();

      const userSub: EntitySubscriber<User> = {
        listenTo: () => User,
        beforeInsert: userSpy,
      };
      const postSub: EntitySubscriber<Post> = {
        listenTo: () => Post,
        beforeInsert: postSpy,
      };

      em.addSubscriber(userSub);
      em.addSubscriber(postSub);
      await em.save(User, { name: "Alice", email: "alice@test.com" });

      expect(userSpy).toHaveBeenCalledTimes(1);
      expect(postSpy).not.toHaveBeenCalled();
    });
  });

  describe("async subscriber methods", () => {
    beforeEach(() => {
      mockQuery
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({
          results: { insertId: 1, affectedRows: 1 },
          fields: [],
        });
    });

    it("should await async subscriber methods", async () => {
      const order: string[] = [];

      const sub: EntitySubscriber<User> = {
        listenTo: () => User,
        beforeInsert: async () => {
          await new Promise((r) => setTimeout(r, 10));
          order.push("asyncBefore");
        },
        afterInsert: () => {
          order.push("afterInsert");
        },
      };

      em.addSubscriber(sub);
      await em.save(User, { name: "Alice", email: "alice@test.com" });

      expect(order).toEqual(["asyncBefore", "afterInsert"]);
    });
  });

  describe("subscriber with partial methods", () => {
    beforeEach(() => {
      mockQuery
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({
          results: { insertId: 1, affectedRows: 1 },
          fields: [],
        });
    });

    it("should not throw if subscriber has no matching method", async () => {
      const sub: EntitySubscriber<User> = {
        listenTo: () => User,
        // Only afterDelete defined, no beforeInsert/afterInsert
        afterDelete: jest.fn(),
      };

      em.addSubscriber(sub);

      await expect(
        em.save(User, { name: "Alice", email: "alice@test.com" }),
      ).resolves.not.toThrow();
    });
  });

  describe("transaction subscriber notifications", () => {
    it("should call notifyTransactionSubscribers for all subscribers", async () => {
      const beforeTxStartSpy = jest.fn();
      const afterTxStartSpy = jest.fn();

      const sub: EntitySubscriber<User> = {
        listenTo: () => User,
        beforeTransactionStart: beforeTxStartSpy,
        afterTransactionStart: afterTxStartSpy,
      };

      em.addSubscriber(sub);

      // Directly test notifyTransactionSubscribers
      await (em as any).notifyTransactionSubscribers("beforeTransactionStart");
      await (em as any).notifyTransactionSubscribers("afterTransactionStart");

      expect(beforeTxStartSpy).toHaveBeenCalledTimes(1);
      expect(afterTxStartSpy).toHaveBeenCalledTimes(1);
    });

    it("should call transaction subscribers regardless of entity type", async () => {
      const spy1 = jest.fn();
      const spy2 = jest.fn();

      const sub1: EntitySubscriber<User> = {
        listenTo: () => User,
        beforeTransactionCommit: spy1,
      };
      const sub2: EntitySubscriber<Post> = {
        listenTo: () => Post,
        beforeTransactionCommit: spy2,
      };

      em.addSubscriber(sub1);
      em.addSubscriber(sub2);

      await (em as any).notifyTransactionSubscribers("beforeTransactionCommit");

      expect(spy1).toHaveBeenCalledTimes(1);
      expect(spy2).toHaveBeenCalledTimes(1);
    });

    it("should handle all transaction lifecycle methods", async () => {
      const events: string[] = [];

      const sub: EntitySubscriber<User> = {
        listenTo: () => User,
        beforeTransactionStart: () => { events.push("beforeTxStart"); },
        afterTransactionStart: () => { events.push("afterTxStart"); },
        beforeTransactionCommit: () => { events.push("beforeTxCommit"); },
        afterTransactionCommit: () => { events.push("afterTxCommit"); },
        beforeTransactionRollback: () => { events.push("beforeTxRollback"); },
        afterTransactionRollback: () => { events.push("afterTxRollback"); },
      };

      em.addSubscriber(sub);

      await (em as any).notifyTransactionSubscribers("beforeTransactionStart");
      await (em as any).notifyTransactionSubscribers("afterTransactionStart");
      await (em as any).notifyTransactionSubscribers("beforeTransactionCommit");
      await (em as any).notifyTransactionSubscribers("afterTransactionCommit");
      await (em as any).notifyTransactionSubscribers("beforeTransactionRollback");
      await (em as any).notifyTransactionSubscribers("afterTransactionRollback");

      expect(events).toEqual([
        "beforeTxStart",
        "afterTxStart",
        "beforeTxCommit",
        "afterTxCommit",
        "beforeTxRollback",
        "afterTxRollback",
      ]);
    });
  });

  describe("InsertEvent / UpdateEvent / DeleteEvent types", () => {
    it("InsertEvent should have entity and manager", () => {
      const event: InsertEvent<User> = {
        entity: { id: 1, name: "Alice", email: "alice@test.com" },
        manager: em,
      };
      expect(event.entity.name).toBe("Alice");
      expect(event.manager).toBe(em);
    });

    it("UpdateEvent should have entity and manager", () => {
      const event: UpdateEvent<User> = {
        entity: { id: 1, name: "Updated", email: "a@b.com" },
        manager: em,
      };
      expect(event.entity.name).toBe("Updated");
      expect(event.manager).toBe(em);
    });

    it("DeleteEvent should have entityClass, criteria, and manager", () => {
      const event: DeleteEvent<User> = {
        entityClass: User,
        criteria: { id: 1 },
        manager: em,
      };
      expect(event.entityClass).toBe(User);
      expect(event.criteria).toEqual({ id: 1 });
      expect(event.manager).toBe(em);
    });
  });
});
