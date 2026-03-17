/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";
import { OrmError } from "../../src/errors/OrmError";
import { mutationPlugin } from "../../src/core/plugin/mutation/mutationPlugin";
import { Mutation } from "../../src/core/plugin/mutation/Mutation";
import {
  SnapshotStrategy,
  cloneValue,
  deepEquals,
} from "../../src/core/plugin/mutation/MutationStrategy";
import { COLUMN_TOKEN } from "../../src/decorators/Column";
import { ENTITY_TOKEN } from "../../src/decorators/Entity";

// ── Mock DatabaseClient ─────────────────────────────────────────

jest.mock("../../src/DatabaseClient", () => {
  return {
    DatabaseClient: {
      getInstance: jest.fn().mockReturnValue({
        type: "mysql",
        getConnection: jest.fn(),
        getOptions: jest.fn().mockReturnValue({ synchronize: false }),
        connect: jest.fn(),
        close: jest.fn().mockResolvedValue(undefined),
        getType: jest.fn().mockReturnValue("mysql"),
      }),
    },
  };
});

jest.mock("../../src/dialects/TransactionSessionManager", () => {
  return {
    TransactionSessionManager: jest.fn().mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(),
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    })),
  };
});

// ── Test Entity Definitions ─────────────────────────────────────

class User {
  id!: number;
  name!: string;
  email!: string;
}

// Register entity metadata
Reflect.defineMetadata(ENTITY_TOKEN, { name: "User", tableName: "users" }, User);
Reflect.defineMetadata(
  COLUMN_TOKEN,
  [
    { target: User, name: "id", propertyKey: "id", type: Number, options: { primary: true, autoIncrement: true } },
    { target: User, name: "name", propertyKey: "name", type: String, options: {} },
    { target: User, name: "email", propertyKey: "email", type: String, options: {} },
  ],
  User.prototype,
);

class Comment {
  id!: number;
  body!: string;
  postId!: number;
}

Reflect.defineMetadata(ENTITY_TOKEN, { name: "Comment", tableName: "comments" }, Comment);
Reflect.defineMetadata(
  COLUMN_TOKEN,
  [
    { target: Comment, name: "id", propertyKey: "id", type: Number, options: { primary: true, autoIncrement: true } },
    { target: Comment, name: "body", propertyKey: "body", type: String, options: {} },
    { target: Comment, name: "postId", propertyKey: "postId", type: Number, options: {} },
  ],
  Comment.prototype,
);

class Tag {
  id!: number;
  label!: string;
}

Reflect.defineMetadata(ENTITY_TOKEN, { name: "Tag", tableName: "tags" }, Tag);
Reflect.defineMetadata(
  COLUMN_TOKEN,
  [
    { target: Tag, name: "id", propertyKey: "id", type: Number, options: { primary: true, autoIncrement: true } },
    { target: Tag, name: "label", propertyKey: "label", type: String, options: {} },
  ],
  Tag.prototype,
);

// Composite PK entity
class OrderItem {
  orderId!: number;
  productId!: number;
  quantity!: number;
}

Reflect.defineMetadata(ENTITY_TOKEN, { name: "OrderItem", tableName: "order_items" }, OrderItem);
Reflect.defineMetadata(
  COLUMN_TOKEN,
  [
    { target: OrderItem, name: "orderId", propertyKey: "orderId", type: Number, options: { primary: true } },
    { target: OrderItem, name: "productId", propertyKey: "productId", type: Number, options: { primary: true } },
    { target: OrderItem, name: "quantity", propertyKey: "quantity", type: Number, options: {} },
  ],
  OrderItem.prototype,
);

// Entity with Date/JSON fields
class Profile {
  id!: number;
  birthday!: Date;
  settings!: Record<string, any>;
}

