/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import {
  defaultJsonColumnWrite,
  isJsonColumnType,
  makeDefaultJsonColumnRead,
} from "../../src/core/JsonColumnTransformer";
import { ResultTransformer } from "../../src/core/ResultTransformer";
import { COLUMN_TOKEN } from "../../src/decorators/Column";
import { ENTITY_TOKEN } from "../../src/decorators/Entity";
import { EntityManager } from "../../src/core/EntityManager";

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

const mockQuery = jest.fn();
jest.mock("../../src/dialects/TransactionSessionManager", () => ({
  TransactionSessionManager: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    query: mockQuery,
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

describe("JsonColumnTransformer", () => {
  describe("isJsonColumnType", () => {
    it("recognizes json and jsonb", () => {
      expect(isJsonColumnType("json")).toBe(true);
      expect(isJsonColumnType("jsonb")).toBe(true);
    });

    it("rejects everything else", () => {
      expect(isJsonColumnType("varchar")).toBe(false);
      expect(isJsonColumnType("text")).toBe(false);
      expect(isJsonColumnType(undefined)).toBe(false);
      expect(isJsonColumnType(null)).toBe(false);
      expect(isJsonColumnType("")).toBe(false);
    });
  });

  describe("defaultJsonColumnWrite", () => {
    it("preserves null and undefined", () => {
      expect(defaultJsonColumnWrite(null)).toBeNull();
      expect(defaultJsonColumnWrite(undefined)).toBeUndefined();
    });

    it("passes strings through (already serialized)", () => {
      expect(defaultJsonColumnWrite('{"foo":"bar"}')).toBe('{"foo":"bar"}');
      expect(defaultJsonColumnWrite("plain")).toBe("plain");
    });

    it("stringifies objects", () => {
      expect(defaultJsonColumnWrite({ a: 1, b: "x" })).toBe('{"a":1,"b":"x"}');
    });

    it("stringifies arrays", () => {
      expect(defaultJsonColumnWrite([1, 2, 3])).toBe("[1,2,3]");
    });

    it("stringifies nested structures", () => {
      const nested = { a: { b: [1, 2] } };
      expect(defaultJsonColumnWrite(nested)).toBe('{"a":{"b":[1,2]}}');
    });

    it("stringifies primitives", () => {
      expect(defaultJsonColumnWrite(true)).toBe("true");
      expect(defaultJsonColumnWrite(42)).toBe("42");
    });
  });

  describe("makeDefaultJsonColumnRead", () => {
    it("parses string payloads into JS values", () => {
      const read = makeDefaultJsonColumnRead("Issue", "customFields");
      expect(read('{"a":1}')).toEqual({ a: 1 });
      expect(read("[1,2,3]")).toEqual([1, 2, 3]);
      expect(read("true")).toBe(true);
      expect(read("42")).toBe(42);
    });

    it("preserves null and undefined", () => {
      const read = makeDefaultJsonColumnRead("Issue", "customFields");
      expect(read(null)).toBeNull();
      expect(read(undefined)).toBeUndefined();
    });

    it("passes parsed objects through (pg jsonb already returns objects)", () => {
      const read = makeDefaultJsonColumnRead("Issue", "customFields");
      const obj = { a: 1 };
      expect(read(obj)).toBe(obj);
    });

    it("returns the raw string and warns on malformed JSON", () => {
      const read = makeDefaultJsonColumnRead("Issue", "customFields");
      const warnSpy = jest.spyOn(console, "log").mockImplementation();

      expect(read("not-json")).toBe("not-json");

      const warnings = warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes("Failed to JSON.parse"),
      );
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0][0])).toContain("Issue.customFields");

      warnSpy.mockRestore();
    });

    it("warns at most once even when multiple rows are malformed", () => {
      const read = makeDefaultJsonColumnRead("Issue", "customFields");
      const warnSpy = jest.spyOn(console, "log").mockImplementation();

      read("not-json-1");
      read("not-json-2");
      read("not-json-3");

      const warnings = warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes("Failed to JSON.parse"),
      );
      expect(warnings).toHaveLength(1);

      warnSpy.mockRestore();
    });
  });

  describe("ResultTransformer JSON column round-trip", () => {
    function defineEntity(name: string, columnType: "json" | "jsonb") {
      const Cls = class {} as new () => { id: number; payload: unknown };
      Object.defineProperty(Cls, "name", { value: name });
      Reflect.defineMetadata(ENTITY_TOKEN, { name }, Cls);
      Reflect.defineMetadata(
        COLUMN_TOKEN,
        [
          {
            propertyKey: "id",
            name: "id",
            options: { primary: true, type: "int" },
            type: Number,
          },
          {
            propertyKey: "payload",
            name: "payload",
            options: { type: columnType, nullable: true },
            type: Object,
          },
        ],
        Cls.prototype,
      );
      return Cls;
    }

    it("auto-parses string JSON into objects (mysql2 / sqlite path)", () => {
      const Item = defineEntity("JsonReadItem", "json");
      const rt = new ResultTransformer();
      const result = rt.toEntity(Item as any, {
        results: [{ id: 1, payload: '{"a":1,"b":[2,3]}' }],
        fields: [],
      });
      expect((result as any).payload).toEqual({ a: 1, b: [2, 3] });
    });

    it("passes already-parsed objects through (pg jsonb path)", () => {
      const Item = defineEntity("JsonbReadItem", "jsonb");
      const rt = new ResultTransformer();
      const obj = { a: 1 };
      const result = rt.toEntity(Item as any, {
        results: [{ id: 1, payload: obj }],
        fields: [],
      });
      expect((result as any).payload).toEqual({ a: 1 });
    });

    it("preserves null for nullable JSON columns", () => {
      const Item = defineEntity("NullableJsonItem", "json");
      const rt = new ResultTransformer();
      const result = rt.toEntity(Item as any, {
        results: [{ id: 1, payload: null }],
        fields: [],
      });
      expect((result as any).payload).toBeNull();
    });

    it("yields the raw string when a legacy row is malformed", () => {
      const Item = defineEntity("MalformedJsonItem", "json");
      const warnSpy = jest.spyOn(console, "log").mockImplementation();
      const rt = new ResultTransformer();
      const result = rt.toEntity(Item as any, {
        results: [{ id: 1, payload: "not-json" }],
        fields: [],
      });
      expect((result as any).payload).toBe("not-json");
      warnSpy.mockRestore();
    });

    it("explicit transformer.from wins over the JSON default", () => {
      const Cls = class {} as new () => { id: number; payload: unknown };
      Object.defineProperty(Cls, "name", { value: "ExplicitFromWins" });
      Reflect.defineMetadata(ENTITY_TOKEN, { name: "ExplicitFromWins" }, Cls);
      Reflect.defineMetadata(
        COLUMN_TOKEN,
        [
          { propertyKey: "id", name: "id", options: { primary: true }, type: Number },
          {
            propertyKey: "payload",
            name: "payload",
            options: { type: "json", nullable: true },
            type: Object,
            transformer: {
              from: (raw: unknown) => ({ explicit: true, raw }),
            },
          },
        ],
        Cls.prototype,
      );
      const rt = new ResultTransformer();
      const result = rt.toEntity(Cls as any, {
        results: [{ id: 1, payload: '{"a":1}' }],
        fields: [],
      });
      // Default JSON parse never ran — explicit `from` got the raw string.
      expect((result as any).payload).toEqual({ explicit: true, raw: '{"a":1}' });
    });

    it("explicit transformer.to + default JSON from cooperate", () => {
      // User supplies only `to`; the default JSON `from` should still apply.
      const Cls = class {} as new () => { id: number; payload: unknown };
      Object.defineProperty(Cls, "name", { value: "PartialTransformer" });
      Reflect.defineMetadata(ENTITY_TOKEN, { name: "PartialTransformer" }, Cls);
      Reflect.defineMetadata(
        COLUMN_TOKEN,
        [
          { propertyKey: "id", name: "id", options: { primary: true }, type: Number },
          {
            propertyKey: "payload",
            name: "payload",
            options: { type: "json", nullable: true },
            type: Object,
            transformer: {
              // Only `to` is provided — read side falls through to JSON default.
              to: (v: unknown) => (v == null ? v : JSON.stringify(v)),
            },
          },
        ],
        Cls.prototype,
      );
      const rt = new ResultTransformer();
      const result = rt.toEntity(Cls as any, {
        results: [{ id: 1, payload: '{"x":42}' }],
        fields: [],
      });
      expect((result as any).payload).toEqual({ x: 42 });
    });
  });

  describe("EntityManager applyWriteTransform — JSON default", () => {
    let em: EntityManager;
    const Cls = class JsonWriteItem {};

    beforeEach(() => {
      em = new EntityManager();
    });

    it("stringifies plain objects on write", () => {
      const col = {
        propertyKey: "payload",
        name: "payload",
        options: { type: "json", nullable: true },
        type: Object,
      };
      const out = (em as any).applyWriteTransform(col, { foo: "bar" });
      expect(out).toBe('{"foo":"bar"}');
    });

    it("preserves null/undefined", () => {
      const col = {
        propertyKey: "payload",
        name: "payload",
        options: { type: "jsonb", nullable: true },
        type: Object,
      };
      expect((em as any).applyWriteTransform(col, null)).toBeNull();
      expect((em as any).applyWriteTransform(col, undefined)).toBeUndefined();
    });

    it("passes pre-serialized strings through", () => {
      const col = {
        propertyKey: "payload",
        name: "payload",
        options: { type: "json" },
        type: Object,
      };
      // Legacy code that still does JSON.stringify(...) manually must not be
      // double-encoded.
      expect((em as any).applyWriteTransform(col, '{"k":"v"}')).toBe('{"k":"v"}');
    });

    it("explicit transformer.to wins over the JSON default", () => {
      const col = {
        propertyKey: "payload",
        name: "payload",
        options: { type: "json" },
        type: Object,
        transformer: { to: (_v: unknown) => "EXPLICIT" },
      };
      expect((em as any).applyWriteTransform(col, { foo: "bar" })).toBe("EXPLICIT");
    });

    it("does not stringify non-JSON columns", () => {
      const col = {
        propertyKey: "name",
        name: "name",
        options: { type: "varchar" },
        type: String,
      };
      expect((em as any).applyWriteTransform(col, "hello")).toBe("hello");
    });

    void Cls;
  });
});
