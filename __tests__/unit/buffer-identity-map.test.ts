/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { IdentityMapManager } from "../../src/core/plugin/buffer/IdentityMapManager";
import { PluginContext } from "../../src/core/plugin/PluginContext";
import { COLUMN_TOKEN } from "../../src/decorators/Column";
import { ENTITY_TOKEN } from "../../src/decorators/Entity";

// ── Test Entity Definitions ─────────────────────────────────────

class User {
  id!: number;
  name!: string;
  email!: string;
}

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

// Entity with column name different from property key
class Profile {
  id!: number;
  fullName!: string;
}

Reflect.defineMetadata(ENTITY_TOKEN, { name: "Profile", tableName: "profiles" }, Profile);
Reflect.defineMetadata(
  COLUMN_TOKEN,
  [
    { target: Profile, name: "id", propertyKey: "id", type: Number, options: { primary: true } },
    { target: Profile, name: "full_name", propertyKey: "fullName", type: String, options: {} },
  ],
  Profile.prototype,
);

// Entity with no columns metadata at all
class Ghost {
  phantom!: string;
}

Reflect.defineMetadata(ENTITY_TOKEN, { name: "Ghost", tableName: "ghosts" }, Ghost);
// Intentionally no COLUMN_TOKEN metadata

// Unregistered entity (not in getEntities())
class Unregistered {
  id!: number;
}

Reflect.defineMetadata(ENTITY_TOKEN, { name: "Unregistered", tableName: "unregistered" }, Unregistered);
Reflect.defineMetadata(
  COLUMN_TOKEN,
  [
    { target: Unregistered, name: "id", propertyKey: "id", type: Number, options: { primary: true } },
  ],
  Unregistered.prototype,
);

// ── Mock PluginContext ───────────────────────────────────────────

const registeredEntities = [User, OrderItem, Profile, Ghost];

const mockCtx: PluginContext = {
  getEntities: () => registeredEntities,
  em: {} as any,
  driver: undefined,
  events: {} as any,
  connectionName: "default",
  addSubscriber: jest.fn(),
  removeSubscriber: jest.fn(),
  getPlugin: jest.fn(),
  isMySqlFamily: jest.fn().mockReturnValue(false),
  isPostgres: jest.fn().mockReturnValue(false),
  isSqlite: jest.fn().mockReturnValue(false),
  wrap: jest.fn((id: string) => `"${id}"`),
  wrapTable: jest.fn((t: string) => `"${t}"`),
  executeInTransaction: jest.fn(),
  executeReadOnly: jest.fn(),
  getEntityMetadata: jest.fn().mockReturnValue(null),
  registerPlaceholder: jest.fn(),
};

// ── Tests ────────────────────────────────────────────────────────

