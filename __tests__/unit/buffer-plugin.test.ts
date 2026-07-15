/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";
import { OrmError } from "../../src/errors/OrmError";
import { bufferPlugin } from "../../src/core/plugin/buffer/bufferPlugin";
import { WriteBuffer } from "../../src/core/plugin/buffer/WriteBuffer";
import {
  SnapshotStrategy,
  cloneValue,
  deepEquals,
} from "../../src/core/plugin/buffer/BufferStrategy";
import { EntityState } from "../../src/core/plugin/buffer/EntityUnitState";
import { topologicalSort, sortForInsert, sortForDelete, buildTopologicalIndexMap, sortByIndex } from "../../src/core/plugin/buffer/DependencyGraph";
import { snapshotCollections, diffCollection } from "../../src/core/plugin/buffer/CollectionTracker";
import { ChangeTrackingPolicy, FlushMode, LockMode, FlushEvent } from "../../src/core/plugin/buffer/BufferPreview";
import { createPersistentCollection, isPersistentCollection } from "../../src/core/plugin/buffer/PersistentCollection";
import { COLUMN_TOKEN } from "../../src/decorators/Column";
import { ENTITY_TOKEN } from "../../src/decorators/Entity";
import { ONE_TO_MANY_TOKEN } from "../../src/decorators/OneToMany";
import { MANY_TO_ONE_TOKEN } from "../../src/decorators/ManyToOne";
import { MANY_TO_MANY_TOKEN } from "../../src/decorators/ManyToMany";
import { ONE_TO_ONE_TOKEN } from "../../src/decorators/OneToOne";
import { VERSION_TOKEN } from "../../src/decorators/Version";
import { CREATE_TIMESTAMP_TOKEN } from "../../src/decorators/CreateTimestamp";
import { UPDATE_TIMESTAMP_TOKEN } from "../../src/decorators/UpdateTimestamp";
import { VALIDATION_TOKEN, ValidationMetadata } from "../../src/decorators/Validation";
import { ValidationError } from "../../src/errors/ValidationError";

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

// ── Entities with Relations (for cascade tests) ─────────────────

class Post {
  id!: number;
  title!: string;
  comments!: Comment[];
}

Reflect.defineMetadata(ENTITY_TOKEN, { name: "Post", tableName: "posts" }, Post);
Reflect.defineMetadata(
  COLUMN_TOKEN,
  [
    { target: Post, name: "id", propertyKey: "id", type: Number, options: { primary: true, autoIncrement: true } },
    { target: Post, name: "title", propertyKey: "title", type: String, options: {} },
  ],
  Post.prototype,
);
// @OneToMany(() => Comment, { mappedBy: "post", cascade: ["insert", "update"] })
Reflect.defineMetadata(
  ONE_TO_MANY_TOKEN,
  [{
    target: Post,
    propertyKey: "comments",
    getRelatedEntity: () => Comment,
    mappedBy: "post",
    cascade: ["insert", "update"],
  }],
  Post,
);

// Set up @ManyToOne metadata on Comment for FK resolution
// Comment.post → joinColumn: "postId"
Reflect.defineMetadata(
  MANY_TO_ONE_TOKEN,
  [{
    target: Comment,
    type: Post,
    columnName: "post",
    joinColumn: "postId",
    getMappingEntity: () => Post,
    getMappingProperty: (e: any) => e.post,
    option: {},
  }],
  Comment,
);

// ── Entities for M2M / O2O tests ──────────────────────────────────

class Article {
  id!: number;
  title!: string;
  tags!: Tag[];
}

Reflect.defineMetadata(ENTITY_TOKEN, { name: "Article", tableName: "articles" }, Article);
Reflect.defineMetadata(
  COLUMN_TOKEN,
  [
    { target: Article, name: "id", propertyKey: "id", type: Number, options: { primary: true, autoIncrement: true } },
    { target: Article, name: "title", propertyKey: "title", type: String, options: {} },
  ],
  Article.prototype,
);
// @ManyToMany(() => Tag, { joinTable: { name: "article_tags", joinColumn: "article_id", inverseJoinColumn: "tag_id" } })
Reflect.defineMetadata(
  MANY_TO_MANY_TOKEN,
  [{
    target: Article,
    propertyKey: "tags",
    getRelatedEntity: () => Tag,
    joinTable: { name: "article_tags", joinColumn: "article_id", inverseJoinColumn: "tag_id" },
  }],
  Article,
);

// Tag inverse side (no joinTable, has mappedBy)
Reflect.defineMetadata(
  MANY_TO_MANY_TOKEN,
  [{
    target: Tag,
    propertyKey: "articles",
    getRelatedEntity: () => Article,
    mappedBy: "tags",
  }],
  Tag,
);

// 3-level entity hierarchy: Category → Post → Comment (for topological sort tests)
class Category {
  id!: number;
  name!: string;
}

Reflect.defineMetadata(ENTITY_TOKEN, { name: "Category", tableName: "categories" }, Category);
Reflect.defineMetadata(
  COLUMN_TOKEN,
  [
    { target: Category, name: "id", propertyKey: "id", type: Number, options: { primary: true, autoIncrement: true } },
    { target: Category, name: "name", propertyKey: "name", type: String, options: {} },
  ],
  Category.prototype,
);

// Post has @ManyToOne → Category
Reflect.defineMetadata(
  MANY_TO_ONE_TOKEN,
  [
    ...(Reflect.getMetadata(MANY_TO_ONE_TOKEN, Post) ?? []),
    {
      target: Post,
      type: Category,
      columnName: "category",
      joinColumn: "categoryId",
      getMappingEntity: () => Category,
      getMappingProperty: (e: any) => e.category,
      option: {},
    },
  ],
  Post,
);

// ── Entities with @Version (optimistic locking) ─────────────────

class VersionedProduct {
  id!: number;
  name!: string;
  price!: number;
  version!: number;
}

Reflect.defineMetadata(ENTITY_TOKEN, { name: "VersionedProduct", tableName: "versioned_products" }, VersionedProduct);
Reflect.defineMetadata(
  COLUMN_TOKEN,
  [
    { target: VersionedProduct, name: "id", propertyKey: "id", type: Number, options: { primary: true, autoIncrement: true } },
    { target: VersionedProduct, name: "name", propertyKey: "name", type: String, options: {} },
    { target: VersionedProduct, name: "price", propertyKey: "price", type: Number, options: {} },
    { target: VersionedProduct, name: "version", propertyKey: "version", type: Number, options: { nullable: false } },
  ],
  VersionedProduct.prototype,
);
// @Version() metadata
Reflect.defineMetadata(VERSION_TOKEN, "version", VersionedProduct);

// ── Entities with @CreateTimestamp / @UpdateTimestamp ────────────

class AuditableItem {
  id!: number;
  title!: string;
  createdAt!: Date;
  updatedAt!: Date;
}

Reflect.defineMetadata(ENTITY_TOKEN, { name: "AuditableItem", tableName: "auditable_items" }, AuditableItem);
Reflect.defineMetadata(
  COLUMN_TOKEN,
  [
    { target: AuditableItem, name: "id", propertyKey: "id", type: Number, options: { primary: true, autoIncrement: true } },
    { target: AuditableItem, name: "title", propertyKey: "title", type: String, options: {} },
    { target: AuditableItem, name: "createdAt", propertyKey: "createdAt", type: Date, options: { nullable: false } },
    { target: AuditableItem, name: "updatedAt", propertyKey: "updatedAt", type: Date, options: { nullable: false } },
  ],
  AuditableItem.prototype,
);
Reflect.defineMetadata(CREATE_TIMESTAMP_TOKEN, "createdAt", AuditableItem);
Reflect.defineMetadata(UPDATE_TIMESTAMP_TOKEN, "updatedAt", AuditableItem);

// ── Entities with @Validation ───────────────────────────────────

class ValidatedUser {
  id!: number;
  name!: string;
  age!: number;
}

Reflect.defineMetadata(ENTITY_TOKEN, { name: "ValidatedUser", tableName: "validated_users" }, ValidatedUser);
Reflect.defineMetadata(
  COLUMN_TOKEN,
  [
    { target: ValidatedUser, name: "id", propertyKey: "id", type: Number, options: { primary: true, autoIncrement: true } },
    { target: ValidatedUser, name: "name", propertyKey: "name", type: String, options: {} },
    { target: ValidatedUser, name: "age", propertyKey: "age", type: Number, options: {} },
  ],
  ValidatedUser.prototype,
);
// @NotNull on name, @Min(0) on age
Reflect.defineMetadata(
  VALIDATION_TOKEN,
  [
    { propertyKey: "name", constraint: "notNull", message: "name must not be null or undefined" },
    { propertyKey: "name", constraint: "minLength", value: 1, message: "name must be at least 1 characters long" },
    { propertyKey: "age", constraint: "min", value: 0, message: "age must be at least 0" },
  ] as ValidationMetadata[],
  ValidatedUser,
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
  return em.extend(bufferPlugin());
}

// ── Tests ───────────────────────────────────────────────────────

