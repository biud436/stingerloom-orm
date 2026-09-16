/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import sql from "../../src/utils/sqlTag";
import {
  defaultJsonColumnWrite,
  isJsonColumnType,
  makeDefaultArrayColumnRead,
  makeDefaultJsonColumnRead,
} from "../../src/core/JsonColumnTransformer";
import { ResultTransformer } from "../../src/core/ResultTransformer";
import { COLUMN_TOKEN } from "../../src/decorators/Column";
import { ENTITY_TOKEN } from "../../src/decorators/Entity";
import { EntityManager } from "../../src/core/EntityManager";
import { ColumnTypeRegistry } from "../../src/core/ColumnTypeRegistry";
import { p } from "../../src/core/CompiledQuery";
import { InvalidQueryError } from "../../src/errors/InvalidQueryError";

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

  describe("makeDefaultArrayColumnRead", () => {
    it("parses the JSON text MySQL and SQLite store", () => {
      const read = makeDefaultArrayColumnRead("Post", "tags");
      expect(read('["a","b"]')).toEqual(["a", "b"]);
      expect(read("[]")).toEqual([]);
      expect(read(null)).toBeNull();
    });

    it("passes a pg-parsed array through", () => {
      const read = makeDefaultArrayColumnRead("Post", "tags");
      const arr = ["a", "b"];
      expect(read(arr)).toBe(arr);
    });

    it("returns an unparsed PostgreSQL array literal as-is, without a warning", () => {
      const read = makeDefaultArrayColumnRead("Post", "moods");
      const warnSpy = jest.spyOn(console, "log").mockImplementation();

      expect(read("{happy,sad}")).toBe("{happy,sad}");
      expect(
        warnSpy.mock.calls.filter((c) => String(c[0]).includes("Failed to JSON.parse")),
      ).toHaveLength(0);

      warnSpy.mockRestore();
    });

    it("returns a malformed legacy value with the JSON parse warning", () => {
      const read = makeDefaultArrayColumnRead("Post", "legacy");
      const warnSpy = jest.spyOn(console, "log").mockImplementation();

      expect(read("a")).toBe("a");
      expect(
        warnSpy.mock.calls.filter((c) => String(c[0]).includes("Failed to JSON.parse")),
      ).toHaveLength(1);

      warnSpy.mockRestore();
    });
  });

  describe("ResultTransformer JSON column round-trip", () => {
    function defineEntity(name: string, columnType: "json" | "jsonb" | "array") {
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

    it('parses type: "array" JSON text (MySQL / SQLite path)', () => {
      const Item = defineEntity("ArrayReadItem", "array");
      const rt = new ResultTransformer();
      const result = rt.toEntity(Item as any, {
        results: [{ id: 1, payload: '["x","y"]' }],
        fields: [],
      });
      expect((result as any).payload).toEqual(["x", "y"]);
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

  // The value a write transform leaves is checked before it is bound: an
  // array or object on a column that cannot store it throws instead of being
  // spread over the bind parameters (SQLite / MySQL) or stored as literal
  // text (PostgreSQL). The EntityManager here never connects; the mocked
  // client reports "mysql".
  describe("EntityManager applyWriteTransform — non-scalar bind guard", () => {
    let em: EntityManager;
    class GuardItem {}

    const column = (
      propertyKey: string,
      type: string,
      extra: Record<string, unknown> = {},
    ) => ({
      target: GuardItem.prototype,
      propertyKey,
      name: propertyKey,
      options: { type, nullable: true },
      type: Object,
      ...extra,
    });

    const write = (col: unknown, value: unknown, site?: string) =>
      (em as any).applyWriteTransform(col, value, site);

    const errorOf = (run: () => unknown): Error => {
      try {
        run();
      } catch (err) {
        return err as Error;
      }
      throw new Error("expected the write transform to throw");
    };

    beforeEach(() => {
      em = new EntityManager();
    });

    afterEach(() => {
      (em as any).dbType = undefined;
    });

    it("rejects an array on a text column, naming the column", () => {
      const err = errorOf(() => write(column("tags", "text"), ["a", "b"]));
      expect(err).toBeInstanceOf(InvalidQueryError);
      expect(err.message).toContain('GuardItem.tags is a "text" column but received an array');
      expect(err.message).toContain("mysql2 would expand it into a list of 2 values");
      expect(err.message).toContain('type: "json"');
    });

    it("rejects a plain object and a nested DTO instance on a text column", () => {
      class MetaDto {
        k = 1;
      }
      for (const value of [{ k: 1 }, Object.create(null), new MetaDto(), new Map()]) {
        const err = errorOf(() => write(column("meta", "text"), value));
        expect(err).toBeInstanceOf(InvalidQueryError);
        expect(err.message).toContain("GuardItem.meta");
        expect(err.message).toContain('mysql2 would send "[object Object]"');
      }
    });

    it("rejects an array on a scalar column of any type", () => {
      for (const type of ["varchar", "int", "datetime", "uuid", "enum"]) {
        expect(() => write(column("v", type), [1])).toThrow(InvalidQueryError);
      }
      expect(errorOf(() => write(column("v", "int"), [1])).message).toContain(
        'is an "int" column',
      );
    });

    it("lets scalar-like values through", () => {
      class Decimal {
        constructor(private readonly v: string) {}
        toString() {
          return this.v;
        }
      }
      class Temporalish {
        toJSON() {
          return "2026-01-01";
        }
      }
      const fragment = sql`NOW()`;
      const placeholder = p("id");
      const col = column("v", "text");

      expect(write(col, fragment)).toBe(fragment);
      expect(write(col, placeholder)).toBe(placeholder);
      const date = new Date();
      expect(write(col, date)).toBe(date);
      const buf = Buffer.from("x");
      expect(write(column("b", "blob"), buf)).toBe(buf);
      const bytes = new Uint8Array([1]);
      expect(write(column("b", "blob"), bytes)).toBe(bytes);
      expect(write(col, 10n)).toBe(10n);
      const dec = new Decimal("1.50");
      expect(write(col, dec)).toBe(dec);
      const temporal = new Temporalish();
      expect(write(col, temporal)).toBe(temporal);
    });

    it("does not resolve the dialect for scalar values or serialized JSON", () => {
      const spy = jest.spyOn((em as any)._ctx, "getDialect");

      write(column("v", "text"), "plain");
      write(column("v", "text"), new Date());
      write(column("j", "json"), { a: 1 });
      write(column("v", "text"), null);

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("checks the value a transformer returns", () => {
      const joined = column("tags", "text", {
        transformer: { to: (v: string[]) => v.join(",") },
      });
      expect(write(joined, ["a", "b"])).toBe("a,b");

      const leaky = column("tags", "text", { transformer: { to: (v: unknown) => v } });
      expect(errorOf(() => write(leaky, ["a"])).message).toContain(
        "its write transformer returned an array",
      );
    });

    it("rejects an object a transformer leaves for a json column on MySQL / SQLite", () => {
      const col = column("payload", "json", { transformer: { to: (v: unknown) => v } });
      const err = errorOf(() => write(col, { a: 1 }));
      expect(err).toBeInstanceOf(InvalidQueryError);
      expect(err.message).toContain("MySQL stores this column as JSON text");
      expect(err.message).toContain("transformer.to()");
    });

    it('serializes type: "array" as JSON outside PostgreSQL', () => {
      expect(write(column("labels", "array"), ["x", "y"])).toBe('["x","y"]');
      expect(write(column("labels", "array"), null)).toBeNull();
    });

    /**
     * A fragment is spliced into the statement and a placeholder is filled in
     * at execute time; neither is a value, so serializing one would store the
     * marker object itself.
     */
    it("leaves a sql fragment and a placeholder out of the JSON serialization", () => {
      const fragment = sql`json_array('a','b')`;
      const placeholder = p("tags");
      for (const type of ["json", "jsonb", "array"]) {
        expect(write(column("tags", type), fragment)).toBe(fragment);
        expect(write(column("tags", type), placeholder)).toBe(placeholder);
      }
    });

    it("leaves a sql fragment out of an explicit transformer.to", () => {
      const fragment = sql`NOW()`;
      const col = column("at", "datetime", {
        transformer: { to: () => "transformed" },
      });
      expect(write(col, fragment)).toBe(fragment);
    });

    it("names the operation that produced a rejected value", () => {
      const err = errorOf(() => write(column("tags", "text"), ["a"], "save()"));
      expect(err.message).toContain(
        'GuardItem.tags is a "text" column but save() received an array',
      );
    });

    it("names the operation when a write transformer produced the value", () => {
      const leaky = column("tags", "text", { transformer: { to: (v: unknown) => v } });
      const err = errorOf(() => write(leaky, ["a"], "updateMany()"));
      expect(err.message).toContain(
        "updateMany() bound what its write transformer returned, an array",
      );
    });

    describe("on PostgreSQL", () => {
      beforeEach(() => {
        (em as any).dbType = "postgres";
      });

      it('binds a native array for type: "array"', () => {
        const arr = ["x", "y"];
        expect(write(column("labels", "array"), arr)).toBe(arr);
      });

      it('rejects an object for type: "array"', () => {
        expect(errorOf(() => write(column("labels", "array"), { a: 1 })).message).toContain(
          "PostgreSQL binds only an array to an array column",
        );
      });

      it("accepts an object a transformer leaves for json / jsonb", () => {
        const obj = { a: 1 };
        const col = column("payload", "jsonb", { transformer: { to: (v: unknown) => v } });
        expect(write(col, obj)).toBe(obj);
      });

      it("rejects an array a transformer leaves for json", () => {
        const col = column("payload", "json", { transformer: { to: (v: unknown) => v } });
        expect(errorOf(() => write(col, [1, 2])).message).toContain("not valid JSON");
      });

      it("rejects an object on a text column", () => {
        const err = errorOf(() => write(column("meta", "text"), { k: 1 }));
        expect(err.message).toContain("pg would send its JSON text");
      });

      it("leaves a registered custom column type unchecked", () => {
        const registry = ColumnTypeRegistry.getInstance();
        registry.register("zz_guard_point", { postgres: "point" });
        try {
          const point = { x: 1, y: 2 };
          expect(write(column("at", "zz_guard_point"), point)).toBe(point);
        } finally {
          registry.unregister("zz_guard_point");
        }
      });
    });

    it("checks a registered custom column type outside PostgreSQL", () => {
      const registry = ColumnTypeRegistry.getInstance();
      registry.register("zz_guard_point", { mysql: "POINT" });
      try {
        expect(() => write(column("at", "zz_guard_point"), { x: 1 })).toThrow(
          InvalidQueryError,
        );
      } finally {
        registry.unregister("zz_guard_point");
      }
    });
  });
});