describe("IdentityMapManager", () => {
  let mgr: IdentityMapManager;

  beforeEach(() => {
    mgr = new IdentityMapManager(mockCtx);
  });

  // ── validateEntity ───────────────────────────────────────────

  describe("validateEntity()", () => {
    it("should accept a registered entity class", () => {
      expect(() => mgr.validateEntity(User)).not.toThrow();
    });

    it("should accept all registered entity classes", () => {
      for (const cls of registeredEntities) {
        expect(() => mgr.validateEntity(cls)).not.toThrow();
      }
    });

    it("should throw for an unregistered entity class", () => {
      expect(() => mgr.validateEntity(Unregistered)).toThrow(
        /Cannot track instance of "Unregistered": not a registered entity/,
      );
    });
  });

  // ── getColumnInfo ────────────────────────────────────────────

  describe("getColumnInfo()", () => {
    it("should return column names and pk columns for a simple entity", () => {
      const info = mgr.getColumnInfo(User);
      expect(info.columnNames).toEqual(["id", "name", "email"]);
      expect(info.pkColumns).toEqual(["id"]);
    });

    it("should return multiple pk columns for composite PK entity", () => {
      const info = mgr.getColumnInfo(OrderItem);
      expect(info.pkColumns).toEqual(["orderId", "productId"]);
      expect(info.columnNames).toEqual(["orderId", "productId", "quantity"]);
    });

    it("should return the property key, not the DB column name, so instance access works", () => {
      const info = mgr.getColumnInfo(Profile);
      // Profile.fullName maps to DB column "full_name". getColumnInfo must
      // return the PROPERTY key — the buffer reads instance.fullName and hands
      // data to em.save (which maps property → column). Returning the DB name
      // made instance["full_name"] undefined, silently dropping the column and
      // throwing on a camelCase PK.
      expect(info.columnNames).toContain("fullName");
      expect(info.columnNames).not.toContain("full_name");
      expect(info.columnNames).toContain("id");
    });

    it("getColumnBindings() pairs each property key with its DB column name", () => {
      const bindings = mgr.getColumnBindings(Profile);
      const full = bindings.find((b) => b.prop === "fullName");
      expect(full).toBeDefined();
      // The property is "fullName"; the raw-SQL (batch) paths must emit the DB
      // column "full_name" as the identifier.
      expect(full!.column).toBe("full_name");
    });

    it("should return empty arrays when no COLUMN_TOKEN metadata exists", () => {
      const info = mgr.getColumnInfo(Ghost);
      expect(info.columnNames).toEqual([]);
      expect(info.pkColumns).toEqual([]);
    });
  });

  // ── buildIdentityKey ─────────────────────────────────────────

  describe("buildIdentityKey()", () => {
    it("should produce 'ClassName:pk=value' format for single PK", () => {
      const user = Object.assign(new User(), { id: 42, name: "Alice" });
      const key = mgr.buildIdentityKey(User, user, ["id"]);
      expect(key).toBe("User:id=42");
    });

    it("should produce 'ClassName:pk1=v1,pk2=v2' format for composite PK", () => {
      const item = Object.assign(new OrderItem(), { orderId: 1, productId: 2, quantity: 10 });
      const key = mgr.buildIdentityKey(OrderItem, item, ["orderId", "productId"]);
      expect(key).toBe("OrderItem:orderId=1,productId=2");
    });

    it("should throw when a PK column is null", () => {
      const user = Object.assign(new User(), { id: null, name: "Alice" });
      expect(() => mgr.buildIdentityKey(User, user, ["id"])).toThrow(
        /PK column "id" is null/,
      );
    });

    it("should throw when a PK column is undefined", () => {
      const user = Object.assign(new User(), { name: "Alice" });
      expect(() => mgr.buildIdentityKey(User, user, ["id"])).toThrow(
        /PK column "id" is undefined/,
      );
    });
  });

  // ── buildPkWhere ─────────────────────────────────────────────

  describe("buildPkWhere()", () => {
    it("should return { pkCol: value } for single PK", () => {
      const user = Object.assign(new User(), { id: 7, name: "Bob" });
      expect(mgr.buildPkWhere(user, ["id"])).toEqual({ id: 7 });
    });

    it("should return all PK columns for composite PK", () => {
      const item = Object.assign(new OrderItem(), { orderId: 3, productId: 5, quantity: 1 });
      expect(mgr.buildPkWhere(item, ["orderId", "productId"])).toEqual({
        orderId: 3,
        productId: 5,
      });
    });
  });

  // ── extractColumnData ────────────────────────────────────────

  describe("extractColumnData()", () => {
    it("should extract only declared column values", () => {
      const user = Object.assign(new User(), {
        id: 1,
        name: "Alice",
        email: "alice@example.com",
        extraField: "should be ignored",
      });
      const data = mgr.extractColumnData(user, ["id", "name", "email"]);
      expect(data).toEqual({ id: 1, name: "Alice", email: "alice@example.com" });
      expect(data).not.toHaveProperty("extraField");
    });

    it("should skip undefined values", () => {
      const user = Object.assign(new User(), { id: 1, name: "Alice" });
      // email is undefined
      const data = mgr.extractColumnData(user, ["id", "name", "email"]);
      expect(data).toEqual({ id: 1, name: "Alice" });
      expect(data).not.toHaveProperty("email");
    });

    it("should include null values (only undefined is skipped)", () => {
      const user = Object.assign(new User(), { id: 1, name: null, email: "a@b.com" });
      const data = mgr.extractColumnData(user, ["id", "name", "email"]);
      expect(data).toEqual({ id: 1, name: null, email: "a@b.com" });
    });
  });

  // ── matchesWhere ─────────────────────────────────────────────

  describe("matchesWhere()", () => {
    it("should return true when all criteria match", () => {
      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.com" });
      expect(mgr.matchesWhere(user, { id: 1, name: "Alice" })).toBe(true);
    });

    it("should return false when any criterion does not match", () => {
      const user = Object.assign(new User(), { id: 1, name: "Alice", email: "a@b.com" });
      expect(mgr.matchesWhere(user, { id: 1, name: "Bob" })).toBe(false);
    });

    it("should return true for empty where clause", () => {
      const user = Object.assign(new User(), { id: 1, name: "Alice" });
      expect(mgr.matchesWhere(user, {})).toBe(true);
    });

    it("should use strict equality (===)", () => {
      const user = Object.assign(new User(), { id: 1, name: "Alice" });
      // "1" !== 1
      expect(mgr.matchesWhere(user, { id: "1" as any })).toBe(false);
    });
  });

  // ── getParentPkValue ─────────────────────────────────────────

  describe("getParentPkValue()", () => {
    it("should return scalar for single-column PK", () => {
      const user = Object.assign(new User(), { id: 42, name: "Alice" });
      expect(mgr.getParentPkValue(user, User)).toBe(42);
    });

    it("should return object for composite PK", () => {
      const item = Object.assign(new OrderItem(), { orderId: 1, productId: 2, quantity: 5 });
      expect(mgr.getParentPkValue(item, OrderItem)).toEqual({ orderId: 1, productId: 2 });
    });
  });

  // ── LRU Eviction (#237) ──────────────────────────────────────

  describe("LRU eviction (maxSize)", () => {
    it("should not evict when maxSize is undefined (unlimited)", () => {
      // maxSize is undefined by default
      for (let i = 1; i <= 100; i++) {
        const u = Object.assign(new User(), { id: i, name: `User${i}`, email: `u${i}@test.com` });
        const key = mgr.buildIdentityKey(User, u, ["id"]);
        mgr.identityMap.set(key, u);
      }
      mgr.evictIfNeeded();
      expect(mgr.identityMap.size).toBe(100);
    });

    it("should evict oldest clean entries when exceeding maxSize", () => {
      mgr.setMaxSize(5);
      const strategy = {
        snapshot: (inst: any, cols: string[]) => {
          const s: Record<string, any> = {};
          for (const c of cols) s[c] = inst[c];
          return s;
        },
        diff: () => null,
      };
      const tracked = new Map<any, any>();
      mgr.setTrackedEntries(tracked, strategy);

      // Add 10 clean entries (no trackedEntries → all evictable)
      for (let i = 1; i <= 10; i++) {
        const u = Object.assign(new User(), { id: i, name: `User${i}`, email: `u${i}@test.com` });
        const key = mgr.buildIdentityKey(User, u, ["id"]);
        mgr.identityMap.set(key, u);
        mgr.stateMap.set(u, "MANAGED");
      }
      expect(mgr.identityMap.size).toBe(10);

      mgr.evictIfNeeded();
      expect(mgr.identityMap.size).toBe(5);

      // The oldest 5 (id=1..5) should be evicted, newest 5 (id=6..10) should remain
      for (let i = 1; i <= 5; i++) {
        expect(mgr.identityMap.has(`User:id=${i}`)).toBe(false);
      }
      for (let i = 6; i <= 10; i++) {
        expect(mgr.identityMap.has(`User:id=${i}`)).toBe(true);
      }
    });

    it("should skip dirty entities during eviction", () => {
      mgr.setMaxSize(3);
      const strategy = {
        snapshot: (inst: any, cols: string[]) => {
          const s: Record<string, any> = {};
          for (const c of cols) s[c] = inst[c];
          return s;
        },
        diff: () => null,
      };
      const tracked = new Map<any, any>();
      mgr.setTrackedEntries(tracked, strategy);

      const users: User[] = [];
      for (let i = 1; i <= 6; i++) {
        const u = Object.assign(new User(), { id: i, name: `User${i}`, email: `u${i}@test.com` });
        const key = mgr.buildIdentityKey(User, u, ["id"]);
        mgr.identityMap.set(key, u);
        mgr.stateMap.set(u, "MANAGED");
        users.push(u);
      }

      // Make user 1 and 2 dirty by tracking them with a stale snapshot
      const u1 = users[0];
      tracked.set(u1, {
        entity: User,
        instance: u1,
        snapshot: { id: 1, name: "OldName", email: "u1@test.com" }, // name differs
        columnNames: ["id", "name", "email"],
        pkColumns: ["id"],
      });

      const u2 = users[1];
      tracked.set(u2, {
        entity: User,
        instance: u2,
        snapshot: { id: 2, name: "User2", email: "u2@test.com" }, // clean
        columnNames: ["id", "name", "email"],
        pkColumns: ["id"],
        explicitDirty: true, // explicitly marked dirty
      });

      mgr.evictIfNeeded();

      // u1 (dirty snapshot) and u2 (explicitDirty) should survive
      expect(mgr.identityMap.has("User:id=1")).toBe(true);
      expect(mgr.identityMap.has("User:id=2")).toBe(true);
      // 3 evictable were evicted to reach maxSize of 3, but 2 are unevictable
      // so we can only evict clean entries: 3,4,5 (oldest clean) → keep 1,2,6
      expect(mgr.identityMap.has("User:id=6")).toBe(true);
      expect(mgr.identityMap.size).toBe(3);
    });

    it("should skip NEW and REMOVED entities during eviction", () => {
      mgr.setMaxSize(2);
      const tracked = new Map<any, any>();
      mgr.setTrackedEntries(tracked, { snapshot: () => ({}), diff: () => null });

      const u1 = Object.assign(new User(), { id: 1, name: "A", email: "a" });
      const u2 = Object.assign(new User(), { id: 2, name: "B", email: "b" });
      const u3 = Object.assign(new User(), { id: 3, name: "C", email: "c" });
      const u4 = Object.assign(new User(), { id: 4, name: "D", email: "d" });

      for (const u of [u1, u2, u3, u4]) {
        const key = mgr.buildIdentityKey(User, u, ["id"]);
        mgr.identityMap.set(key, u);
      }
      mgr.stateMap.set(u1, "NEW");
      mgr.stateMap.set(u2, "REMOVED");
      mgr.stateMap.set(u3, "MANAGED");
      mgr.stateMap.set(u4, "MANAGED");

      mgr.evictIfNeeded();
      // u1 (NEW) and u2 (REMOVED) cannot be evicted
      // u3 and u4 (both MANAGED, both evictable) get evicted to reach maxSize=2
      expect(mgr.identityMap.has("User:id=1")).toBe(true);
      expect(mgr.identityMap.has("User:id=2")).toBe(true);
      expect(mgr.identityMap.has("User:id=3")).toBe(false);
      expect(mgr.identityMap.has("User:id=4")).toBe(false);
      expect(mgr.identityMap.size).toBe(2);
    });

    it("touch() should refresh LRU order", () => {
      mgr.setMaxSize(3);
      const tracked = new Map<any, any>();
      mgr.setTrackedEntries(tracked, { snapshot: () => ({}), diff: () => null });

      for (let i = 1; i <= 3; i++) {
        const u = Object.assign(new User(), { id: i, name: `U${i}`, email: `u${i}` });
        const key = mgr.buildIdentityKey(User, u, ["id"]);
        mgr.identityMap.set(key, u);
        mgr.stateMap.set(u, "MANAGED");
      }

      // Touch id=1 to make it most-recently-used
      mgr.touch("User:id=1");

      // Add one more → triggers eviction
      const u4 = Object.assign(new User(), { id: 4, name: "U4", email: "u4" });
      mgr.identityMap.set(mgr.buildIdentityKey(User, u4, ["id"]), u4);
      mgr.stateMap.set(u4, "MANAGED");
      mgr.evictIfNeeded();

      // id=2 should be evicted (oldest after touch), id=1 should survive
      expect(mgr.identityMap.has("User:id=1")).toBe(true);
      expect(mgr.identityMap.has("User:id=2")).toBe(false);
      expect(mgr.identityMap.has("User:id=3")).toBe(true);
      expect(mgr.identityMap.has("User:id=4")).toBe(true);
    });

    it("evicted entities should have DETACHED state", () => {
      mgr.setMaxSize(1);
      const tracked = new Map<any, any>();
      mgr.setTrackedEntries(tracked, { snapshot: () => ({}), diff: () => null });

      const u1 = Object.assign(new User(), { id: 1, name: "A", email: "a" });
      const u2 = Object.assign(new User(), { id: 2, name: "B", email: "b" });

      const key1 = mgr.buildIdentityKey(User, u1, ["id"]);
      const key2 = mgr.buildIdentityKey(User, u2, ["id"]);
      mgr.identityMap.set(key1, u1);
      mgr.stateMap.set(u1, "MANAGED");
      mgr.identityMap.set(key2, u2);
      mgr.stateMap.set(u2, "MANAGED");

      mgr.evictIfNeeded();
      // Evicted entries are DELETED from stateMap (not set to DETACHED) so the
      // strong Map does not retain every instance forever. WriteBuffer.getState()
      // falls back to DETACHED for absent keys, preserving observable semantics.
      expect(mgr.stateMap.has(u1)).toBe(false);
      expect(mgr.stateMap.get(u2)).toBe("MANAGED");
    });

    it("stateMap should not grow past evictions (memory bound)", () => {
      mgr.setMaxSize(2);
      const tracked = new Map<any, any>();
      mgr.setTrackedEntries(tracked, { snapshot: () => ({}), diff: () => null });

      for (let i = 1; i <= 50; i++) {
        const u = Object.assign(new User(), { id: i, name: `U${i}`, email: `u${i}@x` });
        const key = mgr.buildIdentityKey(User, u, ["id"]);
        mgr.identityMap.set(key, u);
        mgr.stateMap.set(u, "MANAGED");
        mgr.evictIfNeeded();
      }

      expect(mgr.identityMap.size).toBe(2);
      expect(mgr.stateMap.size).toBe(2);
    });
  });

  describe("tryBuildCacheKey guards", () => {
    let mgr: IdentityMapManager;

    beforeEach(() => {
      mgr = new IdentityMapManager(mockCtx);
    });

    it("should return a key for a plain PK equality lookup", () => {
      expect(mgr.tryBuildCacheKey(User, { where: { id: 1 } } as any)).not.toBeNull();
    });

    it("should bypass the cache for onlyDeleted lookups", () => {
      expect(
        mgr.tryBuildCacheKey(User, { where: { id: 1 }, onlyDeleted: true } as any),
      ).toBeNull();
    });

    it("should bypass the cache for withoutTenantScope lookups", () => {
      expect(
        mgr.tryBuildCacheKey(User, { where: { id: 1 }, withoutTenantScope: true } as any),
      ).toBeNull();
    });
  });
});