Reflect.defineMetadata(ENTITY_TOKEN, { name: "Profile", tableName: "profiles" }, Profile);
Reflect.defineMetadata(
  COLUMN_TOKEN,
  [
    { target: Profile, name: "id", propertyKey: "id", type: Number, options: { primary: true, autoIncrement: true } },
    { target: Profile, name: "birthday", propertyKey: "birthday", type: Date, options: {} },
    { target: Profile, name: "settings", propertyKey: "settings", type: Object, options: {} },
  ],
  Profile.prototype,
);

// ── Helpers ─────────────────────────────────────────────────────

function createEmWithEntities(...entities: any[]): EntityManager {
  const em = new EntityManager();
  // Inject entities into EM's internal list via reflection
  (em as any)._entities = entities;
  return em;
}

function createExtendedEm(...entities: any[]) {
  const em = createEmWithEntities(...entities);
  return em.extend(mutationPlugin());
}

// ── Tests ───────────────────────────────────────────────────────

describe("Mutation Plugin", () => {
  // ── Installation & Stub ───────────────────────────────────────

  describe("installation", () => {
    it("should allow em.mutate() after installing mutation plugin", () => {
      const em = createExtendedEm(User);
      const mut = em.mutate();
      expect(mut).toBeInstanceOf(Mutation);
    });

    it("should throw MUTATION_NOT_INSTALLED when plugin is not installed", () => {
      const em = new EntityManager();
      expect(() => em.mutate()).toThrow(OrmError);
      try {
        em.mutate();
      } catch (err: any) {
        expect(err.code).toBe(OrmErrorCode.MUTATION_NOT_INSTALLED);
      }
    });

    it("should return independent Mutation instances per mutate() call", () => {
      const em = createExtendedEm(User);
      const mut1 = em.mutate();
      const mut2 = em.mutate();
      expect(mut1).not.toBe(mut2);
    });
  });

  // ── track() ───────────────────────────────────────────────────

  describe("track()", () => {
    it("should store snapshot at track time", () => {
      const em = createExtendedEm(User);
      const mut = em.mutate();

      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);

      expect(mut.tracked()).toEqual([user]);
      expect(mut.dirty()).toEqual([]); // no changes yet
    });

    it("should throw for non-entity instances", () => {
      class NotAnEntity { x = 1; }
      const em = createExtendedEm(User);
      const mut = em.mutate();

      expect(() => mut.track(new NotAnEntity())).toThrow(/not a registered entity/);
    });

    it("should be idempotent (same instance tracked twice)", () => {
      const em = createExtendedEm(User);
      const mut = em.mutate();

      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);
      mut.track(user); // no error

      expect(mut.tracked()).toHaveLength(1);
    });

    it("should infer entity class from instance.constructor", () => {
      const em = createExtendedEm(User, Comment);
      const mut = em.mutate();

      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      const comment = Object.assign(new Comment(), { id: 1, body: "hi", postId: 1 });

      mut.track(user);
      mut.track(comment);

      expect(mut.tracked()).toHaveLength(2);
    });

    it("should support composite PK entities", () => {
      const em = createExtendedEm(OrderItem);
      const mut = em.mutate();

      const item = Object.assign(new OrderItem(), { orderId: 1, productId: 2, quantity: 5 });
      mut.track(item);

      expect(mut.tracked()).toEqual([item]);
    });
  });

  // ── find() / findOne() — auto-tracking ─────────────────────

  describe("find() and findOne() auto-tracking", () => {
    it("findOne() should load and auto-track the entity", async () => {
      const em = createExtendedEm(User);
      const mockUser = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      jest.spyOn(em, "findOne").mockResolvedValue(mockUser);

      const mut = em.mutate();
      const result = await mut.findOne(User, { where: { id: 1 } as any });

      expect(result).toBe(mockUser);
      expect(mut.tracked()).toEqual([mockUser]);
    });

    it("findOne() should return null and not track when not found", async () => {
      const em = createExtendedEm(User);
      jest.spyOn(em, "findOne").mockResolvedValue(null);

      const mut = em.mutate();
      const result = await mut.findOne(User, { where: { id: 999 } as any });

      expect(result).toBeNull();
      expect(mut.tracked()).toHaveLength(0);
    });

    it("find() should load and auto-track all results", async () => {
      const em = createExtendedEm(User);
      const users = [
        Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" }),
        Object.assign(new User(), { id: 2, name: "Bob", email: "b@c.d" }),
      ];
      jest.spyOn(em, "find").mockResolvedValue(users);

      const mut = em.mutate();
      const result = await mut.find(User, { where: { name: "Alice" } as any });

      expect(result).toEqual(users);
      expect(mut.tracked()).toHaveLength(2);
    });

    it("find() should return empty array and not track when no results", async () => {
      const em = createExtendedEm(User);
      jest.spyOn(em, "find").mockResolvedValue([]);

      const mut = em.mutate();
      const result = await mut.find(User);

      expect(result).toEqual([]);
      expect(mut.tracked()).toHaveLength(0);
    });

    it("findOne() + modify + flush should update DB", async () => {
      const em = createExtendedEm(User);
      const mockUser = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      jest.spyOn(em, "findOne").mockResolvedValue(mockUser);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      const updateSpy = jest.spyOn(em, "updateMany").mockResolvedValue({ affected: 1 });

      const mut = em.mutate();
      const user = await mut.findOne(User, { where: { id: 1 } as any });
      user!.name = "Updated";

      const result = await mut.flush();

      expect(result.updates).toBe(1);
      expect(updateSpy).toHaveBeenCalledWith(
        User,
        { name: "Updated" },
        { where: { id: 1 } },
      );
    });
  });

  // ── dirty() ───────────────────────────────────────────────────

  describe("dirty()", () => {
    it("should return empty when nothing changed", () => {
      const em = createExtendedEm(User);
      const mut = em.mutate();

      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);

      expect(mut.dirty()).toEqual([]);
    });

    it("should detect property changes", () => {
      const em = createExtendedEm(User);
      const mut = em.mutate();

      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);
      user.name = "Bob";

      expect(mut.dirty()).toEqual([user]);
    });

    it("should detect Date field changes", () => {
      const em = createExtendedEm(Profile);
      const mut = em.mutate();

      const profile = Object.assign(new Profile(), {
        id: 1,
        birthday: new Date("2000-01-01"),
        settings: {},
      });
      mut.track(profile);
      profile.birthday = new Date("2001-02-02");

      expect(mut.dirty()).toEqual([profile]);
    });

    it("should detect JSON/object field changes (deep comparison)", () => {
      const em = createExtendedEm(Profile);
      const mut = em.mutate();

      const profile = Object.assign(new Profile(), {
        id: 1,
        birthday: new Date("2000-01-01"),
        settings: { theme: "dark", lang: "en" },
      });
      mut.track(profile);
      profile.settings.theme = "light";

      expect(mut.dirty()).toEqual([profile]);
    });

    it("should NOT consider PK changes as dirty", () => {
      const em = createExtendedEm(User);
      const mut = em.mutate();

      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);
      user.id = 999; // PK change should be ignored

      expect(mut.dirty()).toEqual([]);
    });
  });

  // ── save() / delete() queuing ─────────────────────────────────

  describe("save() and delete() queuing", () => {
    it("should queue INSERT operations", () => {
      const em = createExtendedEm(Comment);
      const mut = em.mutate();

      mut.save(Comment, { body: "new comment", postId: 1 });

      expect(mut.size().inserts).toBe(1);
    });

    it("should queue DELETE operations", () => {
      const em = createExtendedEm(Tag);
      const mut = em.mutate();

      mut.delete(Tag, { id: 5 });

      expect(mut.size().deletes).toBe(1);
    });
  });

  // ── preview() ─────────────────────────────────────────────────

  describe("preview()", () => {
    it("should respect flush order: updates → inserts → deletes", () => {
      const em = createExtendedEm(User, Comment, Tag);
      const mut = em.mutate();

      // Track + modify user
      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);
      user.name = "Updated";

      // Queue insert + delete
      mut.save(Comment, { body: "new", postId: 1 });
      mut.delete(Tag, { id: 5 });

      const preview = mut.preview();

      expect(preview).toHaveLength(3);
      expect(preview[0].action).toBe("update");
      expect(preview[1].action).toBe("insert");
      expect(preview[2].action).toBe("delete");
    });

    it("should include PK values in update WHERE", () => {
      const em = createExtendedEm(User);
      const mut = em.mutate();

      const user = Object.assign(new User(), { id: 42, name: "Alice", email: "a@b.c" });
      mut.track(user);
      user.name = "Bob";

      const preview = mut.preview();
      expect(preview[0]).toMatchObject({
        action: "update",
        entity: "User",
        where: { id: 42 },
        data: { name: "Bob" },
      });
    });

    it("should return empty array when nothing to do", () => {
      const em = createExtendedEm(User);
      const mut = em.mutate();

      expect(mut.preview()).toEqual([]);
    });
  });

  // ── flush() ───────────────────────────────────────────────────

  describe("flush()", () => {
    it("should call em.transaction()", async () => {
      const em = createExtendedEm(User);
      const transactionSpy = jest.spyOn(em, "transaction").mockImplementation(
        async (cb) => cb(em as any),
      );

      const mut = em.mutate();
      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);
      user.name = "Bob";

      await mut.flush();

      expect(transactionSpy).toHaveBeenCalledTimes(1);
      transactionSpy.mockRestore();
    });

    it("should call em.updateMany() for dirty entities", async () => {
      const em = createExtendedEm(User);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      const updateManySpy = jest.spyOn(em, "updateMany").mockResolvedValue({ affected: 1 });

      const mut = em.mutate();
      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);
      user.name = "Bob";

      await mut.flush();

      expect(updateManySpy).toHaveBeenCalledWith(
        User,
        { name: "Bob" },
        { where: { id: 1 } },
      );
      updateManySpy.mockRestore();
    });

    it("should call em.save() for queued inserts", async () => {
      const em = createExtendedEm(Comment);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      const saveSpy = jest.spyOn(em, "save").mockResolvedValue({} as any);

      const mut = em.mutate();
      mut.save(Comment, { body: "new", postId: 1 });

      await mut.flush();

      expect(saveSpy).toHaveBeenCalledWith(Comment, { body: "new", postId: 1 });
      saveSpy.mockRestore();
    });

    it("should call em.delete() for queued deletes", async () => {
      const em = createExtendedEm(Tag);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      const deleteSpy = jest.spyOn(em, "delete").mockResolvedValue({ affected: 1 });

      const mut = em.mutate();
      mut.delete(Tag, { id: 5 });

      await mut.flush();

      expect(deleteSpy).toHaveBeenCalledWith(Tag, { id: 5 });
      deleteSpy.mockRestore();
    });

    it("should execute in order: updates → inserts → deletes", async () => {
      const em = createExtendedEm(User, Comment, Tag);
      const callOrder: string[] = [];

      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      jest.spyOn(em, "updateMany").mockImplementation(async () => {
        callOrder.push("update");
        return { affected: 1 };
      });
      jest.spyOn(em, "save").mockImplementation(async () => {
        callOrder.push("insert");
        return {} as any;
      });
      jest.spyOn(em, "delete").mockImplementation(async () => {
        callOrder.push("delete");
        return { affected: 1 };
      });

      const mut = em.mutate();

      // Queue delete first, insert second, then track+modify
      mut.delete(Tag, { id: 5 });
      mut.save(Comment, { body: "new", postId: 1 });
      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);
      user.name = "Bob";

      await mut.flush();

      expect(callOrder).toEqual(["update", "insert", "delete"]);
    });

    it("should re-snapshot when retainAfterFlush is true (default)", async () => {
      const em = createExtendedEm(User);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      jest.spyOn(em, "updateMany").mockResolvedValue({ affected: 1 });

      const mut = em.mutate();
      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);
      user.name = "Bob";

      await mut.flush();

      // After flush, "Bob" is the new snapshot — no longer dirty
      expect(mut.dirty()).toEqual([]);
      expect(mut.tracked()).toEqual([user]);
    });

    it("should clear tracked state when retainAfterFlush is false", async () => {
      const em = createEmWithEntities(User);
      const extended = em.extend(mutationPlugin({ retainAfterFlush: false }));
      jest.spyOn(extended, "transaction").mockImplementation(async (cb) => cb(extended as any));
      jest.spyOn(extended, "updateMany").mockResolvedValue({ affected: 1 });

      const mut = extended.mutate();
      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);
      user.name = "Bob";

      await mut.flush();

      expect(mut.tracked()).toEqual([]);
    });

    it("should preserve state on flush failure (retry possible)", async () => {
      const em = createExtendedEm(User, Comment);
      jest.spyOn(em, "transaction").mockRejectedValue(new Error("DB error"));

      const mut = em.mutate();
      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);
      user.name = "Bob";
      mut.save(Comment, { body: "new", postId: 1 });

      await expect(mut.flush()).rejects.toThrow("DB error");

      // State preserved for retry
      expect(mut.dirty()).toEqual([user]);
      expect(mut.size().inserts).toBe(1);
    });

    it("should return correct MutationFlushResult counts", async () => {
      const em = createExtendedEm(User, Comment, Tag);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      jest.spyOn(em, "updateMany").mockResolvedValue({ affected: 1 });
      jest.spyOn(em, "save").mockResolvedValue({} as any);
      jest.spyOn(em, "delete").mockResolvedValue({ affected: 1 });

      const mut = em.mutate();
      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);
      user.name = "Bob";
      mut.save(Comment, { body: "c1", postId: 1 });
      mut.save(Comment, { body: "c2", postId: 1 });
      mut.delete(Tag, { id: 5 });

      const result = await mut.flush();

      expect(result).toEqual({ updates: 1, inserts: 2, deletes: 1 });
    });

    it("should be a no-op when nothing to flush", async () => {
      const em = createExtendedEm(User);
      const transactionSpy = jest.spyOn(em, "transaction");

      const mut = em.mutate();
      const result = await mut.flush();

      expect(result).toEqual({ updates: 0, inserts: 0, deletes: 0 });
      expect(transactionSpy).not.toHaveBeenCalled();
    });
  });

  // ── clear() / untrack() / size() ──────────────────────────────

  describe("clear(), untrack(), size()", () => {
    it("should clear all state", () => {
      const em = createExtendedEm(User, Comment, Tag);
      const mut = em.mutate();

      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);
      mut.save(Comment, { body: "new", postId: 1 });
      mut.delete(Tag, { id: 5 });

      mut.clear();

      expect(mut.tracked()).toEqual([]);
      expect(mut.size()).toEqual({ tracked: 0, inserts: 0, deletes: 0 });
    });

    it("should untrack a specific entity", () => {
      const em = createExtendedEm(User);
      const mut = em.mutate();

      const user1 = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      const user2 = Object.assign(new User(), { id: 2, name: "Bob", email: "b@c.d" });
      mut.track(user1);
      mut.track(user2);

      mut.untrack(user1);

      expect(mut.tracked()).toEqual([user2]);
    });
  });

  // ── Mixed operations ──────────────────────────────────────────

  describe("mixed operations", () => {
    it("should handle tracked updates + queued inserts + queued deletes", async () => {
      const em = createExtendedEm(User, Comment, Tag);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      const updateManySpy = jest.spyOn(em, "updateMany").mockResolvedValue({ affected: 1 });
      const saveSpy = jest.spyOn(em, "save").mockResolvedValue({} as any);
      const deleteSpy = jest.spyOn(em, "delete").mockResolvedValue({ affected: 1 });

      const mut = em.mutate();

      // Track and modify
      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);
      user.name = "Updated";

      // Queue operations
      mut.save(Comment, { body: "c1", postId: 1 });
      mut.delete(Tag, { id: 3 });

      const result = await mut.flush();

      expect(result).toEqual({ updates: 1, inserts: 1, deletes: 1 });
      expect(updateManySpy).toHaveBeenCalledTimes(1);
      expect(saveSpy).toHaveBeenCalledTimes(1);
      expect(deleteSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ── SnapshotStrategy ──────────────────────────────────────────

  describe("SnapshotStrategy", () => {
    const strategy = new SnapshotStrategy();

    it("should deep clone values in snapshot", () => {
      const obj = { id: 1, data: { nested: true }, items: [1, 2, 3] };
      const snap = strategy.snapshot(obj, ["id", "data", "items"]);

      // Should be equal but not the same reference
      expect(snap.data).toEqual(obj.data);
      expect(snap.data).not.toBe(obj.data);
      expect(snap.items).toEqual(obj.items);
      expect(snap.items).not.toBe(obj.items);
    });

    it("should return null when nothing changed", () => {
      const obj = { id: 1, name: "Alice", email: "a@b.c" };
      const snap = strategy.snapshot(obj, ["id", "name", "email"]);

      const diff = strategy.diff(obj, snap, ["id", "name", "email"], ["id"]);
      expect(diff).toBeNull();
    });

    it("should return only changed fields", () => {
      const obj = { id: 1, name: "Alice", email: "a@b.c" };
      const snap = strategy.snapshot(obj, ["id", "name", "email"]);

      obj.name = "Bob";

      const diff = strategy.diff(obj, snap, ["id", "name", "email"], ["id"]);
      expect(diff).toEqual({ name: "Bob" });
    });
  });

  // ── cloneValue ────────────────────────────────────────────────

  describe("cloneValue()", () => {
    it("should clone primitives", () => {
      expect(cloneValue(42)).toBe(42);
      expect(cloneValue("hello")).toBe("hello");
      expect(cloneValue(null)).toBeNull();
      expect(cloneValue(undefined)).toBeUndefined();
      expect(cloneValue(true)).toBe(true);
    });

    it("should clone Date", () => {
      const d = new Date("2025-01-01");
      const cloned = cloneValue(d);
      expect(cloned).toEqual(d);
      expect(cloned).not.toBe(d);
    });

    it("should clone objects", () => {
      const obj = { a: 1, b: { c: 2 } };
      const cloned = cloneValue(obj);
      expect(cloned).toEqual(obj);
      expect(cloned).not.toBe(obj);
    });

    it("should clone arrays", () => {
      const arr = [1, 2, [3, 4]];
      const cloned = cloneValue(arr);
      expect(cloned).toEqual(arr);
      expect(cloned).not.toBe(arr);
    });
  });

  // ── deepEquals ────────────────────────────────────────────────

  describe("deepEquals()", () => {
    it("should handle primitives", () => {
      expect(deepEquals(1, 1)).toBe(true);
      expect(deepEquals(1, 2)).toBe(false);
      expect(deepEquals("a", "a")).toBe(true);
      expect(deepEquals(null, null)).toBe(true);
      expect(deepEquals(null, undefined)).toBe(false);
    });

    it("should handle Dates", () => {
      expect(deepEquals(new Date("2025-01-01"), new Date("2025-01-01"))).toBe(true);
      expect(deepEquals(new Date("2025-01-01"), new Date("2025-01-02"))).toBe(false);
    });

    it("should handle objects", () => {
      expect(deepEquals({ a: 1 }, { a: 1 })).toBe(true);
      expect(deepEquals({ a: 1 }, { a: 2 })).toBe(false);
      expect(deepEquals({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    });

    it("should handle arrays", () => {
      expect(deepEquals([1, 2], [1, 2])).toBe(true);
      expect(deepEquals([1, 2], [1, 3])).toBe(false);
      expect(deepEquals([1, 2], [1, 2, 3])).toBe(false);
    });

    it("should handle nested structures", () => {
      expect(deepEquals({ a: { b: [1, 2] } }, { a: { b: [1, 2] } })).toBe(true);
      expect(deepEquals({ a: { b: [1, 2] } }, { a: { b: [1, 3] } })).toBe(false);
    });
  });
});
