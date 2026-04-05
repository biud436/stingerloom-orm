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

    it("should use name field from metadata (not propertyKey) when available", () => {
      const info = mgr.getColumnInfo(Profile);
      // The metadata has name: "full_name" for the fullName property
      expect(info.columnNames).toContain("full_name");
      expect(info.columnNames).toContain("id");
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
});