describe("Buffer Plugin", () => {
  // ── Installation & Stub ───────────────────────────────────────

  describe("installation", () => {
    it("should allow em.buffer() after installing buffer plugin", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();
      expect(mut).toBeInstanceOf(WriteBuffer);
    });

    it("should throw BUFFER_NOT_INSTALLED when plugin is not installed", () => {
      const em = new EntityManager();
      expect(() => em.buffer()).toThrow(OrmError);
      try {
        em.buffer();
      } catch (err: any) {
        expect(err.code).toBe(OrmErrorCode.BUFFER_NOT_INSTALLED);
      }
    });

    it("should return independent WriteBuffer instances per mutate() call", () => {
      const em = createExtendedEm(User);
      const mut1 = em.buffer();
      const mut2 = em.buffer();
      expect(mut1).not.toBe(mut2);
    });
  });

  // ── track() ───────────────────────────────────────────────────

  describe("track()", () => {
    it("should store snapshot at track time", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);

      expect(mut.tracked()).toEqual([user]);
      expect(mut.dirty()).toEqual([]); // no changes yet
    });

    it("should throw for non-entity instances", () => {
      class NotAnEntity { x = 1; }
      const em = createExtendedEm(User);
      const mut = em.buffer();

      expect(() => mut.track(new NotAnEntity())).toThrow(/not a registered entity/);
    });

    it("should throw when PK value is undefined", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const user = Object.assign(new User(), { id: undefined, name: "Alice", email: "a@b.c" });
      expect(() => mut.track(user)).toThrow(/PK column "id" is undefined/);
    });

    it("should throw when PK value is null", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const user = Object.assign(new User(), { id: null, name: "Alice", email: "a@b.c" });
      expect(() => mut.track(user)).toThrow(/PK column "id" is null/);
    });

    it("should be idempotent (same instance tracked twice)", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);
      mut.track(user); // no error

      expect(mut.tracked()).toHaveLength(1);
    });

    it("should infer entity class from instance.constructor", () => {
      const em = createExtendedEm(User, Comment);
      const mut = em.buffer();

      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      const comment = Object.assign(new Comment(), { id: 1, body: "hi", postId: 1 });

      mut.track(user);
      mut.track(comment);

      expect(mut.tracked()).toHaveLength(2);
    });

    it("should support composite PK entities", () => {
      const em = createExtendedEm(OrderItem);
      const mut = em.buffer();

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

      const mut = em.buffer();
      const result = await mut.findOne(User, { where: { id: 1 } as any });

      expect(result).toBe(mockUser);
      expect(mut.tracked()).toEqual([mockUser]);
    });

    it("findOne() should return null and not track when not found", async () => {
      const em = createExtendedEm(User);
      jest.spyOn(em, "findOne").mockResolvedValue(null);

      const mut = em.buffer();
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

      const mut = em.buffer();
      const result = await mut.find(User, { where: { name: "Alice" } as any });

      expect(result).toEqual(users);
      expect(mut.tracked()).toHaveLength(2);
    });

    it("find() should return empty array and not track when no results", async () => {
      const em = createExtendedEm(User);
      jest.spyOn(em, "find").mockResolvedValue([]);

      const mut = em.buffer();
      const result = await mut.find(User);

      expect(result).toEqual([]);
      expect(mut.tracked()).toHaveLength(0);
    });

    it("findOne() + modify + flush should update DB", async () => {
      const em = createExtendedEm(User);
      const mockUser = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      jest.spyOn(em, "findOne").mockResolvedValue(mockUser);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      const saveSpy = jest.spyOn(em, "save").mockResolvedValue(mockUser as any);

      const mut = em.buffer();
      const user = await mut.findOne(User, { where: { id: 1 } as any });
      user!.name = "Updated";

      const result = await mut.flush();

      expect(result.updates).toBe(1);
      // flush extracts column-only data, so save gets a plain object
      expect(saveSpy).toHaveBeenCalledWith(User, { id: 1, name: "Updated", email: "a@b.c" });
    });
  });

  // ── Identity Map ───────────────────────────────────────────────

  describe("Identity Map", () => {
    it("findOne() twice with same PK should return same instance", async () => {
      const em = createExtendedEm(User);
      const dbUser = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      jest.spyOn(em, "findOne").mockResolvedValue(dbUser);

      const mut = em.buffer();
      const first = await mut.findOne(User, { where: { id: 1 } as any });

      // Second call returns a fresh DB object, but identity map should return the cached one
      const dbUser2 = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      jest.spyOn(em, "findOne").mockResolvedValue(dbUser2);
      const second = await mut.findOne(User, { where: { id: 1 } as any });

      expect(first).toBe(second); // same reference
      expect(mut.tracked()).toHaveLength(1); // not duplicated
    });

    it("find() should return cached instances for already-tracked PKs", async () => {
      const em = createExtendedEm(User);
      const u1 = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      jest.spyOn(em, "findOne").mockResolvedValue(u1);

      const mut = em.buffer();
      const tracked = await mut.findOne(User, { where: { id: 1 } as any });
      tracked!.name = "Modified"; // modify the tracked instance

      // find() returns fresh DB instances
      const freshU1 = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      const freshU2 = Object.assign(new User(), { id: 2, name: "Bob", email: "b@c.d" });
      jest.spyOn(em, "find").mockResolvedValue([freshU1, freshU2]);

      const results = await mut.find(User);

      // id=1 should be the tracked (modified) instance, not the fresh one
      expect(results[0]).toBe(tracked);
      expect(results[0].name).toBe("Modified");
      // id=2 is new, tracked as-is
      expect(results[1]).toBe(freshU2);
      expect(mut.tracked()).toHaveLength(2);
    });

    it("track() should throw when different instance with same PK is already tracked", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const user1 = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      const user2 = Object.assign(new User(), { id: 1, name: "Bob", email: "b@c.d" });

      mut.track(user1);
      expect(() => mut.track(user2)).toThrow(/Identity conflict/);
    });

    it("untrack() should remove from Identity Map, allowing re-track of same PK", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const user1 = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      const user2 = Object.assign(new User(), { id: 1, name: "Bob", email: "b@c.d" });

      mut.track(user1);
      mut.untrack(user1);
      mut.track(user2); // should not throw

      expect(mut.tracked()).toEqual([user2]);
    });

    it("clear() should clear Identity Map", async () => {
      const em = createExtendedEm(User);
      const dbUser = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      jest.spyOn(em, "findOne").mockResolvedValue(dbUser);

      const mut = em.buffer();
      await mut.findOne(User, { where: { id: 1 } as any });
      mut.clear();

      // After clear, a new instance with the same PK should be trackable
      const newUser = Object.assign(new User(), { id: 1, name: "New", email: "new@b.c" });
      mut.track(newUser); // should not throw
      expect(mut.tracked()).toEqual([newUser]);
    });

    it("composite PK Identity Map key should work correctly", () => {
      const em = createExtendedEm(OrderItem);
      const mut = em.buffer();

      const item1 = Object.assign(new OrderItem(), { orderId: 1, productId: 2, quantity: 5 });
      const item2 = Object.assign(new OrderItem(), { orderId: 1, productId: 3, quantity: 10 });
      const item1dup = Object.assign(new OrderItem(), { orderId: 1, productId: 2, quantity: 99 });

      mut.track(item1);
      mut.track(item2); // different composite PK, OK

      expect(() => mut.track(item1dup)).toThrow(/Identity conflict/);
      expect(mut.tracked()).toHaveLength(2);
    });

    // ── First-level cache (skip DB on PK lookup) ──────────────────

    it("findOne() with PK-only where should skip DB when entity is in identity map", async () => {
      const em = createExtendedEm(User);
      const dbUser = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      const findOneSpy = jest.spyOn(em, "findOne").mockResolvedValue(dbUser);

      const buf = em.buffer();
      const first = await buf.findOne(User, { where: { id: 1 } as any });
      expect(findOneSpy).toHaveBeenCalledTimes(1);

      // Second call: should NOT hit DB
      const second = await buf.findOne(User, { where: { id: 1 } as any });
      expect(findOneSpy).toHaveBeenCalledTimes(1); // still 1
      expect(second).toBe(first);
    });

    it("findOne() with relations should still hit DB even if PK is cached", async () => {
      const em = createExtendedEm(User);
      const dbUser = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      const findOneSpy = jest.spyOn(em, "findOne").mockResolvedValue(dbUser);

      const buf = em.buffer();
      await buf.findOne(User, { where: { id: 1 } as any });

      await buf.findOne(User, { where: { id: 1 } as any, relations: ["posts"] as any });
      expect(findOneSpy).toHaveBeenCalledTimes(2);
    });

    it("findOne() with filter operators should always hit DB", async () => {
      const em = createExtendedEm(User);
      const dbUser = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      const findOneSpy = jest.spyOn(em, "findOne").mockResolvedValue(dbUser);

      const buf = em.buffer();
      await buf.findOne(User, { where: { id: 1 } as any });

      await buf.findOne(User, { where: { id: { gt: 0 } } as any });
      expect(findOneSpy).toHaveBeenCalledTimes(2);
    });

    it("findOne() cache works with composite PK", async () => {
      const em = createExtendedEm(OrderItem);
      const item = Object.assign(new OrderItem(), { orderId: 1, productId: 2, quantity: 10 });
      const findOneSpy = jest.spyOn(em, "findOne").mockResolvedValue(item);

      const buf = em.buffer();
      await buf.findOne(OrderItem, { where: { orderId: 1, productId: 2 } as any });
      await buf.findOne(OrderItem, { where: { orderId: 1, productId: 2 } as any });

      expect(findOneSpy).toHaveBeenCalledTimes(1);
    });

    it("findOne() with PK not in identity map should still hit DB", async () => {
      const em = createExtendedEm(User);
      const dbUser1 = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      const dbUser2 = Object.assign(new User(), { id: 2, name: "Bob", email: "b@c.d" });
      const findOneSpy = jest.spyOn(em, "findOne")
        .mockResolvedValueOnce(dbUser1)
        .mockResolvedValueOnce(dbUser2);

      const buf = em.buffer();
      await buf.findOne(User, { where: { id: 1 } as any });
      await buf.findOne(User, { where: { id: 2 } as any });

      expect(findOneSpy).toHaveBeenCalledTimes(2);
    });

    it("findOne() with non-PK where should always hit DB", async () => {
      const em = createExtendedEm(User);
      const dbUser = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      const findOneSpy = jest.spyOn(em, "findOne").mockResolvedValue(dbUser);

      const buf = em.buffer();
      await buf.findOne(User, { where: { id: 1 } as any });

      // Query by name (not a PK column)
      await buf.findOne(User, { where: { name: "Alice" } as any });
      expect(findOneSpy).toHaveBeenCalledTimes(2);
    });

    it("findOne() cache should be bypassed after clear()", async () => {
      const em = createExtendedEm(User);
      const dbUser = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      const findOneSpy = jest.spyOn(em, "findOne").mockResolvedValue(dbUser);

      const buf = em.buffer();
      await buf.findOne(User, { where: { id: 1 } as any });
      buf.clear();

      await buf.findOne(User, { where: { id: 1 } as any });
      expect(findOneSpy).toHaveBeenCalledTimes(2);
    });

    it("findOne() cache should be bypassed after untrack()", async () => {
      const em = createExtendedEm(User);
      const dbUser = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      const findOneSpy = jest.spyOn(em, "findOne").mockResolvedValue(dbUser);

      const buf = em.buffer();
      const user = await buf.findOne(User, { where: { id: 1 } as any });
      buf.untrack(user!);

      await buf.findOne(User, { where: { id: 1 } as any });
      expect(findOneSpy).toHaveBeenCalledTimes(2);
    });
  });

  // ── dirty() ───────────────────────────────────────────────────

  describe("dirty()", () => {
    it("should return empty when nothing changed", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);

      expect(mut.dirty()).toEqual([]);
    });

    it("should detect property changes", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);
      user.name = "Bob";

      expect(mut.dirty()).toEqual([user]);
    });

    it("should detect Date field changes", () => {
      const em = createExtendedEm(Profile);
      const mut = em.buffer();

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
      const mut = em.buffer();

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
      const mut = em.buffer();

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
      const mut = em.buffer();

      mut.save(Comment, { body: "new comment", postId: 1 });

      expect(mut.size().inserts).toBe(1);
    });

    it("should queue DELETE operations", () => {
      const em = createExtendedEm(Tag);
      const mut = em.buffer();

      mut.delete(Tag, { id: 5 });

      expect(mut.size().deletes).toBe(1);
    });

    it("should throw for non-entity class in save()", () => {
      class NotAnEntity {}
      const em = createExtendedEm(User);
      const mut = em.buffer();

      expect(() => mut.save(NotAnEntity as any, { name: "x" })).toThrow(/not a registered entity/);
    });

    it("should throw for non-entity class in delete()", () => {
      class NotAnEntity {}
      const em = createExtendedEm(User);
      const mut = em.buffer();

      expect(() => mut.delete(NotAnEntity as any, { id: 1 })).toThrow(/not a registered entity/);
    });
  });

  // ── preview() ─────────────────────────────────────────────────

  describe("preview()", () => {
    it("should respect flush order: updates → inserts → deletes", () => {
      const em = createExtendedEm(User, Comment, Tag);
      const mut = em.buffer();

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
      const mut = em.buffer();

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
      const mut = em.buffer();

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
      jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => data);

      const mut = em.buffer();
      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);
      user.name = "Bob";

      await mut.flush();

      expect(transactionSpy).toHaveBeenCalledTimes(1);
      transactionSpy.mockRestore();
    });

    it("should call em.save() for dirty tracked entities (supports @Version)", async () => {
      const em = createExtendedEm(User);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      const saveSpy = jest.spyOn(em, "save").mockResolvedValue({} as any);

      const mut = em.buffer();
      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);
      user.name = "Bob";

      await mut.flush();

      // flush extracts column-only data
      expect(saveSpy).toHaveBeenCalledWith(User, { id: 1, name: "Bob", email: "a@b.c" });
      saveSpy.mockRestore();
    });

    it("should call em.save() for queued inserts", async () => {
      const em = createExtendedEm(Comment);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      const saveSpy = jest.spyOn(em, "save").mockResolvedValue({} as any);

      const mut = em.buffer();
      mut.save(Comment, { body: "new", postId: 1 });

      await mut.flush();

      expect(saveSpy).toHaveBeenCalledWith(Comment, { body: "new", postId: 1 });
      saveSpy.mockRestore();
    });

    it("should call em.delete() for queued deletes", async () => {
      const em = createExtendedEm(Tag);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      const deleteSpy = jest.spyOn(em, "delete").mockResolvedValue({ affected: 1 });

      const mut = em.buffer();
      mut.delete(Tag, { id: 5 });

      await mut.flush();

      expect(deleteSpy).toHaveBeenCalledWith(Tag, { id: 5 });
      deleteSpy.mockRestore();
    });

    it("should execute in order: updates → inserts → deletes", async () => {
      const em = createExtendedEm(User, Comment, Tag);
      const callOrder: string[] = [];

      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      // save() is called for both updates (tracked entities) and inserts (queued data).
      // Distinguish by checking if the data has an assigned PK (update) or not (insert).
      jest.spyOn(em, "save").mockImplementation(async (_entity: any, data: any) => {
        callOrder.push(data.id !== undefined ? "update" : "insert");
        return data;
      });
      jest.spyOn(em, "delete").mockImplementation(async () => {
        callOrder.push("delete");
        return { affected: 1 };
      });

      const mut = em.buffer();

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
      jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => data);

      const mut = em.buffer();
      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);
      user.name = "Bob";

      await mut.flush();

      // After flush, "Bob" is the new snapshot — no longer dirty
      expect(mut.dirty()).toEqual([]);
      expect(mut.tracked()).toEqual([user]);
    });

    it("should sync auto-updated columns (version, timestamps) back to tracked instance", async () => {
      const em = createExtendedEm(User);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      // Simulate DB returning updated version/timestamp
      jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data,
        id: data.id,
        name: data.name,
        email: data.email,
        // Simulate a @Version column increment (if the entity had one)
      }));

      const mut = em.buffer();
      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);
      user.name = "Bob";

      await mut.flush();

      // The tracked instance should have the values returned by save()
      expect(user.name).toBe("Bob");
      expect(user.email).toBe("a@b.c");
    });

    it("should clear tracked state when retainAfterFlush is false", async () => {
      const em = createEmWithEntities(User);
      const extended = em.extend(bufferPlugin({ retainAfterFlush: false }));
      jest.spyOn(extended, "transaction").mockImplementation(async (cb) => cb(extended as any));
      jest.spyOn(extended, "save").mockImplementation(async (_e: any, data: any) => data);

      const mut = extended.buffer();
      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);
      user.name = "Bob";

      await mut.flush();

      expect(mut.tracked()).toEqual([]);
    });

    it("should preserve state on flush failure (retry possible)", async () => {
      const em = createExtendedEm(User, Comment);
      jest.spyOn(em, "transaction").mockRejectedValue(new Error("DB error"));

      const mut = em.buffer();
      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);
      user.name = "Bob";
      mut.save(Comment, { body: "new", postId: 1 });

      await expect(mut.flush()).rejects.toThrow("DB error");

      // State preserved for retry
      expect(mut.dirty()).toEqual([user]);
      expect(mut.size().inserts).toBe(1);
    });

    it("should return correct BufferFlushResult counts", async () => {
      const em = createExtendedEm(User, Comment, Tag);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => data);
      jest.spyOn(em, "delete").mockResolvedValue({ affected: 1 });

      const mut = em.buffer();
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

      const mut = em.buffer();
      const result = await mut.flush();

      expect(result).toEqual({ updates: 0, inserts: 0, deletes: 0 });
      expect(transactionSpy).not.toHaveBeenCalled();
    });

    it("should be a no-op when tracked entities are not dirty", async () => {
      const em = createExtendedEm(User);
      const transactionSpy = jest.spyOn(em, "transaction");

      const mut = em.buffer();
      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);
      // no changes to user

      const result = await mut.flush();

      expect(result).toEqual({ updates: 0, inserts: 0, deletes: 0 });
      expect(transactionSpy).not.toHaveBeenCalled();
    });
  });

  // ── clear() / untrack() / size() ──────────────────────────────

  describe("clear(), untrack(), size()", () => {
    it("should clear all state", () => {
      const em = createExtendedEm(User, Comment, Tag);
      const mut = em.buffer();

      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);
      mut.save(Comment, { body: "new", postId: 1 });
      mut.delete(Tag, { id: 5 });

      mut.clear();

      expect(mut.tracked()).toEqual([]);
      expect(mut.size()).toEqual({ tracked: 0, inserts: 0, deletes: 0, persists: 0, bulkUpdates: 0, bulkDeletes: 0, identityMap: 0 });
    });

    it("should untrack a specific entity", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

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
      const saveSpy = jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => data);
      const deleteSpy = jest.spyOn(em, "delete").mockResolvedValue({ affected: 1 });

      const mut = em.buffer();

      // Track and modify
      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);
      user.name = "Updated";

      // Queue operations
      mut.save(Comment, { body: "c1", postId: 1 });
      mut.delete(Tag, { id: 3 });

      const result = await mut.flush();

      expect(result).toEqual({ updates: 1, inserts: 1, deletes: 1 });
      expect(saveSpy).toHaveBeenCalledTimes(2); // 1 update + 1 insert
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

  // ── persist() ──────────────────────────────────────────────────

  describe("persist()", () => {
    it("should add new entity (no PK) to persistQueue", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const user = new User();
      user.name = "Alice";
      user.email = "a@b.c";

      mut.persist(user);

      expect(mut.size().persists).toBe(1);
      expect(mut.tracked()).toHaveLength(0); // not tracked yet
    });

    it("should delegate to track() when instance has PK", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.persist(user);

      expect(mut.size().persists).toBe(0);
      expect(mut.tracked()).toHaveLength(1);
    });

    it("should be idempotent (same reference twice)", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const user = new User();
      user.name = "Alice";
      user.email = "a@b.c";

      mut.persist(user);
      mut.persist(user);

      expect(mut.size().persists).toBe(1);
    });

    // ── Same-ID semantics ───────────────────────────────────────

    it("persist() with two different instances sharing the same PK should throw Identity conflict", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const u1 = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      const u2 = Object.assign(new User(), { id: 1, name: "Bob", email: "b@c.d" });

      mut.persist(u1); // delegates to track() since PK is set
      expect(() => mut.persist(u2)).toThrow(/Identity conflict/);

      // u1 remains the canonical tracked instance
      expect(mut.tracked()).toEqual([u1]);
    });

    it("persist() should queue distinct no-PK instances independently (each INSERT separately)", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const u1 = new User();
      u1.name = "Alice";
      u1.email = "a@b.c";
      const u2 = new User();
      u2.name = "Alice"; // same data, different object
      u2.email = "a@b.c";

      mut.persist(u1);
      mut.persist(u2);

      expect(mut.size().persists).toBe(2);
      expect(mut.getState(u1)).toBe(EntityState.NEW);
      expect(mut.getState(u2)).toBe(EntityState.NEW);
    });

    it("re-persist after flush should be idempotent (already MANAGED, no extra INSERT)", async () => {
      const em = createExtendedEm(User);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      const saveSpy = jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data, id: 7,
      }));

      const mut = em.buffer();
      const user = new User();
      user.name = "Alice";
      user.email = "a@b.c";

      mut.persist(user);
      await mut.flush();
      expect(saveSpy).toHaveBeenCalledTimes(1);
      expect(user.id).toBe(7);
      expect(mut.getState(user)).toBe(EntityState.MANAGED);

      // Same instance, now has PK from flush — should route to track() and be a no-op
      mut.persist(user);

      expect(mut.size().persists).toBe(0);
      expect(mut.tracked()).toEqual([user]);

      // No new flush work scheduled — instance is clean (just snapshotted)
      const result = await mut.flush();
      expect(result).toEqual({ updates: 0, inserts: 0, deletes: 0 });
      expect(saveSpy).toHaveBeenCalledTimes(1); // still 1, no extra INSERT
    });

    it("untrack() then persist() with a different instance of the same PK should succeed", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const u1 = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      const u2 = Object.assign(new User(), { id: 1, name: "Bob", email: "b@c.d" });

      mut.persist(u1);
      mut.untrack(u1);
      expect(() => mut.persist(u2)).not.toThrow();

      expect(mut.tracked()).toEqual([u2]);
    });

    it("detachByPk() then persist() with a different instance of the same PK should succeed", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const u1 = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      const u2 = Object.assign(new User(), { id: 1, name: "Bob", email: "b@c.d" });

      mut.persist(u1);
      mut.detachByPk(User, 1);
      expect(() => mut.persist(u2)).not.toThrow();

      expect(mut.tracked()).toEqual([u2]);
      expect(mut.getState(u1)).toBe(EntityState.DETACHED);
    });

    it("should throw for non-entity class", () => {
      class NotAnEntity { x = 1; }
      const em = createExtendedEm(User);
      const mut = em.buffer();

      expect(() => mut.persist(new NotAnEntity())).toThrow(/not a registered entity/);
    });

    it("flush() should INSERT persisted entities and write PK back", async () => {
      const em = createExtendedEm(User);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      let insertId = 100;
      jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data,
        id: insertId++,
      }));

      const mut = em.buffer();
      const user = new User();
      user.name = "Alice";
      user.email = "a@b.c";

      mut.persist(user);

      const result = await mut.flush();

      expect(result.inserts).toBe(1);
      expect(user.id).toBe(100); // PK written back
    });

    it("flush() + retainAfterFlush should auto-track persisted instances", async () => {
      const em = createExtendedEm(User);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data,
        id: 42,
      }));

      const mut = em.buffer();
      const user = new User();
      user.name = "Alice";
      user.email = "a@b.c";

      mut.persist(user);
      await mut.flush();

      // Now tracked with the generated PK
      expect(mut.tracked()).toContain(user);
      expect(user.id).toBe(42);
      expect(mut.dirty()).toEqual([]); // freshly snapshotted
    });

    it("flush() + retainAfterFlush:false should NOT auto-track", async () => {
      const em = createEmWithEntities(User);
      const extended = em.extend(bufferPlugin({ retainAfterFlush: false }));
      jest.spyOn(extended, "transaction").mockImplementation(async (cb) => cb(extended as any));
      jest.spyOn(extended, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data,
        id: 42,
      }));

      const mut = extended.buffer();
      const user = new User();
      user.name = "Alice";
      user.email = "a@b.c";

      mut.persist(user);
      await mut.flush();

      expect(mut.tracked()).toHaveLength(0);
      expect(user.id).toBe(42); // PK still written back
    });

    it("preview() should include persist entries as inserts", () => {
      const em = createExtendedEm(User, Comment);
      const mut = em.buffer();

      const user = new User();
      user.name = "Alice";
      user.email = "a@b.c";

      mut.persist(user);
      mut.save(Comment, { body: "hi", postId: 1 });

      const preview = mut.preview();
      expect(preview).toHaveLength(2);
      expect(preview[0]).toMatchObject({
        action: "insert",
        entity: "User",
        data: { name: "Alice", email: "a@b.c" },
      });
      expect(preview[1]).toMatchObject({
        action: "insert",
        entity: "Comment",
      });
    });

    it("clear() should clear persistQueue", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const user = new User();
      user.name = "Alice";
      user.email = "a@b.c";

      mut.persist(user);
      mut.clear();

      expect(mut.size().persists).toBe(0);
    });

    it("flush failure should preserve persistQueue for retry", async () => {
      const em = createExtendedEm(User);
      jest.spyOn(em, "transaction").mockRejectedValue(new Error("DB error"));

      const mut = em.buffer();
      const user = new User();
      user.name = "Alice";
      user.email = "a@b.c";

      mut.persist(user);

      await expect(mut.flush()).rejects.toThrow("DB error");
      expect(mut.size().persists).toBe(1);
    });
  });

  // ── remove() ──────────────────────────────────────────────────

  describe("remove()", () => {
    it("should queue DELETE for an untracked entity with PK", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.remove(user);

      expect(mut.size().deletes).toBe(1);
    });

    it("should untrack + queue DELETE for a tracked entity", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);
      mut.remove(user);

      expect(mut.tracked()).toHaveLength(0);
      expect(mut.size().deletes).toBe(1);
    });

    it("should cancel persist (not queue DELETE) when removing a persisted entity that later got PK", async () => {
      // Scenario: persist entity without PK, then assign PK manually, then remove
      // Since remove() checks persistQueue by reference, and the entity IS in persistQueue,
      // it should be removed from persistQueue without queueing a DELETE.
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const user = new User();
      user.name = "Alice";
      user.email = "a@b.c";

      mut.persist(user);
      expect(mut.size().persists).toBe(1);

      // Simulate PK assignment (e.g., user got ID from somewhere)
      user.id = 5;
      mut.remove(user);

      expect(mut.size().persists).toBe(0);
      expect(mut.size().deletes).toBe(0); // no DELETE queued
    });

    it("should cancel pending INSERT when removing a NEW entity without PK", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const user = new User();
      user.name = "Alice";
      user.email = "a@b.c";

      mut.persist(user);
      expect(mut.size().persists).toBe(1);

      // PK not generated yet — remove() must cancel the INSERT, not throw
      mut.remove(user);

      expect(mut.size().persists).toBe(0);
      expect(mut.size().deletes).toBe(0);
      expect(mut.getState(user)).toBe(EntityState.DETACHED);
    });

    it("persist() after remove() should cancel the queued DELETE", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);
      mut.remove(user);
      expect(mut.size().deletes).toBe(1);
      expect(mut.getState(user)).toBe(EntityState.REMOVED);

      mut.persist(user);

      expect(mut.size().deletes).toBe(0); // removal cancelled
      expect(mut.getState(user)).toBe(EntityState.MANAGED);
      expect(mut.tracked()).toContain(user);
    });

    it("persist() should not cancel criteria DELETEs with non-PK shapes", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      mut.delete(User, { name: "Alice" });
      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.persist(user);

      expect(mut.size().deletes).toBe(1);
    });

    it("should throw when PK is missing", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const user = new User();
      user.name = "Alice";
      user.email = "a@b.c";

      expect(() => mut.remove(user)).toThrow(/Cannot remove "User": PK "id" is undefined/);
    });

    it("should throw for non-entity class", () => {
      class NotAnEntity { x = 1; }
      const em = createExtendedEm(User);
      const mut = em.buffer();

      expect(() => mut.remove(new NotAnEntity())).toThrow(/not a registered entity/);
    });

    it("should build correct criteria from composite PK", async () => {
      const em = createExtendedEm(OrderItem);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      jest.spyOn(em, "find").mockResolvedValue([]);
      const deleteSpy = jest.spyOn(em, "delete").mockResolvedValue({ affected: 1 });

      const mut = em.buffer();
      const item = Object.assign(new OrderItem(), { orderId: 1, productId: 2, quantity: 5 });
      mut.remove(item);

      // Verify criteria via flush
      await mut.flush();
      expect(deleteSpy).toHaveBeenCalledWith(OrderItem, { orderId: 1, productId: 2 });
    });
  });

  // ── @Transactional integration (Issue #89) ─────────────────────

  describe("@Transactional integration", () => {
    it("flush() inside em.transaction() should reuse the existing transaction", async () => {
      const em = createExtendedEm(User);
      let transactionCallCount = 0;
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => {
        transactionCallCount++;
        return cb(em as any);
      });
      jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => data);

      const mut = em.buffer();
      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);
      user.name = "Bob";

      await mut.flush();

      // flush calls em.transaction once
      expect(transactionCallCount).toBe(1);
    });

    it("flush() without existing transaction should create its own", async () => {
      const em = createExtendedEm(User);
      const transactionSpy = jest.spyOn(em, "transaction").mockImplementation(
        async (cb) => cb(em as any),
      );
      jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => data);

      const mut = em.buffer();
      mut.save(User, { name: "Alice", email: "a@b.c" });

      await mut.flush();

      expect(transactionSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ── Cascade (Issue #90) ─────────────────────────────────────────

  describe("cascade", () => {
    it("persist parent + cascade:insert should auto-INSERT children", async () => {
      const em = createExtendedEm(Post, Comment);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      let insertId = 100;
      jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data,
        id: data.id ?? insertId++,
      }));

      const mut = em.buffer();

      const comment1 = Object.assign(new Comment(), { body: "first", postId: undefined as any });
      const comment2 = Object.assign(new Comment(), { body: "second", postId: undefined as any });

      const post = new Post();
      post.title = "Hello";
      post.comments = [comment1, comment2];

      mut.persist(post);
      const result = await mut.flush();

      // 1 parent insert + 2 child cascade inserts
      expect(result.inserts).toBe(3);
      // PK written back to parent
      expect(post.id).toBe(100);
      // FK + PK written back to children
      expect(comment1.postId).toBe(100);
      expect(comment1.id).toBe(101);
      expect(comment2.postId).toBe(100);
      expect(comment2.id).toBe(102);
    });

    it("tracked parent update + cascade should INSERT new children", async () => {
      const em = createExtendedEm(Post, Comment);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      let insertId = 200;
      jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data,
        id: data.id ?? insertId++,
      }));

      const mut = em.buffer();

      const post = Object.assign(new Post(), { id: 1, title: "Hello", comments: [] as Comment[] });
      mut.track(post);

      // Add new child after tracking
      const comment = Object.assign(new Comment(), { body: "new comment", postId: undefined as any });
      post.comments = [comment];
      post.title = "Updated";

      const result = await mut.flush();

      expect(result.updates).toBe(1);
      expect(result.inserts).toBe(1); // cascade child
      expect(comment.postId).toBe(1); // FK set
      expect(comment.id).toBe(200);   // PK written back
    });

    it("cascade:false option should skip cascade processing", async () => {
      const em = createEmWithEntities(Post, Comment);
      const extended = em.extend(bufferPlugin({ cascade: false }));
      jest.spyOn(extended, "transaction").mockImplementation(async (cb) => cb(extended as any));
      const saveSpy = jest.spyOn(extended, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data,
        id: data.id ?? 1,
      }));

      const mut = extended.buffer();

      const post = new Post();
      post.title = "Hello";
      post.comments = [Object.assign(new Comment(), { body: "child" })];

      mut.persist(post);
      const result = await mut.flush();

      expect(result.inserts).toBe(1); // only parent, no cascade
      expect(saveSpy).toHaveBeenCalledTimes(1);
    });

    it("should prevent infinite loop with visited set", async () => {
      const em = createExtendedEm(Post, Comment);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      let insertId = 300;
      jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data,
        id: data.id ?? insertId++,
      }));

      const mut = em.buffer();

      const comment = Object.assign(new Comment(), { body: "hi", postId: undefined as any });
      const post = new Post();
      post.title = "Hello";
      post.comments = [comment, comment]; // same ref twice in the array

      mut.persist(post);
      const result = await mut.flush();

      // comment should only be saved once (visited set prevents duplicate)
      expect(result.inserts).toBe(2); // 1 parent + 1 child (not 3)
    });

    it("should not cascade when children array is empty", async () => {
      const em = createExtendedEm(Post, Comment);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      const saveSpy = jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data,
        id: data.id ?? 1,
      }));

      const mut = em.buffer();

      const post = new Post();
      post.title = "Hello";
      post.comments = [];

      mut.persist(post);
      await mut.flush();

      expect(saveSpy).toHaveBeenCalledTimes(1); // only parent
    });

    it("should not cascade when children property is undefined", async () => {
      const em = createExtendedEm(Post, Comment);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      const saveSpy = jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data,
        id: data.id ?? 1,
      }));

      const mut = em.buffer();

      const post = new Post();
      post.title = "Hello";
      // comments is undefined (not set)

      mut.persist(post);
      await mut.flush();

      expect(saveSpy).toHaveBeenCalledTimes(1); // only parent
    });

    it("delete cascade should be handled by em.delete() (no extra logic needed)", async () => {
      const em = createExtendedEm(Post, Comment);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      const deleteSpy = jest.spyOn(em, "delete").mockResolvedValue({ affected: 1 });

      const mut = em.buffer();
      const post = Object.assign(new Post(), { id: 1, title: "Hello" });
      mut.remove(post);

      const result = await mut.flush();

      expect(result.deletes).toBe(1);
      expect(deleteSpy).toHaveBeenCalledWith(Post, { id: 1 });
    });
  });

  // ── Phase 1: Entity States ─────────────────────────────────────

  describe("EntityState (getState)", () => {
    it("should return DETACHED for unregistered instances", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();
      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      expect(mut.getState(user)).toBe(EntityState.DETACHED);
    });

    it("should return MANAGED after track()", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();
      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);
      expect(mut.getState(user)).toBe(EntityState.MANAGED);
    });

    it("should return NEW after persist() with no PK", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();
      const user = new User();
      user.name = "Alice";
      user.email = "a@b.c";
      mut.persist(user);
      expect(mut.getState(user)).toBe(EntityState.NEW);
    });

    it("should return MANAGED after persist() with PK (delegates to track)", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();
      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.persist(user);
      expect(mut.getState(user)).toBe(EntityState.MANAGED);
    });

    it("should return REMOVED after remove()", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();
      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.remove(user);
      expect(mut.getState(user)).toBe(EntityState.REMOVED);
    });

    it("should return DETACHED after untrack()", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();
      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);
      mut.untrack(user);
      expect(mut.getState(user)).toBe(EntityState.DETACHED);
    });

    it("should transition NEW → MANAGED after flush", async () => {
      const em = createExtendedEm(User);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data,
        id: 42,
      }));

      const mut = em.buffer();
      const user = new User();
      user.name = "Alice";
      user.email = "a@b.c";
      mut.persist(user);
      expect(mut.getState(user)).toBe(EntityState.NEW);

      await mut.flush();
      expect(mut.getState(user)).toBe(EntityState.MANAGED);
    });

    it("clear() should clear stateMap", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();
      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);
      mut.clear();
      expect(mut.getState(user)).toBe(EntityState.DETACHED);
    });
  });

  // ── Phase 1: computeChanges() ──────────────────────────────────

  describe("computeChanges()", () => {
    it("should return empty changeset when nothing to do", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();
      const changes = mut.computeChanges();
      expect(changes.inserts).toHaveLength(0);
      expect(changes.updates).toHaveLength(0);
      expect(changes.deletes).toHaveLength(0);
    });

    it("should include inserts, updates, and deletes", () => {
      const em = createExtendedEm(User, Comment, Tag);
      const mut = em.buffer();

      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);
      user.name = "Bob";

      const newUser = new User();
      newUser.name = "Charlie";
      newUser.email = "c@d.e";
      mut.persist(newUser);

      mut.delete(Tag, { id: 5 });

      const changes = mut.computeChanges();
      expect(changes.updates).toHaveLength(1);
      expect(changes.updates[0].entity).toBe(User);
      expect(changes.updates[0].data).toEqual({ name: "Bob" });

      expect(changes.inserts).toHaveLength(1);
      expect(changes.inserts[0].instance).toBe(newUser);

      expect(changes.deletes).toHaveLength(1);
      expect(changes.deletes[0].criteria).toEqual({ id: 5 });
    });
  });

  // ── Phase 2: Topological Sort ───────────────────────────────────

  describe("topologicalSort", () => {
    it("should sort parent before child (Category → Post → Comment)", () => {
      const sorted = topologicalSort([Comment, Post, Category]);
      const idx = (cls: any) => sorted.indexOf(cls);
      expect(idx(Category)).toBeLessThan(idx(Post));
      expect(idx(Post)).toBeLessThan(idx(Comment));
    });

    it("should handle entities with no relations", () => {
      const sorted = topologicalSort([Tag, User]);
      expect(sorted).toHaveLength(2);
      expect(sorted).toContain(Tag);
      expect(sorted).toContain(User);
    });

    it("should handle single entity", () => {
      const sorted = topologicalSort([User]);
      expect(sorted).toEqual([User]);
    });

    it("should fallback to original order on cycle", () => {
      // Create a synthetic cycle: A depends on B, B depends on A
      class CycleA { id!: number; }
      class CycleB { id!: number; }
      Reflect.defineMetadata(ENTITY_TOKEN, { name: "CycleA" }, CycleA);
      Reflect.defineMetadata(ENTITY_TOKEN, { name: "CycleB" }, CycleB);
      Reflect.defineMetadata(COLUMN_TOKEN, [{ name: "id", propertyKey: "id", options: { primary: true } }], CycleA.prototype);
      Reflect.defineMetadata(COLUMN_TOKEN, [{ name: "id", propertyKey: "id", options: { primary: true } }], CycleB.prototype);
      Reflect.defineMetadata(MANY_TO_ONE_TOKEN, [{
        target: CycleA, type: CycleB, columnName: "b", joinColumn: "bId",
        getMappingEntity: () => CycleB, getMappingProperty: (e: any) => e.b, option: {},
      }], CycleA);
      Reflect.defineMetadata(MANY_TO_ONE_TOKEN, [{
        target: CycleB, type: CycleA, columnName: "a", joinColumn: "aId",
        getMappingEntity: () => CycleA, getMappingProperty: (e: any) => e.a, option: {},
      }], CycleB);

      const sorted = topologicalSort([CycleA, CycleB]);
      // Should fallback to original order (not crash)
      expect(sorted).toEqual([CycleA, CycleB]);
    });

    it("sortForInsert should sort entries by parent-first order", () => {
      const entries = [
        { entity: Comment, data: {} },
        { entity: Post, data: {} },
        { entity: Category, data: {} },
      ];
      const sorted = sortForInsert(entries, [Category, Post, Comment]);
      const names = sorted.map(e => e.entity.name);
      expect(names.indexOf("Category")).toBeLessThan(names.indexOf("Post"));
      expect(names.indexOf("Post")).toBeLessThan(names.indexOf("Comment"));
    });

    it("sortForDelete should sort entries by child-first order", () => {
      const entries = [
        { entity: Category, criteria: {} },
        { entity: Post, criteria: {} },
        { entity: Comment, criteria: {} },
      ];
      const sorted = sortForDelete(entries, [Category, Post, Comment]);
      const names = sorted.map(e => e.entity.name);
      expect(names.indexOf("Comment")).toBeLessThan(names.indexOf("Post"));
      expect(names.indexOf("Post")).toBeLessThan(names.indexOf("Category"));
    });
  });

  // ── Phase 2: flush with topological order ───────────────────────

  describe("flush() topological order", () => {
    it("should insert parent before child", async () => {
      const em = createExtendedEm(Post, Comment, Category);
      const saveOrder: string[] = [];
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      let insertId = 1;
      jest.spyOn(em, "save").mockImplementation(async (entity: any, data: any) => {
        saveOrder.push(entity.name);
        return { ...data, id: data.id ?? insertId++ };
      });

      const mut = em.buffer();

      const comment = new Comment();
      comment.body = "hi";
      const post = new Post();
      post.title = "Hello";

      // Persist child first, parent second — topological sort should fix order
      mut.persist(comment);
      mut.persist(post);

      await mut.flush();

      // Post (parent) should be saved before Comment (child)
      expect(saveOrder.indexOf("Post")).toBeLessThan(saveOrder.indexOf("Comment"));
    });

    it("should delete child before parent", async () => {
      const em = createExtendedEm(Post, Comment, Category);
      const deleteOrder: string[] = [];
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      jest.spyOn(em, "delete").mockImplementation(async (entity: any) => {
        deleteOrder.push(entity.name);
        return { affected: 1 };
      });

      const mut = em.buffer();
      mut.delete(Category, { id: 1 });
      mut.delete(Comment, { id: 10 });
      mut.delete(Post, { id: 5 });

      await mut.flush();

      expect(deleteOrder.indexOf("Comment")).toBeLessThan(deleteOrder.indexOf("Post"));
      expect(deleteOrder.indexOf("Post")).toBeLessThan(deleteOrder.indexOf("Category"));
    });
  });

  // ── Phase 3: CollectionTracker ──────────────────────────────────

  describe("CollectionTracker", () => {
    it("snapshotCollections should capture O2M arrays", () => {
      const post = Object.assign(new Post(), { id: 1, title: "Hi" });
      const c1 = Object.assign(new Comment(), { id: 1, body: "a", postId: 1 });
      post.comments = [c1];

      const snapshots = snapshotCollections(post, Post);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].relationType).toBe("oneToMany");
      expect(snapshots[0].originalItems.has(c1)).toBe(true);
    });

    it("snapshotCollections should capture M2M owning-side arrays", () => {
      const tag = Object.assign(new Tag(), { id: 1, label: "ts" });
      const article = Object.assign(new Article(), { id: 1, title: "ORM", tags: [tag] });

      const snapshots = snapshotCollections(article, Article);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].relationType).toBe("manyToMany");
      expect(snapshots[0].joinTable!.name).toBe("article_tags");
      expect(snapshots[0].originalItems.has(tag)).toBe(true);
    });

    it("snapshotCollections should skip M2M inverse side (mappedBy)", () => {
      const tag = Object.assign(new Tag(), { id: 1, label: "ts" });
      (tag as any).articles = [Object.assign(new Article(), { id: 1 })];

      const snapshots = snapshotCollections(tag, Tag);
      // Tag has mappedBy on articles → should be skipped
      expect(snapshots.filter(s => s.relationType === "manyToMany")).toHaveLength(0);
    });

    it("snapshotCollections should skip non-array properties", () => {
      const post = Object.assign(new Post(), { id: 1, title: "Hi" });
      // comments is undefined
      const snapshots = snapshotCollections(post, Post);
      expect(snapshots).toHaveLength(0);
    });

    it("diffCollection should detect added items", () => {
      const c1 = Object.assign(new Comment(), { id: 1, body: "a", postId: 1 });
      const c2 = Object.assign(new Comment(), { id: 2, body: "b", postId: 1 });

      const snapshot = {
        propertyKey: "comments",
        relationType: "oneToMany" as const,
        originalItems: new Set([c1]),
        relatedEntity: Comment,
      };

      const post = { comments: [c1, c2] };
      const diff = diffCollection(post, snapshot);
      expect(diff).not.toBeNull();
      expect(diff!.added).toEqual([c2]);
      expect(diff!.removed).toEqual([]);
    });

    it("diffCollection should detect removed items", () => {
      const c1 = Object.assign(new Comment(), { id: 1, body: "a", postId: 1 });
      const c2 = Object.assign(new Comment(), { id: 2, body: "b", postId: 1 });

      const snapshot = {
        propertyKey: "comments",
        relationType: "oneToMany" as const,
        originalItems: new Set([c1, c2]),
        relatedEntity: Comment,
      };

      const post = { comments: [c1] };
      const diff = diffCollection(post, snapshot);
      expect(diff).not.toBeNull();
      expect(diff!.added).toEqual([]);
      expect(diff!.removed).toEqual([c2]);
    });

    it("diffCollection should return null when unchanged", () => {
      const c1 = Object.assign(new Comment(), { id: 1, body: "a", postId: 1 });

      const snapshot = {
        propertyKey: "comments",
        relationType: "oneToMany" as const,
        originalItems: new Set([c1]),
        relatedEntity: Comment,
      };

      const post = { comments: [c1] };
      const diff = diffCollection(post, snapshot);
      expect(diff).toBeNull();
    });
  });

  // ── Phase 3: Orphan Removal ─────────────────────────────────────

  describe("orphanRemoval", () => {
    it("should DELETE children removed from O2M array when orphanRemoval:true", async () => {
      const em = createEmWithEntities(Post, Comment);
      const extended = em.extend(bufferPlugin({ orphanRemoval: true }));
      jest.spyOn(extended, "transaction").mockImplementation(async (cb) => cb(extended as any));
      jest.spyOn(extended, "save").mockImplementation(async (_e: any, data: any) => data);
      const deleteSpy = jest.spyOn(extended, "delete").mockResolvedValue({ affected: 1 });

      const mut = extended.buffer();

      const c1 = Object.assign(new Comment(), { id: 1, body: "keep", postId: 1 });
      const c2 = Object.assign(new Comment(), { id: 2, body: "remove", postId: 1 });
      const post = Object.assign(new Post(), { id: 1, title: "Hi", comments: [c1, c2] });
      mut.track(post);

      // Remove c2 from collection
      post.comments = [c1];
      post.title = "Updated";

      const result = await mut.flush();

      expect(result.deletes).toBe(1);
      expect(deleteSpy).toHaveBeenCalledWith(Comment, { id: 2 });
    });

    it("should NOT delete removed children when orphanRemoval:false (default)", async () => {
      const em = createExtendedEm(Post, Comment);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => data);
      const deleteSpy = jest.spyOn(em, "delete").mockResolvedValue({ affected: 1 });

      const mut = em.buffer();

      const c1 = Object.assign(new Comment(), { id: 1, body: "keep", postId: 1 });
      const c2 = Object.assign(new Comment(), { id: 2, body: "remove", postId: 1 });
      const post = Object.assign(new Post(), { id: 1, title: "Hi", comments: [c1, c2] });
      mut.track(post);

      post.comments = [c1];
      post.title = "Updated";

      const result = await mut.flush();

      // Only the update, no orphan removal
      expect(result.deletes).toBe(0);
      expect(deleteSpy).not.toHaveBeenCalled();
    });
  });

  // ── Phase 3: M2M Pivot Sync ──────────────────────────────────────

  describe("M2M pivot sync", () => {
    it("should INSERT into pivot table for added M2M items", async () => {
      const em = createExtendedEm(Article, Tag);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => data);
      const querySpy = jest.spyOn(em, "query").mockResolvedValue([] as any);

      const mut = em.buffer();

      const tag1 = Object.assign(new Tag(), { id: 1, label: "ts" });
      const article = Object.assign(new Article(), { id: 1, title: "ORM", tags: [] as Tag[] });
      mut.track(article);

      // Add tag to collection
      article.tags = [tag1];
      article.title = "Updated";

      const result = await mut.flush();

      expect(querySpy).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO"),
        [1, 1], // parentPk=1, childPk=1
      );
      expect(result.inserts).toBe(1); // pivot row
    });

    it("should DELETE from pivot table for removed M2M items", async () => {
      const em = createExtendedEm(Article, Tag);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => data);
      const querySpy = jest.spyOn(em, "query").mockResolvedValue([] as any);

      const mut = em.buffer();

      const tag1 = Object.assign(new Tag(), { id: 1, label: "ts" });
      const tag2 = Object.assign(new Tag(), { id: 2, label: "js" });
      const article = Object.assign(new Article(), { id: 1, title: "ORM", tags: [tag1, tag2] });
      mut.track(article);

      // Remove tag2
      article.tags = [tag1];
      article.title = "Updated";

      const result = await mut.flush();

      expect(querySpy).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM"),
        [1, 2], // parentPk=1, childPk=2
      );
      expect(result.deletes).toBe(1); // pivot row
    });

    it("should not process M2M on inverse side (mappedBy)", async () => {
      const em = createExtendedEm(Article, Tag);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => data);
      const querySpy = jest.spyOn(em, "query").mockResolvedValue([] as any);

      const mut = em.buffer();

      // Track Tag (inverse side)
      const tag = Object.assign(new Tag(), { id: 1, label: "ts" });
      (tag as any).articles = [];
      mut.track(tag);

      // Modify inverse side array
      (tag as any).articles = [Object.assign(new Article(), { id: 1, title: "x" })];
      tag.label = "updated";

      await mut.flush();

      // No pivot queries for inverse side
      expect(querySpy).not.toHaveBeenCalled();
    });
  });

  // ── Phase 4: detach() ──────────────────────────────────────────

  describe("detach()", () => {
    it("should remove tracked entity and set DETACHED state", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);
      mut.detach(user);

      expect(mut.tracked()).toHaveLength(0);
      expect(mut.getState(user)).toBe(EntityState.DETACHED);
    });

    it("should remove from persistQueue", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const user = new User();
      user.name = "Alice";
      user.email = "a@b.c";
      mut.persist(user);
      expect(mut.size().persists).toBe(1);

      mut.detach(user);
      expect(mut.size().persists).toBe(0);
      expect(mut.getState(user)).toBe(EntityState.DETACHED);
    });

    it("should remove from identityMap, allowing re-track of same PK", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const user1 = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      const user2 = Object.assign(new User(), { id: 1, name: "Bob", email: "b@c.d" });

      mut.track(user1);
      mut.detach(user1);
      mut.track(user2); // should not throw

      expect(mut.tracked()).toEqual([user2]);
    });
  });

  // ── detachByPk() ───────────────────────────────────────────────

  describe("detachByPk()", () => {
    it("should detach a tracked entity by class + scalar PK", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const user = Object.assign(new User(), { id: 7, name: "Alice", email: "a@b.c" });
      mut.track(user);
      expect(mut.tracked()).toHaveLength(1);

      mut.detachByPk(User, 7);

      expect(mut.tracked()).toHaveLength(0);
      expect(mut.getState(user)).toBe(EntityState.DETACHED);
    });

    it("should be a no-op when nothing matches the PK", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);

      mut.detachByPk(User, 999); // not tracked

      expect(mut.tracked()).toHaveLength(1);
      expect(mut.getState(user)).toBe(EntityState.MANAGED);
    });

    it("should free the identity slot so the same PK can be re-tracked", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const user1 = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user1);
      mut.detachByPk(User, 1);

      const user2 = Object.assign(new User(), { id: 1, name: "Bob", email: "b@c.d" });
      mut.track(user2); // should not throw — slot freed

      expect(mut.tracked()).toEqual([user2]);
    });
  });

  // ── detachAll() ────────────────────────────────────────────────

  describe("detachAll()", () => {
    it("should detach every tracked entity and clear the identity map", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const u1 = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      const u2 = Object.assign(new User(), { id: 2, name: "Bob", email: "b@c.d" });
      mut.track(u1);
      mut.track(u2);
      expect(mut.size().tracked).toBe(2);
      expect(mut.size().identityMap).toBe(2);

      mut.detachAll();

      expect(mut.size().tracked).toBe(0);
      expect(mut.size().identityMap).toBe(0);
      expect(mut.getState(u1)).toBe(EntityState.DETACHED);
      expect(mut.getState(u2)).toBe(EntityState.DETACHED);
    });

    it("should cancel pending persist-queue inserts", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const draft = new User();
      draft.name = "Draft";
      draft.email = "d@b.c";
      mut.persist(draft);
      expect(mut.size().persists).toBe(1);

      mut.detachAll();

      expect(mut.size().persists).toBe(0);
      expect(mut.getState(draft)).toBe(EntityState.DETACHED);
    });

    it("should leave bulk and legacy queues intact (use clear() for full reset)", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      mut.updateMany(User, { where: { id: 1 }, set: { name: "x" } });
      mut.deleteMany(User, { id: 2 });
      mut.save(User, { name: "Legacy", email: "l@b.c" });
      mut.delete(User, { id: 99 });

      mut.detachAll();

      const sz = mut.size();
      expect(sz.bulkUpdates).toBe(1);
      expect(sz.bulkDeletes).toBe(1);
      expect(sz.inserts).toBe(1);
      expect(sz.deletes).toBe(1);
    });

    it("should be idempotent when nothing is tracked", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      expect(() => mut.detachAll()).not.toThrow();
      expect(mut.size().tracked).toBe(0);
    });
  });

  // ── Phase 4: merge() ──────────────────────────────────────────

  describe("merge()", () => {
    it("should copy columns onto existing tracked instance with same PK", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const tracked = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(tracked);

      const detached = Object.assign(new User(), { id: 1, name: "Updated", email: "new@b.c" });
      mut.merge(detached);

      expect(tracked.name).toBe("Updated");
      expect(tracked.email).toBe("new@b.c");
      expect(mut.tracked()).toHaveLength(1);
      expect(mut.tracked()[0]).toBe(tracked); // same reference
    });

    it("should track new instance when no existing entity with same PK", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.merge(user);

      expect(mut.tracked()).toEqual([user]);
      expect(mut.getState(user)).toBe(EntityState.MANAGED);
    });

    it("should handle instance with no PK gracefully", () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const user = Object.assign(new User(), { id: 5, name: "Alice", email: "a@b.c" });
      // merge with PK that buildIdentityKey won't find → just track
      mut.merge(user);
      expect(mut.tracked()).toContain(user);
    });
  });

  // ── Phase 4: refresh() ─────────────────────────────────────────

  describe("refresh()", () => {
    it("should reload from DB and re-snapshot", async () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);

      // Mutate locally
      user.name = "Dirty";
      expect(mut.dirty()).toEqual([user]);

      // Simulate DB returning fresh data
      jest.spyOn(em, "findOne").mockResolvedValue(
        Object.assign(new User(), { id: 1, name: "FromDB", email: "db@b.c" }),
      );

      await mut.refresh(user);

      expect(user.name).toBe("FromDB");
      expect(user.email).toBe("db@b.c");
      expect(mut.dirty()).toEqual([]); // re-snapshotted, no longer dirty
    });

    it("should throw for untracked instances", async () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });

      await expect(mut.refresh(user)).rejects.toThrow(/not tracked/);
    });

    it("should throw when not found in DB", async () => {
      const em = createExtendedEm(User);
      const mut = em.buffer();

      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);

      jest.spyOn(em, "findOne").mockResolvedValue(null);

      await expect(mut.refresh(user)).rejects.toThrow(/not found in database/);
    });
  });

  // ── Phase 4: autoFlush ──────────────────────────────────────────

  describe("autoFlush", () => {
    it("should flush before findOne when autoFlush:true and pending work", async () => {
      const em = createEmWithEntities(User);
      const extended = em.extend(bufferPlugin({ autoFlush: true }));
      jest.spyOn(extended, "transaction").mockImplementation(async (cb) => cb(extended as any));
      jest.spyOn(extended, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data, id: data.id ?? 42,
      }));
      jest.spyOn(extended, "findOne").mockResolvedValue(null);

      const mut = extended.buffer();
      mut.save(User, { name: "Alice", email: "a@b.c" });

      await mut.findOne(User, { where: { id: 42 } as any });

      // Insert queue should have been flushed
      expect(mut.size().inserts).toBe(0);
    });

    it("should flush before find when autoFlush:true and pending work", async () => {
      const em = createEmWithEntities(User);
      const extended = em.extend(bufferPlugin({ autoFlush: true }));
      jest.spyOn(extended, "transaction").mockImplementation(async (cb) => cb(extended as any));
      jest.spyOn(extended, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data, id: data.id ?? 42,
      }));
      jest.spyOn(extended, "find").mockResolvedValue([]);

      const mut = extended.buffer();
      mut.save(User, { name: "Alice", email: "a@b.c" });

      await mut.find(User);

      expect(mut.size().inserts).toBe(0);
    });

    it("should NOT flush when autoFlush:false (default)", async () => {
      const em = createExtendedEm(User);
      const transactionSpy = jest.spyOn(em, "transaction");
      jest.spyOn(em, "findOne").mockResolvedValue(null);

      const mut = em.buffer();
      mut.save(User, { name: "Alice", email: "a@b.c" });

      await mut.findOne(User, { where: { id: 1 } as any });

      // No flush triggered
      expect(transactionSpy).not.toHaveBeenCalled();
      expect(mut.size().inserts).toBe(1);
    });

    it("should NOT flush when no pending work even with autoFlush:true", async () => {
      const em = createEmWithEntities(User);
      const extended = em.extend(bufferPlugin({ autoFlush: true }));
      const transactionSpy = jest.spyOn(extended, "transaction");
      jest.spyOn(extended, "findOne").mockResolvedValue(null);

      const mut = extended.buffer();
      // No pending work

      await mut.findOne(User, { where: { id: 1 } as any });

      expect(transactionSpy).not.toHaveBeenCalled();
    });
  });

  // ── Phase 4: onFlush callback ───────────────────────────────────

  describe("onFlush callback", () => {
    it("should call onFlush after successful flush", async () => {
      const onFlush = jest.fn();
      const em = createEmWithEntities(User);
      const extended = em.extend(bufferPlugin({ onFlush }));
      jest.spyOn(extended, "transaction").mockImplementation(async (cb) => cb(extended as any));
      jest.spyOn(extended, "save").mockImplementation(async (_e: any, data: any) => data);

      const mut = extended.buffer();
      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);
      user.name = "Bob";

      await mut.flush();

      expect(onFlush).toHaveBeenCalledWith({ updates: 1, inserts: 0, deletes: 0 });
    });

    it("should NOT call onFlush on no-op flush", async () => {
      const onFlush = jest.fn();
      const em = createEmWithEntities(User);
      const extended = em.extend(bufferPlugin({ onFlush }));

      const mut = extended.buffer();
      await mut.flush();

      expect(onFlush).not.toHaveBeenCalled();
    });
  });

  // ── Cascade Remove ──────────────────────────────────────────────

  describe("cascade remove", () => {
    it("should cascade-delete O2M children when parent is deleted and cascade:delete", async () => {
      // Post has @OneToMany(() => Comment, { cascade: ["insert", "update"] })
      // We need cascade: true (includes delete). Override metadata for this test.
      const originalMeta = Reflect.getMetadata(ONE_TO_MANY_TOKEN, Post);
      Reflect.defineMetadata(
        ONE_TO_MANY_TOKEN,
        [{
          ...originalMeta[0],
          cascade: true, // true = insert + update + delete
        }],
        Post,
      );

      const em = createExtendedEm(Post, Comment);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      jest.spyOn(em, "find").mockResolvedValue([
        Object.assign(new Comment(), { id: 10, body: "a", postId: 1 }),
        Object.assign(new Comment(), { id: 11, body: "b", postId: 1 }),
      ]);
      const deleteSpy = jest.spyOn(em, "delete").mockResolvedValue({ affected: 1 });

      const mut = em.buffer();
      const post = Object.assign(new Post(), { id: 1, title: "Hello" });
      mut.remove(post);

      const result = await mut.flush();

      // Should delete children + parent
      expect(result.deletes).toBeGreaterThanOrEqual(2); // child cascade + parent
      // Child delete should have been called
      expect(deleteSpy).toHaveBeenCalledWith(Comment, expect.objectContaining({ postId: 1 }));
      expect(deleteSpy).toHaveBeenCalledWith(Post, { id: 1 });

      // Restore original metadata
      Reflect.defineMetadata(ONE_TO_MANY_TOKEN, originalMeta, Post);
    });

    it("should NOT cascade-delete when cascade does not include delete", async () => {
      // Default Post cascade is ["insert", "update"] — no delete
      const em = createExtendedEm(Post, Comment);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      jest.spyOn(em, "find").mockResolvedValue([]);
      const deleteSpy = jest.spyOn(em, "delete").mockResolvedValue({ affected: 1 });

      const mut = em.buffer();
      mut.remove(Object.assign(new Post(), { id: 1, title: "Hello" }));

      const result = await mut.flush();

      // Only parent delete — no cascade
      expect(result.deletes).toBe(1);
      expect(deleteSpy).toHaveBeenCalledTimes(1);
      expect(deleteSpy).toHaveBeenCalledWith(Post, { id: 1 });
    });
  });

  // ── Cascade O2O ────────────────────────────────────────────────

  describe("cascade OneToOne", () => {
    // Set up O2O entities for testing
    class UserWithProfile {
      id!: number;
      name!: string;
      profile!: any;
    }

    class UserProfile {
      id!: number;
      bio!: string;
    }

    beforeAll(() => {
      Reflect.defineMetadata(ENTITY_TOKEN, { name: "UserWithProfile" }, UserWithProfile);
      Reflect.defineMetadata(COLUMN_TOKEN, [
        { name: "id", propertyKey: "id", type: Number, options: { primary: true, autoIncrement: true } },
        { name: "name", propertyKey: "name", type: String, options: {} },
        { name: "profileId", propertyKey: "profileId", type: Number, options: {} },
      ], UserWithProfile.prototype);

      Reflect.defineMetadata(ENTITY_TOKEN, { name: "UserProfile" }, UserProfile);
      Reflect.defineMetadata(COLUMN_TOKEN, [
        { name: "id", propertyKey: "id", type: Number, options: { primary: true, autoIncrement: true } },
        { name: "bio", propertyKey: "bio", type: String, options: {} },
      ], UserProfile.prototype);

      // @OneToOne(() => UserProfile, { joinColumn: "profileId", cascade: true })
      Reflect.defineMetadata(ONE_TO_ONE_TOKEN, [{
        target: UserWithProfile,
        propertyKey: "profile",
        getRelatedEntity: () => UserProfile,
        joinColumn: "profileId",
        option: { cascade: true },
      }], UserWithProfile);
    });

    it("should cascade persist O2O related entity", async () => {
      const em = createExtendedEm(UserWithProfile, UserProfile);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      let insertId = 100;
      jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data,
        id: data.id ?? insertId++,
      }));
      // The owning-side FK is persisted to the already-inserted parent row via
      // a targeted UPDATE (the parent was INSERTed before the related entity
      // had a PK).
      const updateSpy = jest
        .spyOn(em, "update")
        .mockResolvedValue({ affected: 1 } as any);

      const mut = em.buffer();

      const profile = new UserProfile();
      profile.bio = "hello";

      const user = new UserWithProfile();
      user.name = "Alice";
      user.profile = profile;

      mut.persist(user);
      const result = await mut.flush();

      // Parent + profile cascade insert
      expect(result.inserts).toBe(2);
      expect(profile.id).toBeDefined();
      // FK resolved on the instance AND written back to the parent row.
      expect((user as any).profileId).toBe(profile.id);
      expect(updateSpy).toHaveBeenCalledWith(
        UserWithProfile,
        { id: (user as any).id },
        { profileId: profile.id },
      );
    });
  });

  // ── Cascade M2M persist ────────────────────────────────────────

  describe("cascade M2M persist", () => {
    it("should cascade-persist new M2M children without PK", async () => {
      const em = createExtendedEm(Article, Tag);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      let insertId = 100;
      jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data,
        id: data.id ?? insertId++,
      }));
      jest.spyOn(em, "query").mockResolvedValue([] as any);

      const mut = em.buffer();

      const newTag = new Tag();
      newTag.label = "new-tag";
      // No PK — should be cascade-persisted

      const article = new Article();
      article.title = "My Article";
      article.tags = [newTag];

      mut.persist(article);
      const result = await mut.flush();

      // Article + newTag persist + pivot row
      expect(result.inserts).toBeGreaterThanOrEqual(2);
      expect(newTag.id).toBeDefined();
    });

    it("should NOT cascade-persist M2M children that already have PK", async () => {
      const em = createExtendedEm(Article, Tag);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      let insertId = 100;
      const saveSpy = jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data,
        id: data.id ?? insertId++,
      }));
      jest.spyOn(em, "query").mockResolvedValue([] as any);

      const mut = em.buffer();

      const existingTag = Object.assign(new Tag(), { id: 5, label: "existing" });

      const article = new Article();
      article.title = "My Article";
      article.tags = [existingTag];

      mut.persist(article);
      await mut.flush();

      // saveSpy should only have been called for Article, not for existingTag
      const saveCalls = saveSpy.mock.calls.map(c => c[0].name);
      expect(saveCalls.filter(n => n === "Tag")).toHaveLength(0);
    });
  });

  // ── Cascade merge/detach/refresh propagation ───────────────────

  describe("cascade merge/detach/refresh propagation", () => {
    it("detach should cascade to O2M children", () => {
      const em = createExtendedEm(Post, Comment);
      const mut = em.buffer();

      const comment = Object.assign(new Comment(), { id: 1, body: "hi", postId: 1 });
      const post = Object.assign(new Post(), { id: 1, title: "Hello", comments: [comment] });
      mut.track(post);
      mut.track(comment);

      mut.detach(post);

      expect(mut.tracked()).toHaveLength(0); // both detached
      expect(mut.getState(post)).toBe(EntityState.DETACHED);
      expect(mut.getState(comment)).toBe(EntityState.DETACHED);
    });

    it("merge should cascade to O2M children", () => {
      const em = createExtendedEm(Post, Comment);
      const mut = em.buffer();

      const comment = Object.assign(new Comment(), { id: 1, body: "original", postId: 1 });
      const post = Object.assign(new Post(), { id: 1, title: "Hello", comments: [comment] });
      mut.track(post);
      mut.track(comment);

      // Merge with updated data
      const detachedComment = Object.assign(new Comment(), { id: 1, body: "updated", postId: 1 });
      const detachedPost = Object.assign(new Post(), { id: 1, title: "Updated", comments: [detachedComment] });
      mut.merge(detachedPost);

      // Tracked post should have updated title
      const trackedPost = mut.tracked().find((t: any) => t.constructor === Post);
      expect(trackedPost.title).toBe("Updated");
      // Tracked comment should have updated body
      const trackedComment = mut.tracked().find((t: any) => t.constructor === Comment);
      expect(trackedComment.body).toBe("updated");
    });

    it("merge should NOT cascade to children when cascade.merge is false (untracked path)", () => {
      const em = createExtendedEm(Post, Comment);
      const mut = em.buffer({ cascade: { merge: false } });

      const comment = Object.assign(new Comment(), { id: 1, body: "hi", postId: 1 });
      const post = Object.assign(new Post(), { id: 1, title: "Hello", comments: [comment] });

      // post is not tracked → merge takes the track-as-new path
      mut.merge(post);

      expect(mut.tracked()).toContain(post);
      expect(mut.tracked()).not.toContain(comment);
    });

    it("refresh should cascade to tracked children", async () => {
      const em = createExtendedEm(Post, Comment);
      const mut = em.buffer();

      const comment = Object.assign(new Comment(), { id: 1, body: "hi", postId: 1 });
      const post = Object.assign(new Post(), { id: 1, title: "Hello", comments: [comment] });
      mut.track(post);
      mut.track(comment);

      post.title = "Dirty";
      comment.body = "Dirty";

      jest.spyOn(em, "findOne")
        .mockResolvedValueOnce(Object.assign(new Post(), { id: 1, title: "FromDB" }))
        .mockResolvedValueOnce(Object.assign(new Comment(), { id: 1, body: "FromDB", postId: 1 }));

      await mut.refresh(post);

      expect(post.title).toBe("FromDB");
      expect(comment.body).toBe("FromDB");
      expect(mut.dirty()).toHaveLength(0);
    });
  });

  // ── Batch UPDATE ───────────────────────────────────────────────

  describe("batchUpdate", () => {
    it("should batch UPDATE multiple dirty entities of same type", async () => {
      const em = createEmWithEntities(User);
      const extended = em.extend(bufferPlugin({ batchUpdate: true }));
      jest.spyOn(extended, "transaction").mockImplementation(async (cb) => cb(extended as any));
      const querySpy = jest.spyOn(extended, "query").mockResolvedValue([] as any);

      const mut = extended.buffer();

      const u1 = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      const u2 = Object.assign(new User(), { id: 2, name: "Bob", email: "b@c.d" });
      mut.track(u1);
      mut.track(u2);

      u1.name = "Alice2";
      u2.name = "Bob2";

      const result = await mut.flush();

      expect(result.updates).toBe(2);
      // Should have used batch query with CASE WHEN
      expect(querySpy).toHaveBeenCalledTimes(1);
      expect(querySpy).toHaveBeenCalledWith(
        expect.stringContaining("CASE"),
        expect.any(Array),
      );
    });

    it("should fallback to individual saves for composite PK", async () => {
      const em = createEmWithEntities(OrderItem);
      const extended = em.extend(bufferPlugin({ batchUpdate: true }));
      jest.spyOn(extended, "transaction").mockImplementation(async (cb) => cb(extended as any));
      const saveSpy = jest.spyOn(extended, "save").mockImplementation(async (_e: any, data: any) => data);

      const mut = extended.buffer();

      const i1 = Object.assign(new OrderItem(), { orderId: 1, productId: 1, quantity: 5 });
      const i2 = Object.assign(new OrderItem(), { orderId: 1, productId: 2, quantity: 10 });
      mut.track(i1);
      mut.track(i2);

      i1.quantity = 99;
      i2.quantity = 88;

      const result = await mut.flush();

      expect(result.updates).toBe(2);
      expect(saveSpy).toHaveBeenCalledTimes(2); // individual saves
    });

    it("should use individual saves when batchUpdate:false (default)", async () => {
      const em = createExtendedEm(User);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      const saveSpy = jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => data);

      const mut = em.buffer();

      const u1 = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      const u2 = Object.assign(new User(), { id: 2, name: "Bob", email: "b@c.d" });
      mut.track(u1);
      mut.track(u2);

      u1.name = "Alice2";
      u2.name = "Bob2";

      const result = await mut.flush();

      expect(result.updates).toBe(2);
      expect(saveSpy).toHaveBeenCalledTimes(2);
    });
  });

  // ── Phase 5: Batch INSERT ──────────────────────────────────────

  describe("batchInsert", () => {
    it("should batch INSERT multiple entities of same type (MySQL)", async () => {
      const em = createEmWithEntities(User);
      const extended = em.extend(bufferPlugin({ batchInsert: true }));
      jest.spyOn(extended, "transaction").mockImplementation(async (cb) => cb(extended as any));
      // Mock query to return MySQL-style insertId result
      const querySpy = jest.spyOn(extended, "query").mockResolvedValue({ insertId: 10 } as any);
      // Mock isMySqlFamily — check PluginContext usage
      // Since createExtendedEm uses default mysql mock, isPostgres will be false

      const mut = extended.buffer();

      const u1 = new User(); u1.name = "Alice"; u1.email = "a@b.c";
      const u2 = new User(); u2.name = "Bob"; u2.email = "b@c.d";

      mut.persist(u1);
      mut.persist(u2);

      const result = await mut.flush();

      expect(result.inserts).toBe(2);
      // batch query should have been called
      expect(querySpy).toHaveBeenCalledTimes(1);
      expect(querySpy).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO"),
        expect.any(Array),
      );
      // PKs should be written back sequentially from insertId
      expect(u1.id).toBe(10);
      expect(u2.id).toBe(11);
    });

    it("should fallback to individual saves for composite PK", async () => {
      const em = createEmWithEntities(OrderItem);
      const extended = em.extend(bufferPlugin({ batchInsert: true }));
      jest.spyOn(extended, "transaction").mockImplementation(async (cb) => cb(extended as any));
      const saveSpy = jest.spyOn(extended, "save").mockImplementation(async (_e: any, data: any) => data);

      const mut = extended.buffer();

      const item1 = Object.assign(new OrderItem(), { quantity: 5 });
      const item2 = Object.assign(new OrderItem(), { quantity: 10 });
      // Composite PK → no auto-increment → persist won't add to persistQueue
      // Let's manually queue them since they have no PK
      // Actually composite PK entities without PK won't pass hasPk check...
      // So let's use the save() API instead
      mut.save(OrderItem, { orderId: 1, productId: 1, quantity: 5 });
      mut.save(OrderItem, { orderId: 1, productId: 2, quantity: 10 });

      const result = await mut.flush();

      expect(result.inserts).toBe(2);
      expect(saveSpy).toHaveBeenCalledTimes(2);
    });

    it("should use individual saves when batchInsert:false (default)", async () => {
      const em = createExtendedEm(User);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      let insertId = 100;
      const saveSpy = jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data, id: data.id ?? insertId++,
      }));

      const mut = em.buffer();

      const u1 = new User(); u1.name = "Alice"; u1.email = "a@b.c";
      const u2 = new User(); u2.name = "Bob"; u2.email = "b@c.d";

      mut.persist(u1);
      mut.persist(u2);

      const result = await mut.flush();

      expect(result.inserts).toBe(2);
      expect(saveSpy).toHaveBeenCalledTimes(2); // individual saves
    });

    it("batches entities with @CreateTimestamp / @UpdateTimestamp (issue #244)", async () => {
      const em = createEmWithEntities(AuditableItem);
      const extended = em.extend(bufferPlugin({ batchInsert: true }));
      jest.spyOn(extended, "transaction").mockImplementation(async (cb) => cb(extended as any));
      const querySpy = jest.spyOn(extended, "query").mockResolvedValue({ insertId: 50 } as any);

      const mut = extended.buffer();
      const a = Object.assign(new AuditableItem(), { title: "a" });
      const b = Object.assign(new AuditableItem(), { title: "b" });
      mut.persist(a);
      mut.persist(b);

      const before = Date.now();
      const result = await mut.flush();
      const after = Date.now();

      expect(result.inserts).toBe(2);
      // Single multi-row INSERT, not two individual saves.
      expect(querySpy).toHaveBeenCalledTimes(1);
      expect(querySpy).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO"),
        expect.any(Array),
      );
      // In-memory instances carry the injected timestamps.
      expect(a.createdAt).toBeInstanceOf(Date);
      expect(a.updatedAt).toBeInstanceOf(Date);
      expect(b.createdAt).toBeInstanceOf(Date);
      expect(b.updatedAt).toBeInstanceOf(Date);
      const t = (a.createdAt as Date).getTime();
      expect(t).toBeGreaterThanOrEqual(before);
      expect(t).toBeLessThanOrEqual(after);
      // Both rows of a single flush pass share the same `now`.
      expect((a.createdAt as Date).getTime()).toBe((b.createdAt as Date).getTime());
    });

    it("batches entities with @Version (initializes version = 1) (issue #244)", async () => {
      const em = createEmWithEntities(VersionedProduct);
      const extended = em.extend(bufferPlugin({ batchInsert: true }));
      jest.spyOn(extended, "transaction").mockImplementation(async (cb) => cb(extended as any));
      const querySpy = jest.spyOn(extended, "query").mockResolvedValue({ insertId: 200 } as any);

      const mut = extended.buffer();
      const p1 = Object.assign(new VersionedProduct(), { name: "widget", price: 10 });
      const p2 = Object.assign(new VersionedProduct(), { name: "gizmo", price: 20 });
      mut.persist(p1);
      mut.persist(p2);

      const result = await mut.flush();

      expect(result.inserts).toBe(2);
      expect(querySpy).toHaveBeenCalledTimes(1);
      expect(p1.version).toBe(1);
      expect(p2.version).toBe(1);
    });

    it("does not clobber pre-set timestamps / versions on batched entities", async () => {
      const em = createEmWithEntities(AuditableItem);
      const extended = em.extend(bufferPlugin({ batchInsert: true }));
      jest.spyOn(extended, "transaction").mockImplementation(async (cb) => cb(extended as any));
      jest.spyOn(extended, "query").mockResolvedValue({ insertId: 60 } as any);

      const mut = extended.buffer();
      const pre = new Date(2020, 0, 1);
      const a = Object.assign(new AuditableItem(), { title: "a", createdAt: pre });
      // Second entity so the batch path (N ≥ 2) activates rather than
      // the single-entity fallback to txEm.save().
      const b = Object.assign(new AuditableItem(), { title: "b" });
      mut.persist(a);
      mut.persist(b);

      await mut.flush();

      // createdAt preserved on entity that had it pre-set; injected on
      // the other. updatedAt always stamped to now for both (matches
      // non-batch save() behavior).
      expect(a.createdAt).toBe(pre);
      expect(a.updatedAt).not.toBe(pre);
      expect(b.createdAt).toBeInstanceOf(Date);
      expect(b.createdAt).not.toBe(pre);
    });

    it("cascade should still trigger per entry in batch mode", async () => {
      const em = createEmWithEntities(Post, Comment);
      const extended = em.extend(bufferPlugin({ batchInsert: true }));
      jest.spyOn(extended, "transaction").mockImplementation(async (cb) => cb(extended as any));
      let insertId = 1;
      jest.spyOn(extended, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data, id: data.id ?? insertId++,
      }));
      // batch query mock for when posts are batched
      jest.spyOn(extended, "query").mockResolvedValue({ insertId: 100 } as any);

      const mut = extended.buffer();

      const comment = Object.assign(new Comment(), { body: "hello" });
      const post = new Post();
      post.title = "Hello";
      post.comments = [comment];

      mut.persist(post);

      const result = await mut.flush();

      // Single entity — falls through to individual save, cascade fires
      // 1 parent + 1 child cascade
      expect(result.inserts).toBeGreaterThanOrEqual(2);
    });
  });

  // ── Proxy Lazy Loading ───────────────────────────────────────────

  describe("getReference()", () => {
    it("should create a reference with only PK set", () => {
      const em = createExtendedEm(User);
      const buf = em.buffer();

      const ref = buf.getReference(User, 42);

      expect(ref).toBeInstanceOf(User);
      expect((ref as any).id).toBe(42);
    });

    it("should return existing identity-mapped instance", async () => {
      const em = createExtendedEm(User);
      jest.spyOn(em, "findOne").mockResolvedValue(
        Object.assign(new User(), { id: 5, name: "Alice", email: "a@b.c" }),
      );

      const buf = em.buffer();
      const loaded = await buf.findOne(User, { where: { id: 5 } as any });
      const ref = buf.getReference(User, 5);

      expect(ref).toBe(loaded);
    });

    it("should support composite PK via object", () => {
      const em = createExtendedEm(OrderItem);
      const buf = em.buffer();

      const ref = buf.getReference(OrderItem, { orderId: 1, productId: 2 });

      expect((ref as any).orderId).toBe(1);
      expect((ref as any).productId).toBe(2);
    });

    it("should register reference in identity map (no duplicate)", () => {
      const em = createExtendedEm(User);
      const buf = em.buffer();

      const ref1 = buf.getReference(User, 10);
      const ref2 = buf.getReference(User, 10);

      expect(ref1).toBe(ref2);
    });

    it("should set state to MANAGED", () => {
      const em = createExtendedEm(User);
      const buf = em.buffer();

      const ref = buf.getReference(User, 7);
      expect(buf.getState(ref)).toBe(EntityState.MANAGED);
    });

    it("should throw for non-registered entity", () => {
      class Ghost { id!: number; }
      const em = createExtendedEm(User);
      const buf = em.buffer();

      expect(() => buf.getReference(Ghost as any, 1)).toThrow(/not a registered entity/);
    });

    it("findOne() after getReference() hydrates the stub from the DB (#365)", async () => {
      const em = createExtendedEm(User);
      const findOneSpy = jest.spyOn(em, "findOne").mockResolvedValue(
        Object.assign(new User(), { id: 5, name: "Alice", email: "a@b.c" }),
      );

      const buf = em.buffer();

      // Reference stub first — PK-only, non-PK fields undefined.
      const ref = buf.getReference(User, 5);
      expect((ref as any).name).toBeUndefined();

      // findOne must NOT return the stub from the cache; it must query the DB
      // and hydrate the same instance in place.
      const loaded = await buf.findOne(User, { where: { id: 5 } as any });

      expect(findOneSpy).toHaveBeenCalledTimes(1);   // DB was queried (not a cache hit)
      expect(loaded).toBe(ref);                       // identity preserved
      expect((loaded as any).name).toBe("Alice");     // stub hydrated
      expect((ref as any).name).toBe("Alice");        // same instance, now populated
    });

    it("a second findOne() after hydration is served from the cache (#365)", async () => {
      const em = createExtendedEm(User);
      const findOneSpy = jest.spyOn(em, "findOne").mockResolvedValue(
        Object.assign(new User(), { id: 9, name: "Bob", email: "b@b.c" }),
      );

      const buf = em.buffer();
      buf.getReference(User, 9);

      await buf.findOne(User, { where: { id: 9 } as any });   // hydrates → 1 DB call
      const again = await buf.findOne(User, { where: { id: 9 } as any }); // cache hit

      expect(findOneSpy).toHaveBeenCalledTimes(1);
      expect((again as any).name).toBe("Bob");
    });
  });

  describe("lazy relation proxies", () => {
    // ── M2O lazy ─────────────────────────────────────────────────

    describe("ManyToOne lazy", () => {
      class Author {
        id!: number;
        name!: string;
      }

      class BlogPost {
        id!: number;
        title!: string;
        authorId!: number;
        author!: Author;
      }

      beforeAll(() => {
        Reflect.defineMetadata(ENTITY_TOKEN, { name: "Author" }, Author);
        Reflect.defineMetadata(COLUMN_TOKEN, [
          { name: "id", propertyKey: "id", type: Number, options: { primary: true, autoIncrement: true } },
          { name: "name", propertyKey: "name", type: String, options: {} },
        ], Author.prototype);

        Reflect.defineMetadata(ENTITY_TOKEN, { name: "BlogPost" }, BlogPost);
        Reflect.defineMetadata(COLUMN_TOKEN, [
          { name: "id", propertyKey: "id", type: Number, options: { primary: true, autoIncrement: true } },
          { name: "title", propertyKey: "title", type: String, options: {} },
          { name: "authorId", propertyKey: "authorId", type: Number, options: {} },
        ], BlogPost.prototype);

        Reflect.defineMetadata(MANY_TO_ONE_TOKEN, [{
          target: BlogPost,
          type: Author,
          columnName: "author",
          joinColumn: "authorId",
          getMappingEntity: () => Author,
          getMappingProperty: (e: any) => e.author,
          option: {},
        }], BlogPost);
      });

      it("should inject lazy proxy on M2O property after findOne", async () => {
        const em = createExtendedEm(BlogPost, Author);
        const authorData = Object.assign(new Author(), { id: 10, name: "Bob" });

        jest.spyOn(em, "findOne").mockImplementation(async (entity: any, opt: any) => {
          if (entity === BlogPost) {
            return Object.assign(new BlogPost(), { id: 1, title: "Hello", authorId: 10 });
          }
          if (entity === Author) {
            return authorData;
          }
          return null;
        });

        const buf = em.buffer();
        const post = await buf.findOne(BlogPost, { where: { id: 1 } as any });

        expect(post).not.toBeNull();
        // author property should be a lazy proxy (returns Promise on first access)
        const authorOrPromise = (post as any).author;
        expect(authorOrPromise).toBeInstanceOf(Promise);

        const author = await authorOrPromise;
        expect(author.id).toBe(10);
        expect(author.name).toBe("Bob");

        // Second access should return cached value (not Promise)
        expect((post as any).author).not.toBeInstanceOf(Promise);
        expect((post as any).author.name).toBe("Bob");
      });

      it("should resolve loaded entity through identity map", async () => {
        const em = createExtendedEm(BlogPost, Author);

        jest.spyOn(em, "findOne").mockImplementation(async (entity: any) => {
          if (entity === BlogPost) {
            return Object.assign(new BlogPost(), { id: 1, title: "Hello", authorId: 10 });
          }
          if (entity === Author) return Object.assign(new Author(), { id: 10, name: "Bob" });
          return null;
        });

        const buf = em.buffer();
        const post = await buf.findOne(BlogPost, { where: { id: 1 } as any });

        // Load author via lazy proxy
        const author = await (post as any).author;

        // Author should now be tracked
        expect(buf.getState(author)).toBe(EntityState.MANAGED);
      });

      it("should skip injection when relation property already has a value", async () => {
        const em = createExtendedEm(BlogPost, Author);

        const existingAuthor = Object.assign(new Author(), { id: 10, name: "Pre-loaded" });
        jest.spyOn(em, "findOne").mockResolvedValue(
          Object.assign(new BlogPost(), { id: 1, title: "Hello", authorId: 10, author: existingAuthor }),
        );

        const buf = em.buffer();
        const post = await buf.findOne(BlogPost, { where: { id: 1 } as any });

        // Should NOT be a promise — already loaded
        expect((post as any).author).toBe(existingAuthor);
      });
    });

    // ── O2M lazy ─────────────────────────────────────────────────

    describe("OneToMany lazy", () => {
      it("should inject lazy collection proxy on O2M property", async () => {
        const em = createExtendedEm(Post, Comment);

        jest.spyOn(em, "findOne").mockResolvedValue(
          Object.assign(new Post(), { id: 1, title: "Hello" }),
        );
        jest.spyOn(em, "find").mockResolvedValue([
          Object.assign(new Comment(), { id: 10, body: "c1", postId: 1 }),
          Object.assign(new Comment(), { id: 11, body: "c2", postId: 1 }),
        ]);

        const buf = em.buffer();
        const post = await buf.findOne(Post, { where: { id: 1 } as any });

        // comments should be a lazy proxy
        const commentsOrPromise = (post as any).comments;
        expect(commentsOrPromise).toBeInstanceOf(Promise);

        const comments = await commentsOrPromise;
        expect(comments).toHaveLength(2);
        expect(comments[0].body).toBe("c1");

        // Second access — cached
        expect((post as any).comments).toHaveLength(2);
        expect((post as any).comments).not.toBeInstanceOf(Promise);
      });

      it("should track loaded children in identity map", async () => {
        const em = createExtendedEm(Post, Comment);

        jest.spyOn(em, "findOne").mockResolvedValue(
          Object.assign(new Post(), { id: 1, title: "Hello" }),
        );
        jest.spyOn(em, "find").mockResolvedValue([
          Object.assign(new Comment(), { id: 10, body: "c1", postId: 1 }),
        ]);

        const buf = em.buffer();
        const post = await buf.findOne(Post, { where: { id: 1 } as any });
        const comments = await (post as any).comments;

        expect(buf.getState(comments[0])).toBe(EntityState.MANAGED);
      });
    });

    // ── O2O lazy ─────────────────────────────────────────────────

    describe("OneToOne lazy", () => {
      class LazyUser {
        id!: number;
        name!: string;
        profileId!: number;
        profile!: any;
      }

      class LazyProfile {
        id!: number;
        bio!: string;
      }

      beforeAll(() => {
        Reflect.defineMetadata(ENTITY_TOKEN, { name: "LazyUser" }, LazyUser);
        Reflect.defineMetadata(COLUMN_TOKEN, [
          { name: "id", propertyKey: "id", type: Number, options: { primary: true, autoIncrement: true } },
          { name: "name", propertyKey: "name", type: String, options: {} },
          { name: "profileId", propertyKey: "profileId", type: Number, options: {} },
        ], LazyUser.prototype);

        Reflect.defineMetadata(ENTITY_TOKEN, { name: "LazyProfile" }, LazyProfile);
        Reflect.defineMetadata(COLUMN_TOKEN, [
          { name: "id", propertyKey: "id", type: Number, options: { primary: true, autoIncrement: true } },
          { name: "bio", propertyKey: "bio", type: String, options: {} },
        ], LazyProfile.prototype);

        Reflect.defineMetadata(ONE_TO_ONE_TOKEN, [{
          target: LazyUser,
          propertyKey: "profile",
          getRelatedEntity: () => LazyProfile,
          joinColumn: "profileId",
          option: {},
        }], LazyUser);
      });

      it("should inject lazy proxy on O2O owning side", async () => {
        const em = createExtendedEm(LazyUser, LazyProfile);

        jest.spyOn(em, "findOne").mockImplementation(async (entity: any) => {
          if (entity === LazyUser) {
            return Object.assign(new LazyUser(), { id: 1, name: "Alice", profileId: 5 });
          }
          if (entity === LazyProfile) {
            return Object.assign(new LazyProfile(), { id: 5, bio: "Hello" });
          }
          return null;
        });

        const buf = em.buffer();
        const user = await buf.findOne(LazyUser, { where: { id: 1 } as any });

        const profileOrPromise = (user as any).profile;
        expect(profileOrPromise).toBeInstanceOf(Promise);

        const profile = await profileOrPromise;
        expect(profile.id).toBe(5);
        expect(profile.bio).toBe("Hello");
      });

      it("should inject lazy proxy on O2O inverse side", async () => {
        class InvProfile {
          id!: number;
          bio!: string;
          user!: any;
        }

        Reflect.defineMetadata(ENTITY_TOKEN, { name: "InvProfile" }, InvProfile);
        Reflect.defineMetadata(COLUMN_TOKEN, [
          { name: "id", propertyKey: "id", type: Number, options: { primary: true, autoIncrement: true } },
          { name: "bio", propertyKey: "bio", type: String, options: {} },
        ], InvProfile.prototype);

        // Inverse side: InvProfile.user → inverseSide: "profile"
        Reflect.defineMetadata(ONE_TO_ONE_TOKEN, [{
          target: InvProfile,
          propertyKey: "user",
          getRelatedEntity: () => LazyUser,
          inverseSide: "profile",
          option: {},
        }], InvProfile);

        const em = createExtendedEm(InvProfile, LazyUser, LazyProfile);
        jest.spyOn(em, "findOne").mockImplementation(async (entity: any, opt: any) => {
          if (entity === InvProfile) {
            return Object.assign(new InvProfile(), { id: 5, bio: "Hello" });
          }
          if (entity === LazyUser) {
            return Object.assign(new LazyUser(), { id: 1, name: "Alice", profileId: 5 });
          }
          return null;
        });

        const buf = em.buffer();
        const profile = await buf.findOne(InvProfile, { where: { id: 5 } as any });

        const userOrPromise = (profile as any).user;
        expect(userOrPromise).toBeInstanceOf(Promise);

        const user = await userOrPromise;
        expect(user.id).toBe(1);
        expect(user.name).toBe("Alice");
      });
    });

    // ── M2M lazy ─────────────────────────────────────────────────

    describe("ManyToMany lazy", () => {
      it("should inject lazy M2M proxy on owning side", async () => {
        const em = createExtendedEm(Article, Tag);

        jest.spyOn(em, "findOne").mockImplementation(async (entity: any) => {
          if (entity === Article) {
            return Object.assign(new Article(), { id: 1, title: "Hello" });
          }
          if (entity === Tag) {
            return Object.assign(new Tag(), { id: 10, label: "ts" });
          }
          return null;
        });
        // Mock find() for batched M2M lazy loading (uses IN query)
        jest.spyOn(em, "find").mockImplementation(async (entity: any) => {
          if (entity === Tag) {
            return [
              Object.assign(new Tag(), { id: 10, label: "ts" }),
              Object.assign(new Tag(), { id: 20, label: "js" }),
            ];
          }
          return [];
        });
        jest.spyOn(em, "query").mockResolvedValue([
          { tag_id: 10 },
          { tag_id: 20 },
        ] as any);

        const buf = em.buffer();
        const article = await buf.findOne(Article, { where: { id: 1 } as any });

        const tagsOrPromise = (article as any).tags;
        expect(tagsOrPromise).toBeInstanceOf(Promise);
      });

      it("should inject lazy M2M proxy on inverse side", async () => {
        const em = createExtendedEm(Article, Tag);

        jest.spyOn(em, "findOne").mockImplementation(async (entity: any) => {
          if (entity === Tag) {
            return Object.assign(new Tag(), { id: 10, label: "ts" });
          }
          return null;
        });
        jest.spyOn(em, "query").mockResolvedValue([] as any);

        const buf = em.buffer();
        const tag = await buf.findOne(Tag, { where: { id: 10 } as any });

        const articlesOrPromise = (tag as any).articles;
        expect(articlesOrPromise).toBeInstanceOf(Promise);

        const articles = await articlesOrPromise;
        expect(articles).toEqual([]);
      });
    });

    // ── getReference + lazy ──────────────────────────────────────

    describe("getReference with lazy relations", () => {
      it("should inject lazy M2O proxy on reference", async () => {
        class RefPost {
          id!: number;
          title!: string;
          authorId!: number;
          author!: any;
        }

        class RefAuthor {
          id!: number;
          name!: string;
        }

        Reflect.defineMetadata(ENTITY_TOKEN, { name: "RefPost" }, RefPost);
        Reflect.defineMetadata(COLUMN_TOKEN, [
          { name: "id", propertyKey: "id", type: Number, options: { primary: true, autoIncrement: true } },
          { name: "title", propertyKey: "title", type: String, options: {} },
          { name: "authorId", propertyKey: "authorId", type: Number, options: {} },
        ], RefPost.prototype);

        Reflect.defineMetadata(ENTITY_TOKEN, { name: "RefAuthor" }, RefAuthor);
        Reflect.defineMetadata(COLUMN_TOKEN, [
          { name: "id", propertyKey: "id", type: Number, options: { primary: true, autoIncrement: true } },
          { name: "name", propertyKey: "name", type: String, options: {} },
        ], RefAuthor.prototype);

        Reflect.defineMetadata(MANY_TO_ONE_TOKEN, [{
          target: RefPost,
          type: RefAuthor,
          columnName: "author",
          joinColumn: "authorId",
          getMappingEntity: () => RefAuthor,
          getMappingProperty: (e: any) => e.author,
          option: {},
        }], RefPost);

        const em = createExtendedEm(RefPost, RefAuthor);
        // getReference doesn't touch DB, but the hydrate-first proxy will:
        // first access loads the stub's own row (to get the FK), then the target.
        jest.spyOn(em, "findOne").mockImplementation(async (entity: any) => {
          if (entity === RefPost) {
            return Object.assign(new RefPost(), { id: 1, title: "T", authorId: 7 }) as any;
          }
          if (entity === RefAuthor) {
            return Object.assign(new RefAuthor(), { id: 7, name: "Charlie" }) as any;
          }
          return null as any;
        });

        const buf = em.buffer();

        // Create reference — a PK-only stub has no FK value, but the M2O proxy
        // must still be injected: it hydrates the stub's row on first access
        // and chains into the relation load.
        const ref = buf.getReference(RefPost, 1);
        expect((ref as any).id).toBe(1);
        const author = await (ref as any).author;
        expect(author).toBeInstanceOf(RefAuthor);
        expect(author.name).toBe("Charlie");
        // Hydration filled the stub's own columns along the way.
        expect((ref as any).authorId).toBe(7);
      });

      it("should allow setting value on lazy proxy property", async () => {
        const em = createExtendedEm(Post, Comment);
        jest.spyOn(em, "findOne").mockResolvedValue(
          Object.assign(new Post(), { id: 1, title: "Hello" }),
        );

        const buf = em.buffer();
        const post = await buf.findOne(Post, { where: { id: 1 } as any });

        // Set the lazy property directly — should override the proxy
        (post as any).comments = [Object.assign(new Comment(), { id: 99, body: "manual", postId: 1 })];

        // Should return the manually set value, not trigger DB load
        expect((post as any).comments).toHaveLength(1);
        expect((post as any).comments[0].body).toBe("manual");
        expect((post as any).comments).not.toBeInstanceOf(Promise);
      });
    });
  });

  // ── Change Tracking Policy ──────────────────────────────────────

  describe("change tracking policy", () => {
    it("DEFERRED_IMPLICIT should dirty-check all tracked entities", async () => {
      const em = createEmWithEntities(User);
      const extended = em.extend(bufferPlugin({ changeTracking: ChangeTrackingPolicy.DEFERRED_IMPLICIT }));
      jest.spyOn(extended, "transaction").mockImplementation(async (cb) => cb(extended as any));
      jest.spyOn(extended, "save").mockImplementation(async (_e: any, data: any) => data);

      const buf = extended.buffer();
      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      buf.track(user);
      user.name = "Bob";

      const result = await buf.flush();
      expect(result.updates).toBe(1);
    });

    it("DEFERRED_EXPLICIT should skip non-marked entities", async () => {
      const em = createEmWithEntities(User);
      const extended = em.extend(bufferPlugin({ changeTracking: ChangeTrackingPolicy.DEFERRED_EXPLICIT }));
      jest.spyOn(extended, "transaction").mockImplementation(async (cb) => cb(extended as any));
      jest.spyOn(extended, "save").mockImplementation(async (_e: any, data: any) => data);

      const buf = extended.buffer();
      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      buf.track(user);
      user.name = "Bob";

      // Not marked dirty → should be skipped
      const result = await buf.flush();
      expect(result.updates).toBe(0);
    });

    it("DEFERRED_EXPLICIT should update when markDirty() is called", async () => {
      const em = createEmWithEntities(User);
      const extended = em.extend(bufferPlugin({ changeTracking: ChangeTrackingPolicy.DEFERRED_EXPLICIT }));
      jest.spyOn(extended, "transaction").mockImplementation(async (cb) => cb(extended as any));
      jest.spyOn(extended, "save").mockImplementation(async (_e: any, data: any) => data);

      const buf = extended.buffer();
      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      buf.track(user);
      user.name = "Bob";
      buf.markDirty(user);

      const result = await buf.flush();
      expect(result.updates).toBe(1);
    });

    it("markDirty should throw for untracked entity", () => {
      const em = createExtendedEm(User);
      const buf = em.buffer();
      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });

      expect(() => buf.markDirty(user)).toThrow(/not tracked/);
    });
  });

  // ── Flush Modes ─────────────────────────────────────────────────

  describe("flush modes", () => {
    it("FlushMode.AUTO should flush before findOne", async () => {
      const em = createEmWithEntities(User);
      const extended = em.extend(bufferPlugin({ flushMode: FlushMode.AUTO }));
      jest.spyOn(extended, "transaction").mockImplementation(async (cb) => cb(extended as any));
      jest.spyOn(extended, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data, id: data.id ?? 99,
      }));
      jest.spyOn(extended, "findOne").mockResolvedValue(
        Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" }),
      );

      const buf = extended.buffer();
      buf.save(User, { name: "Bob", email: "b@b.c" });
      expect(buf.size().inserts).toBe(1);

      await buf.findOne(User, { where: { id: 1 } as any });

      // Insert should have been flushed
      expect(buf.size().inserts).toBe(0);
    });

    it("FlushMode.MANUAL should NOT flush before findOne", async () => {
      const em = createEmWithEntities(User);
      const extended = em.extend(bufferPlugin({ flushMode: FlushMode.MANUAL }));
      jest.spyOn(extended, "findOne").mockResolvedValue(
        Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" }),
      );

      const buf = extended.buffer();
      buf.save(User, { name: "Bob", email: "b@b.c" });

      await buf.findOne(User, { where: { id: 1 } as any });

      // Insert should still be queued
      expect(buf.size().inserts).toBe(1);
    });

    it("FlushMode.COMMIT should NOT auto-flush", async () => {
      const em = createEmWithEntities(User);
      const extended = em.extend(bufferPlugin({ flushMode: FlushMode.COMMIT }));
      jest.spyOn(extended, "findOne").mockResolvedValue(null);

      const buf = extended.buffer();
      buf.save(User, { name: "Bob", email: "b@b.c" });

      await buf.findOne(User, { where: { id: 1 } as any });
      expect(buf.size().inserts).toBe(1);
    });

    it("autoFlush=true should map to FlushMode.AUTO", async () => {
      const em = createEmWithEntities(User);
      const extended = em.extend(bufferPlugin({ autoFlush: true }));
      jest.spyOn(extended, "transaction").mockImplementation(async (cb) => cb(extended as any));
      jest.spyOn(extended, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data, id: 99,
      }));
      jest.spyOn(extended, "findOne").mockResolvedValue(null);

      const buf = extended.buffer();
      buf.save(User, { name: "Bob", email: "b@b.c" });

      await buf.findOne(User, { where: { id: 1 } as any });
      expect(buf.size().inserts).toBe(0);
    });
  });

  // ── PersistentCollection ────────────────────────────────────────

  describe("PersistentCollection", () => {
    it("createPersistentCollection should detect push mutations", () => {
      let dirty = false;
      const arr = createPersistentCollection([1, 2, 3], () => { dirty = true; });

      expect(arr).toHaveLength(3);
      arr.push(4);
      expect(dirty).toBe(true);
      expect(arr).toHaveLength(4);
    });

    it("should detect splice mutations", () => {
      let count = 0;
      const arr = createPersistentCollection(["a", "b", "c"], () => { count++; });

      arr.splice(1, 1);
      expect(count).toBeGreaterThan(0);
      expect(arr).toEqual(["a", "c"]);
    });

    it("should detect index assignment", () => {
      let dirty = false;
      const arr = createPersistentCollection([1, 2, 3], () => { dirty = true; });

      arr[0] = 99;
      expect(dirty).toBe(true);
    });

    it("should detect pop/shift/unshift", () => {
      let count = 0;
      const arr = createPersistentCollection([1, 2, 3], () => { count++; });

      arr.pop();
      const c1 = count;
      arr.shift();
      expect(count).toBeGreaterThan(c1);
      arr.unshift(10);
      expect(count).toBeGreaterThan(c1 + 1);
    });

    it("isPersistentCollection should return true for wrapped arrays", () => {
      const arr = createPersistentCollection([1, 2], () => {});
      expect(isPersistentCollection(arr)).toBe(true);
      expect(isPersistentCollection([1, 2])).toBe(false);
    });

    it("Array.isArray should return true for persistent collections", () => {
      const arr = createPersistentCollection([1, 2], () => {});
      expect(Array.isArray(arr)).toBe(true);
    });

    it("wrapCollection should make mutations mark entity dirty", () => {
      const em = createExtendedEm(Post, Comment);
      const buf = em.buffer();

      const post = Object.assign(new Post(), { id: 1, title: "Hello" });
      post.comments = [Object.assign(new Comment(), { id: 10, body: "c1", postId: 1 })];

      buf.track(post);
      buf.wrapCollection(post, "comments");

      // Push a new comment → should mark entity as explicitly dirty
      post.comments.push(Object.assign(new Comment(), { id: 11, body: "c2", postId: 1 }));

      expect(post.comments).toHaveLength(2);
    });

    it("wrapCollection should throw for untracked entity", () => {
      const em = createExtendedEm(Post);
      const buf = em.buffer();
      const post = Object.assign(new Post(), { id: 1, title: "Hello" });
      post.comments = [];

      expect(() => buf.wrapCollection(post, "comments")).toThrow(/not tracked/);
    });
  });

  // ── Pessimistic Locking ─────────────────────────────────────────

  describe("pessimistic locking", () => {
    it("should store lock mode on tracked entry", async () => {
      const em = createExtendedEm(User);
      jest.spyOn(em, "findOne").mockResolvedValue(
        Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" }),
      );

      const buf = em.buffer();
      await buf.findOne(User, { where: { id: 1 } as any, lock: LockMode.PESSIMISTIC_WRITE });

      // Verify the lock is stored (internal check via preview/dirty)
      expect(buf.tracked()).toHaveLength(1);
    });

    it("should pass lock option to em.findOne at read time (FOR UPDATE)", async () => {
      const em = createExtendedEm(User);
      const findOneSpy = jest.spyOn(em, "findOne").mockResolvedValue(
        Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" }),
      );

      const buf = em.buffer();
      await buf.findOne(User, { where: { id: 1 } as any, lock: LockMode.PESSIMISTIC_WRITE });

      // Lock option should be forwarded to em.findOne (generates FOR UPDATE SQL)
      expect(findOneSpy).toHaveBeenCalledWith(
        User,
        expect.objectContaining({ lock: LockMode.PESSIMISTIC_WRITE }),
      );
    });

    it("should pass lock option to em.findOne at read time (PESSIMISTIC_READ)", async () => {
      const em = createExtendedEm(User);
      const findOneSpy = jest.spyOn(em, "findOne").mockResolvedValue(
        Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" }),
      );

      const buf = em.buffer();
      await buf.findOne(User, { where: { id: 1 } as any, lock: LockMode.PESSIMISTIC_READ });

      // Lock option should be forwarded to em.findOne (generates FOR SHARE SQL)
      expect(findOneSpy).toHaveBeenCalledWith(
        User,
        expect.objectContaining({ lock: LockMode.PESSIMISTIC_READ }),
      );
    });
  });

  // ── Bulk DML ────────────────────────────────────────────────────

  describe("bulk DML", () => {
    it("updateMany should queue and delegate to em.update during flush", async () => {
      const em = createExtendedEm(User);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      // Bulk UPDATE now delegates to the canonical EntityManager.update path
      // (operator WHERE, NamingStrategy, tenant scoping) instead of hand-rolled
      // `col = ?` SQL executed via em.query.
      const updateSpy = jest.spyOn(em, "update").mockResolvedValue({ affected: 1 });

      const buf = em.buffer();
      buf.updateMany(User, { where: { email: "a@b.c" }, set: { name: "Updated" } });

      expect(buf.size().bulkUpdates).toBe(1);

      const result = await buf.flush();
      expect(result.updates).toBe(1);
      expect(updateSpy).toHaveBeenCalledWith(
        User,
        { email: "a@b.c" },
        { name: "Updated" },
      );
    });

    it("deleteMany should queue and delegate to em.delete during flush", async () => {
      const em = createExtendedEm(User);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      const deleteSpy = jest.spyOn(em, "delete").mockResolvedValue(undefined as any);

      const buf = em.buffer();
      buf.deleteMany(User, { email: "a@b.c" });

      expect(buf.size().bulkDeletes).toBe(1);

      const result = await buf.flush();
      expect(result.deletes).toBe(1);
      expect(deleteSpy).toHaveBeenCalledWith(User, { email: "a@b.c" });
    });

    it("bulk queues should be included in preview", () => {
      const em = createExtendedEm(User);
      const buf = em.buffer();

      buf.updateMany(User, { where: { id: 1 }, set: { name: "X" } });
      buf.deleteMany(User, { id: 2 });

      const preview = buf.preview();
      expect(preview).toContainEqual(
        expect.objectContaining({ action: "bulkUpdate", entity: "User" }),
      );
      expect(preview).toContainEqual(
        expect.objectContaining({ action: "bulkDelete", entity: "User" }),
      );
    });

    it("clear should empty bulk queues", () => {
      const em = createExtendedEm(User);
      const buf = em.buffer();

      buf.updateMany(User, { where: { id: 1 }, set: { name: "X" } });
      buf.deleteMany(User, { id: 2 });

      buf.clear();
      expect(buf.size().bulkUpdates).toBe(0);
      expect(buf.size().bulkDeletes).toBe(0);
    });
  });

  // ── Per-entity Flush Events ─────────────────────────────────────

  describe("flush events", () => {
    it("should fire preInsert/postInsert for persist", async () => {
      const em = createExtendedEm(User);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data, id: data.id ?? 1,
      }));

      const buf = em.buffer();
      const events: string[] = [];

      buf.onFlushEvent("preInsert", (e: FlushEvent) => { events.push(`pre:${e.entity.name}`); });
      buf.onFlushEvent("postInsert", (e: FlushEvent) => { events.push(`post:${e.entity.name}`); });

      const user = Object.assign(new User(), { name: "Alice", email: "a@b.c" });
      buf.persist(user);

      await buf.flush();

      expect(events).toEqual(["pre:User", "post:User"]);
    });

    it("should fire preUpdate/postUpdate for tracked updates", async () => {
      const em = createExtendedEm(User);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => data);

      const buf = em.buffer();
      const events: string[] = [];

      buf.onFlushEvent("preUpdate", () => { events.push("preUpdate"); });
      buf.onFlushEvent("postUpdate", () => { events.push("postUpdate"); });

      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      buf.track(user);
      user.name = "Bob";

      await buf.flush();

      expect(events).toEqual(["preUpdate", "postUpdate"]);
    });

    it("should fire preDelete/postDelete for deletes", async () => {
      const em = createExtendedEm(User);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      jest.spyOn(em, "delete").mockResolvedValue(undefined as any);

      const buf = em.buffer();
      const events: string[] = [];

      buf.onFlushEvent("preDelete", () => { events.push("preDelete"); });
      buf.onFlushEvent("postDelete", () => { events.push("postDelete"); });

      buf.delete(User, { id: 1 });
      await buf.flush();

      expect(events).toEqual(["preDelete", "postDelete"]);
    });

    it("should pass entity instance in event payload", async () => {
      const em = createExtendedEm(User);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => data);

      const buf = em.buffer();
      let capturedInstance: any;

      buf.onFlushEvent("preUpdate", (e: FlushEvent) => { capturedInstance = e.instance; });

      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      buf.track(user);
      user.name = "Bob";

      await buf.flush();

      expect(capturedInstance).toBe(user);
    });
  });

  // ── Read-only Entities ──────────────────────────────────────────

  describe("read-only entities", () => {
    it("markReadOnly should skip dirty checking on flush", async () => {
      const em = createExtendedEm(User);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      const saveSpy = jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => data);

      const buf = em.buffer();
      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      buf.track(user);
      buf.markReadOnly(user);

      user.name = "Bob"; // mutated, but read-only

      const result = await buf.flush();
      expect(result.updates).toBe(0);
      expect(saveSpy).not.toHaveBeenCalled();
    });

    it("isReadOnly should return correct status", () => {
      const em = createExtendedEm(User);
      const buf = em.buffer();
      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      buf.track(user);

      expect(buf.isReadOnly(user)).toBe(false);
      buf.markReadOnly(user);
      expect(buf.isReadOnly(user)).toBe(true);
    });

    it("markReadOnly should throw for untracked entity", () => {
      const em = createExtendedEm(User);
      const buf = em.buffer();
      const user = new User();
      expect(() => buf.markReadOnly(user)).toThrow(/not tracked/);
    });
  });

  // ── Nested UoW (Savepoint) ──────────────────────────────────────

  describe("nested UoW (savepoint)", () => {
    it("beginNested should return a new WriteBuffer", () => {
      const em = createExtendedEm(User);
      const buf = em.buffer();
      const nested = buf.beginNested();

      expect(nested).toBeInstanceOf(WriteBuffer);
      expect(nested).not.toBe(buf);
    });

    it("nested flush should execute SAVEPOINT and operations", async () => {
      const em = createExtendedEm(User);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data, id: data.id ?? 1,
      }));
      const querySpy = jest.spyOn(em, "query").mockResolvedValue([]);

      const buf = em.buffer();
      const nested = buf.beginNested();

      const user = Object.assign(new User(), { name: "Alice", email: "a@b.c" });
      nested.persist(user);

      const result = await nested.flush();
      expect(result.inserts).toBe(1);

      // Should have executed SAVEPOINT
      expect(querySpy).toHaveBeenCalledWith(
        expect.stringContaining("SAVEPOINT"),
      );
    });

    it("nested flush failure should ROLLBACK TO SAVEPOINT", async () => {
      const em = createExtendedEm(User);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      jest.spyOn(em, "save").mockRejectedValue(new Error("DB error"));
      const querySpy = jest.spyOn(em, "query").mockResolvedValue([]);

      const buf = em.buffer();
      const nested = buf.beginNested();

      const user = Object.assign(new User(), { name: "Alice", email: "a@b.c" });
      nested.persist(user);

      await expect(nested.flush()).rejects.toThrow("DB error");

      // Should have executed ROLLBACK TO SAVEPOINT
      expect(querySpy).toHaveBeenCalledWith(
        expect.stringContaining("ROLLBACK TO SAVEPOINT"),
      );
    });

    it("nested flush SAVEPOINT should run inside em.transaction (same connection)", async () => {
      const em = createExtendedEm(User);
      const callOrder: string[] = [];

      jest.spyOn(em, "transaction").mockImplementation(async (cb) => {
        callOrder.push("transaction:start");
        const result = await cb(em as any);
        callOrder.push("transaction:end");
        return result;
      });
      jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data, id: data.id ?? 1,
      }));
      jest.spyOn(em, "query").mockImplementation(async (sqlQuery: any) => {
        if (typeof sqlQuery === "string" && sqlQuery.startsWith("SAVEPOINT")) {
          callOrder.push("savepoint");
        }
        return [];
      });

      const buf = em.buffer();
      const nested = buf.beginNested();
      nested.persist(Object.assign(new User(), { name: "A", email: "a@b.c" }));

      await nested.flush();

      // SAVEPOINT must be inside the transaction
      expect(callOrder).toEqual(["transaction:start", "savepoint", "transaction:end"]);
    });
  });

  // ── Fix 2: Bulk DML identity map sync ────────────────────────────

  describe("bulk DML identity map sync", () => {
    it("updateMany should sync tracked entity values and re-snapshot", async () => {
      const em = createExtendedEm(User);
      jest.spyOn(em, "findOne").mockResolvedValue(
        Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" }),
      );
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      jest.spyOn(em, "update").mockResolvedValue({ affected: 1 });

      const buf = em.buffer();
      const user = await buf.findOne(User, { where: { id: 1 } as any });

      buf.updateMany(User, { where: { id: 1 }, set: { name: "Updated" } });
      await buf.flush();

      // In-memory value should be synced
      expect((user as any).name).toBe("Updated");

      // Should not be dirty after sync (snapshot was refreshed)
      const preview = buf.preview();
      const updateEntries = preview.filter((e: any) => e.action === "update");
      expect(updateEntries).toHaveLength(0);
    });

    it("deleteMany should evict matching tracked entities from identity map", async () => {
      const em = createExtendedEm(User);
      jest.spyOn(em, "findOne").mockResolvedValue(
        Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" }),
      );
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      jest.spyOn(em, "delete").mockResolvedValue(undefined as any);

      const buf = em.buffer();
      await buf.findOne(User, { where: { id: 1 } as any });
      expect(buf.tracked()).toHaveLength(1);

      buf.deleteMany(User, { id: 1 });
      await buf.flush();

      // Entity should be evicted from tracked entries
      expect(buf.tracked()).toHaveLength(0);
    });

    it("updateMany should not affect non-matching tracked entities", async () => {
      const em = createExtendedEm(User);
      const findSpy = jest.spyOn(em, "findOne");
      findSpy.mockResolvedValueOnce(
        Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" }),
      );
      findSpy.mockResolvedValueOnce(
        Object.assign(new User(), { id: 2, name: "Bob", email: "b@b.c" }),
      );
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      jest.spyOn(em, "update").mockResolvedValue({ affected: 1 });

      const buf = em.buffer();
      const user1 = await buf.findOne(User, { where: { id: 1 } as any });
      const user2 = await buf.findOne(User, { where: { id: 2 } as any });

      buf.updateMany(User, { where: { id: 1 }, set: { name: "Changed" } });
      await buf.flush();

      expect((user1 as any).name).toBe("Changed");
      expect((user2 as any).name).toBe("Bob"); // unchanged
    });
  });

  // ── Phase 2/3/4 Regression Tests ──────────────────────────────

  describe("evictTrackedAfterBulkDelete O(1) identity map cleanup", () => {
    it("should remove from identityMap without O(n) scan", async () => {
      const em = createExtendedEm(User);
      jest.spyOn(em, "findOne").mockImplementation(async () =>
        Object.assign(new User(), { id: 1, name: "Alice", email: "a@a.com" }),
      );
      jest.spyOn(em, "find").mockResolvedValue([]);
      jest.spyOn(em, "query").mockResolvedValue([]);
      jest.spyOn(em, "transaction").mockImplementation(async (fn: any) => fn(em));
      jest.spyOn(em, "delete").mockResolvedValue(undefined as any);

      const buf = em.buffer();
      const user = await buf.findOne(User, { where: { id: 1 } as any });
      expect(buf.size().tracked).toBe(1);

      // Bulk delete matching the tracked user
      buf.deleteMany(User, { id: 1 });
      await buf.flush();

      // Entity should be evicted from tracking and set to DETACHED
      expect(buf.size().tracked).toBe(0);
      expect(buf.getState(user)).toBe(EntityState.DETACHED);
    });
  });

  describe("DependencyGraph cycle detection warning", () => {
    it("should log a warning when a cycle is detected", () => {
      const warnSpy = jest.spyOn(console, "log").mockImplementation(() => {});

      class CycleX {}
      class CycleY {}
      Reflect.defineMetadata(ENTITY_TOKEN, { name: "CycleX" }, CycleX);
      Reflect.defineMetadata(COLUMN_TOKEN, [
        { name: "id", propertyKey: "id", options: { primary: true } },
      ], CycleX.prototype);
      Reflect.defineMetadata(MANY_TO_ONE_TOKEN, [{
        columnName: "cycleY",
        getMappingEntity: () => CycleY,
        joinColumn: "cycleYId",
      }], CycleX);

      Reflect.defineMetadata(ENTITY_TOKEN, { name: "CycleY" }, CycleY);
      Reflect.defineMetadata(COLUMN_TOKEN, [
        { name: "id", propertyKey: "id", options: { primary: true } },
      ], CycleY.prototype);
      Reflect.defineMetadata(MANY_TO_ONE_TOKEN, [{
        columnName: "cycleX",
        getMappingEntity: () => CycleX,
        joinColumn: "cycleXId",
      }], CycleY);

      const result = topologicalSort([CycleX, CycleY]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Circular FK dependency"),
      );
      // Fallback: returns original order
      expect(result).toEqual([CycleX, CycleY]);

      warnSpy.mockRestore();
    });
  });

  describe("BigInt in deepEquals", () => {
    it("should compare BigInt values correctly", () => {
      expect(deepEquals(1n, 1n)).toBe(true);
      expect(deepEquals(1n, 2n)).toBe(false);
      expect(deepEquals(1n, 1)).toBe(false);  // different types
      expect(deepEquals(0n, 0n)).toBe(true);
    });
  });

  describe("hasPendingWork early exit correctness", () => {
    it("should detect dirty tracked entries in single loop", () => {
      const em = createExtendedEm(User);
      jest.spyOn(em, "findOne").mockResolvedValue(
        Object.assign(new User(), { id: 1, name: "Alice", email: "a@a.com" }),
      );

      const buf = em.buffer();
      const user = new User();
      user.id = 1;
      user.name = "Alice";
      user.email = "a@a.com";
      buf.track(user);

      // No pending work initially
      const preview1 = buf.preview();
      expect(preview1.length).toBe(0);

      // Mutate and check
      user.name = "Bob";
      const preview2 = buf.preview();
      expect(preview2.length).toBe(1);
      expect(preview2[0].action).toBe("update");
    });
  });

  describe("M2M lazy batched loading", () => {
    it("should use find() instead of N findOne() calls", async () => {
      const em = createExtendedEm(Article, Tag);

      const findOneSpy = jest.spyOn(em, "findOne").mockImplementation(async (entity: any) => {
        if (entity === Article) {
          return Object.assign(new Article(), { id: 1, title: "Post" });
        }
        return null;
      });
      const findSpy = jest.spyOn(em, "find").mockImplementation(async (entity: any) => {
        if (entity === Tag) {
          return [
            Object.assign(new Tag(), { id: 10, label: "ts" }),
            Object.assign(new Tag(), { id: 20, label: "js" }),
            Object.assign(new Tag(), { id: 30, label: "go" }),
          ];
        }
        return [];
      });
      jest.spyOn(em, "query").mockResolvedValue([
        { tag_id: 10 },
        { tag_id: 20 },
        { tag_id: 30 },
      ] as any);

      const buf = em.buffer();
      const article = await buf.findOne(Article, { where: { id: 1 } as any });

      const tagsPromise = (article as any).tags;
      const tags = await tagsPromise;

      // Should use 1 find() call instead of 3 findOne() calls
      expect(findSpy).toHaveBeenCalledWith(Tag, expect.objectContaining({
        where: { id: [10, 20, 30] },
      }));
      // findOne should only be called once (for the initial Article load)
      expect(findOneSpy).toHaveBeenCalledTimes(1);
      expect(tags).toHaveLength(3);
    });
  });

  describe("sortByIndex caches topological sort", () => {
    it("should sort using pre-computed index map", () => {
      const indexMap = buildTopologicalIndexMap([User, Comment]);
      const entries = [
        { entity: Comment, data: {} },
        { entity: User, data: {} },
      ];
      const sorted = sortByIndex(entries, indexMap);
      // User should come before Comment (parent before child)
      expect(sorted[0].entity).toBe(User);

      const reverseSorted = sortByIndex(entries, indexMap, true);
      // Reversed: Comment before User (children first)
      expect(reverseSorted[0].entity).toBe(Comment);
    });
  });

  // ── Granular Cascade Options ──────────────────────────────────

  describe("granular cascade options (BufferCascadeOptions)", () => {
    it("cascade: true should enable all operations (backward compat)", async () => {
      const em = createEmWithEntities(Post, Comment);
      const extended = em.extend(bufferPlugin({ cascade: true }));
      jest.spyOn(extended, "transaction").mockImplementation(async (cb) => cb(extended as any));
      let insertId = 500;
      jest.spyOn(extended, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data,
        id: data.id ?? insertId++,
      }));

      const mut = extended.buffer();

      const post = new Post();
      post.title = "Hello";
      post.comments = [Object.assign(new Comment(), { body: "child" })];

      mut.persist(post);
      const result = await mut.flush();

      expect(result.inserts).toBe(2); // parent + cascaded child
    });

    it("cascade: false should disable all operations (backward compat)", async () => {
      const em = createEmWithEntities(Post, Comment);
      const extended = em.extend(bufferPlugin({ cascade: false }));
      jest.spyOn(extended, "transaction").mockImplementation(async (cb) => cb(extended as any));
      jest.spyOn(extended, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data,
        id: data.id ?? 1,
      }));

      const mut = extended.buffer();

      const post = new Post();
      post.title = "Hello";
      post.comments = [Object.assign(new Comment(), { body: "child" })];

      mut.persist(post);
      const result = await mut.flush();

      expect(result.inserts).toBe(1); // only parent
    });

    it("cascade: { persist: false } should skip cascade on flush but allow others", () => {
      const em = createEmWithEntities(Post, Comment);
      const extended = em.extend(bufferPlugin({ cascade: { persist: false } }));
      const mut = extended.buffer();

      // detach should still cascade (detach defaults to true)
      const post = Object.assign(new Post(), { id: 1, title: "Hello" });
      const comment = Object.assign(new Comment(), { id: 10, body: "child", postId: 1 });
      post.comments = [comment];

      mut.track(post);
      mut.track(comment);
      mut.detach(post);

      // Both should be detached (cascade.detach = true by default)
      expect(mut.getState(post)).toBe(EntityState.DETACHED);
      expect(mut.getState(comment)).toBe(EntityState.DETACHED);
    });

    it("cascade: { persist: true, remove: false } should cascade insert but not delete", async () => {
      const em = createEmWithEntities(Post, Comment);
      const extended = em.extend(bufferPlugin({ cascade: { persist: true, remove: false } }));
      jest.spyOn(extended, "transaction").mockImplementation(async (cb) => cb(extended as any));
      let insertId = 600;
      jest.spyOn(extended, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data,
        id: data.id ?? insertId++,
      }));
      const findSpy = jest.spyOn(extended, "find").mockResolvedValue([]);
      jest.spyOn(extended, "delete").mockResolvedValue({ affected: 1 } as any);

      const mut = extended.buffer();

      // Persist with cascade
      const post = new Post();
      post.title = "Hello";
      post.comments = [Object.assign(new Comment(), { body: "child" })];
      mut.persist(post);
      const insertResult = await mut.flush();
      expect(insertResult.inserts).toBe(2); // parent + child cascaded

      // Delete should NOT cascade
      mut.remove(post);
      const deleteResult = await mut.flush();
      expect(deleteResult.deletes).toBe(1); // only parent, no cascade delete
    });

    it("cascade: { detach: false } should not cascade detach to children", () => {
      const em = createEmWithEntities(Post, Comment);
      const extended = em.extend(bufferPlugin({ cascade: { detach: false } }));
      const mut = extended.buffer();

      const post = Object.assign(new Post(), { id: 1, title: "Hello" });
      const comment = Object.assign(new Comment(), { id: 10, body: "child", postId: 1 });
      post.comments = [comment];

      mut.track(post);
      mut.track(comment);
      mut.detach(post);

      expect(mut.getState(post)).toBe(EntityState.DETACHED);
      expect(mut.getState(comment)).toBe(EntityState.MANAGED); // NOT detached
    });

    it("cascade: { merge: false } should not cascade merge to children", () => {
      const em = createEmWithEntities(Post, Comment);
      const extended = em.extend(bufferPlugin({ cascade: { merge: false } }));
      const mut = extended.buffer();

      const post = Object.assign(new Post(), { id: 1, title: "Hello" });
      const comment = Object.assign(new Comment(), { id: 10, body: "original", postId: 1 });
      post.comments = [comment];

      mut.track(post);
      // comment is NOT tracked separately

      const detachedPost = Object.assign(new Post(), { id: 1, title: "Updated" });
      const detachedComment = Object.assign(new Comment(), { id: 10, body: "updated child", postId: 1 });
      detachedPost.comments = [detachedComment];

      mut.merge(detachedPost);

      expect(post.title).toBe("Updated"); // merge applied to parent
      // Comment should NOT be merged because cascade.merge = false
      // Original comment on tracked post should be unchanged
      expect(comment.body).toBe("original");
    });

    it("cascade: { refresh: false } should not cascade refresh to children", async () => {
      const em = createEmWithEntities(Post, Comment);
      const extended = em.extend(bufferPlugin({ cascade: { refresh: false } }));
      const findOneSpy = jest.spyOn(extended, "findOne");

      const mut = extended.buffer();
      const post = Object.assign(new Post(), { id: 1, title: "Hello" });
      const comment = Object.assign(new Comment(), { id: 10, body: "child", postId: 1 });
      post.comments = [comment];

      mut.track(post);
      mut.track(comment);

      findOneSpy.mockResolvedValueOnce(
        Object.assign(new Post(), { id: 1, title: "Refreshed" }),
      );

      await mut.refresh(post);
      expect(post.title).toBe("Refreshed");
      // findOne should only be called once — for post, NOT for comment
      expect(findOneSpy).toHaveBeenCalledTimes(1);
    });

    it("partial cascade object should default unspecified keys to true", async () => {
      const em = createEmWithEntities(Post, Comment);
      // Only disable remove; everything else should be true
      const extended = em.extend(bufferPlugin({ cascade: { remove: false } }));
      jest.spyOn(extended, "transaction").mockImplementation(async (cb) => cb(extended as any));
      let insertId = 700;
      jest.spyOn(extended, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data,
        id: data.id ?? insertId++,
      }));

      const mut = extended.buffer();

      // persist cascade should still work
      const post = new Post();
      post.title = "Hello";
      post.comments = [Object.assign(new Comment(), { body: "child" })];
      mut.persist(post);
      const result = await mut.flush();
      expect(result.inserts).toBe(2); // parent + child — persist cascade works
    });
  });

  // ── @Version Optimistic Locking in flush ──────────────────────

  describe("@Version optimistic locking in flush", () => {
    it("should increment version on instance after flush UPDATE (MySQL — no RETURNING)", async () => {
      const em = createExtendedEm(VersionedProduct);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      // Simulate MySQL: save() returns data WITHOUT incremented version
      jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data,
        // MySQL: does NOT return updated version (no RETURNING)
      }));

      const mut = em.buffer();
      const product = Object.assign(new VersionedProduct(), {
        id: 1, name: "Widget", price: 100, version: 1,
      });
      mut.track(product);

      // Dirty the entity
      product.price = 200;
      await mut.flush();

      // Version should be incremented to 2 even without RETURNING
      expect(product.version).toBe(2);
    });

    it("should use RETURNING version when available (PostgreSQL)", async () => {
      const em = createExtendedEm(VersionedProduct);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      // Simulate PostgreSQL: save() returns data WITH incremented version
      jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data,
        version: (data.version ?? 0) + 1, // RETURNING gives new version
      }));

      const mut = em.buffer();
      const product = Object.assign(new VersionedProduct(), {
        id: 1, name: "Widget", price: 100, version: 1,
      });
      mut.track(product);

      product.price = 200;
      await mut.flush();

      // Version should be 2 (from RETURNING, not double-incremented)
      expect(product.version).toBe(2);
    });

    it("should propagate OptimisticLockError from EntityManager", async () => {
      const em = createExtendedEm(VersionedProduct);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      jest.spyOn(em, "save").mockRejectedValue(
        new Error("OptimisticLockError: VersionedProduct was modified by another transaction (version: 1)"),
      );

      const mut = em.buffer();
      const product = Object.assign(new VersionedProduct(), {
        id: 1, name: "Widget", price: 100, version: 1,
      });
      mut.track(product);
      product.price = 200;

      await expect(mut.flush()).rejects.toThrow("OptimisticLockError");
    });

    it("should correctly re-snapshot version after successful flush", async () => {
      const em = createExtendedEm(VersionedProduct);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data,
        // MySQL: no RETURNING
      }));

      const mut = em.buffer();
      const product = Object.assign(new VersionedProduct(), {
        id: 1, name: "Widget", price: 100, version: 1,
      });
      mut.track(product);

      // First flush: version 1 → 2
      product.price = 200;
      await mut.flush();
      expect(product.version).toBe(2);

      // Second flush: version 2 → 3 (should not get stuck at version 1)
      product.price = 300;
      await mut.flush();
      expect(product.version).toBe(3);
    });

    it("should not alter version on non-versioned entities", async () => {
      const em = createExtendedEm(User);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data,
      }));

      const mut = em.buffer();
      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.c" });
      mut.track(user);
      user.name = "Bob";

      await mut.flush();
      // No version property to increment — should not add one
      expect((user as any).version).toBeUndefined();
    });

    it("should set version=1 on INSERT via persist", async () => {
      const em = createExtendedEm(VersionedProduct);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data,
        id: data.id ?? 42,
        version: 1, // EntityManager sets version=1 on INSERT
      }));

      const mut = em.buffer();
      const product = new VersionedProduct();
      product.name = "New Widget";
      product.price = 50;
      // version is not set

      mut.persist(product);
      await mut.flush();

      expect(product.version).toBe(1);
      expect(product.id).toBe(42);
    });
  });

  // ── @CreateTimestamp / @UpdateTimestamp in flush ───────────────

  describe("@CreateTimestamp / @UpdateTimestamp in flush", () => {
    it("should set createdAt and updatedAt on INSERT via persist", async () => {
      const em = createExtendedEm(AuditableItem);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data,
        id: data.id ?? 99,
        // MySQL: no RETURNING — timestamps not in response
      }));

      const before = new Date();
      const mut = em.buffer();
      const item = new AuditableItem();
      item.title = "Test";

      mut.persist(item);
      await mut.flush();
      const after = new Date();

      expect(item.id).toBe(99);
      expect(item.createdAt).toBeInstanceOf(Date);
      expect(item.updatedAt).toBeInstanceOf(Date);
      expect(item.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(item.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it("should update updatedAt but NOT createdAt on UPDATE", async () => {
      const em = createExtendedEm(AuditableItem);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data,
        // MySQL: no RETURNING
      }));

      const originalCreatedAt = new Date("2025-01-01T00:00:00Z");
      const originalUpdatedAt = new Date("2025-01-01T00:00:00Z");

      const mut = em.buffer();
      const item = Object.assign(new AuditableItem(), {
        id: 1,
        title: "Original",
        createdAt: originalCreatedAt,
        updatedAt: originalUpdatedAt,
      });
      mut.track(item);

      item.title = "Changed";
      await mut.flush();

      // createdAt should NOT be overwritten (only set on INSERT when null)
      expect(item.createdAt).toBe(originalCreatedAt);
      // updatedAt should be updated to now
      expect(item.updatedAt).not.toBe(originalUpdatedAt);
      expect(item.updatedAt.getTime()).toBeGreaterThan(originalUpdatedAt.getTime());
    });

    it("should not set timestamps on entities without decorators", async () => {
      const em = createExtendedEm(User);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data,
        id: data.id ?? 1,
      }));

      const mut = em.buffer();
      const user = new User();
      user.name = "Alice";
      user.email = "a@b.c";
      mut.persist(user);
      await mut.flush();

      expect((user as any).createdAt).toBeUndefined();
      expect((user as any).updatedAt).toBeUndefined();
    });

    it("should preserve user-provided createdAt on INSERT", async () => {
      const em = createExtendedEm(AuditableItem);
      jest.spyOn(em, "transaction").mockImplementation(async (cb) => cb(em as any));
      jest.spyOn(em, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data,
        id: data.id ?? 99,
      }));

      const customDate = new Date("2020-06-15T12:00:00Z");
      const mut = em.buffer();
      const item = new AuditableItem();
      item.title = "Test";
      item.createdAt = customDate;

      mut.persist(item);
      await mut.flush();

      // User-provided createdAt should be preserved
      expect(item.createdAt).toBe(customDate);
    });
  });

  // ── validateBeforeFlush ───────────────────────────────────────

  describe("validateBeforeFlush", () => {
    it("should throw ValidationError on persist with invalid data", async () => {
      const em = createEmWithEntities(ValidatedUser);
      const extended = em.extend(bufferPlugin({ validateBeforeFlush: true }));
      jest.spyOn(extended, "transaction").mockImplementation(async (cb) => cb(extended as any));
      jest.spyOn(extended, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data,
        id: data.id ?? 1,
      }));

      const mut = extended.buffer();
      const user = new ValidatedUser();
      user.name = undefined as any; // @NotNull violation
      user.age = 25;

      mut.persist(user);
      await expect(mut.flush()).rejects.toThrow(ValidationError);
    });

    it("should throw ValidationError on dirty tracked entity with invalid data", async () => {
      const em = createEmWithEntities(ValidatedUser);
      const extended = em.extend(bufferPlugin({ validateBeforeFlush: true }));
      jest.spyOn(extended, "transaction").mockImplementation(async (cb) => cb(extended as any));
      jest.spyOn(extended, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data,
      }));

      const mut = extended.buffer();
      const user = Object.assign(new ValidatedUser(), { id: 1, name: "Alice", age: 25 });
      mut.track(user);

      user.age = -5; // @Min(0) violation
      await expect(mut.flush()).rejects.toThrow(ValidationError);
    });

    it("should succeed when all entities pass validation", async () => {
      const em = createEmWithEntities(ValidatedUser);
      const extended = em.extend(bufferPlugin({ validateBeforeFlush: true }));
      jest.spyOn(extended, "transaction").mockImplementation(async (cb) => cb(extended as any));
      jest.spyOn(extended, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data,
        id: data.id ?? 1,
      }));

      const mut = extended.buffer();
      const user = new ValidatedUser();
      user.name = "Alice";
      user.age = 25;

      mut.persist(user);
      const result = await mut.flush();
      expect(result.inserts).toBe(1);
    });

    it("should not validate when validateBeforeFlush is false (default)", async () => {
      const em = createEmWithEntities(ValidatedUser);
      const extended = em.extend(bufferPlugin()); // default: validateBeforeFlush = false
      jest.spyOn(extended, "transaction").mockImplementation(async (cb) => cb(extended as any));
      jest.spyOn(extended, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data,
        id: data.id ?? 1,
      }));

      const mut = extended.buffer();
      const user = new ValidatedUser();
      user.name = undefined as any; // Would fail validation
      user.age = 25;

      mut.persist(user);
      // Should NOT throw — validation is disabled
      const result = await mut.flush();
      expect(result.inserts).toBe(1);
    });

    it("should not execute any DB operations when validation fails", async () => {
      const em = createEmWithEntities(ValidatedUser);
      const extended = em.extend(bufferPlugin({ validateBeforeFlush: true }));
      const txSpy = jest.spyOn(extended, "transaction").mockImplementation(async (cb) => cb(extended as any));
      const saveSpy = jest.spyOn(extended, "save").mockImplementation(async (_e: any, data: any) => ({
        ...data,
        id: data.id ?? 1,
      }));

      const mut = extended.buffer();
      const user = new ValidatedUser();
      user.name = undefined as any; // violation
      user.age = 25;

      mut.persist(user);
      try { await mut.flush(); } catch (_) { /* expected */ }

      // DB should never be touched
      expect(txSpy).not.toHaveBeenCalled();
      expect(saveSpy).not.toHaveBeenCalled();
    });
  });
});
