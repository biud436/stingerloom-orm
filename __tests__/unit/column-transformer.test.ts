/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import Container from "typedi";
import { EntityManager } from "../../src/core/EntityManager";
import { MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";
import { ResultTransformer } from "../../src/core/ResultTransformer";
import { COLUMN_TOKEN } from "../../src/decorators/Column";
import { ENTITY_TOKEN } from "../../src/decorators/Entity";

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

describe("Bidirectional Column Transformers (#128)", () => {
  describe("transformer.from() on read", () => {
    it("should apply transformer.from() when deserializing", () => {
      class User {}
      Reflect.defineMetadata(ENTITY_TOKEN, { name: "User" }, User);
      Reflect.defineMetadata(COLUMN_TOKEN, [
        {
          propertyKey: "id",
          name: "id",
          options: { primary: true },
          type: Number,
        },
        {
          propertyKey: "email",
          name: "email",
          options: {},
          type: String,
          transformer: {
            to: (v: string) => v.toLowerCase(),
            from: (v: string) => v.toUpperCase(),
          },
        },
      ], User.prototype);

      const rt = new ResultTransformer();
      const result = rt.toEntity(User as any, {
        results: [{ id: 1, email: "test@example.com" }],
        fields: [],
      });

      expect(result).toBeDefined();
      expect((result as any).email).toBe("TEST@EXAMPLE.COM");
    });

    it("should apply transformer.from() for multiple entities", () => {
      class Item {}
      Reflect.defineMetadata(ENTITY_TOKEN, { name: "Item" }, Item);
      Reflect.defineMetadata(COLUMN_TOKEN, [
        {
          propertyKey: "id",
          name: "id",
          options: { primary: true },
          type: Number,
        },
        {
          propertyKey: "code",
          name: "code",
          options: {},
          type: String,
          transformer: {
            to: (v: string) => v,
            from: (v: string) => `PREFIX_${v}`,
          },
        },
      ], Item.prototype);

      const rt = new ResultTransformer();
      const results = rt.toEntities(Item as any, {
        results: [
          { id: 1, code: "A" },
          { id: 2, code: "B" },
        ],
        fields: [],
      });

      expect(results).toHaveLength(2);
      expect((results[0] as any).code).toBe("PREFIX_A");
      expect((results[1] as any).code).toBe("PREFIX_B");
    });

    it("should skip null/undefined values in transformer.from()", () => {
      class NullTest {}
      Reflect.defineMetadata(ENTITY_TOKEN, { name: "NullTest" }, NullTest);
      Reflect.defineMetadata(COLUMN_TOKEN, [
        {
          propertyKey: "id",
          name: "id",
          options: { primary: true },
          type: Number,
        },
        {
          propertyKey: "data",
          name: "data",
          options: { nullable: true },
          type: String,
          transformer: {
            to: (v: any) => v,
            from: (v: any) => `transformed_${v}`,
          },
        },
      ], NullTest.prototype);

      const rt = new ResultTransformer();
      const result = rt.toEntity(NullTest as any, {
        results: [{ id: 1, data: null }],
        fields: [],
      });

      // null should not be transformed
      expect((result as any).data).toBeNull();
    });

    it("should apply legacy transform when no transformer is set", () => {
      class LegacyTest {}
      Reflect.defineMetadata(ENTITY_TOKEN, { name: "LegacyTest" }, LegacyTest);
      Reflect.defineMetadata(COLUMN_TOKEN, [
        {
          propertyKey: "id",
          name: "id",
          options: { primary: true },
          type: Number,
        },
        {
          propertyKey: "count",
          name: "count",
          options: {},
          type: Number,
          transform: (raw: unknown) => Number(raw) * 2,
        },
      ], LegacyTest.prototype);

      const rt = new ResultTransformer();
      const result = rt.toEntity(LegacyTest as any, {
        results: [{ id: 1, count: 5 }],
        fields: [],
      });

      expect((result as any).count).toBe(10);
    });

    it("transformer.from should take precedence over legacy transform", () => {
      class PrecedenceTest {}
      Reflect.defineMetadata(ENTITY_TOKEN, { name: "PrecedenceTest" }, PrecedenceTest);
      Reflect.defineMetadata(COLUMN_TOKEN, [
        {
          propertyKey: "id",
          name: "id",
          options: { primary: true },
          type: Number,
        },
        {
          propertyKey: "val",
          name: "val",
          options: {},
          type: Number,
          transform: () => 999,
          transformer: {
            to: (v: any) => v,
            from: (v: number) => v + 1,
          },
        },
      ], PrecedenceTest.prototype);

      const rt = new ResultTransformer();
      const result = rt.toEntity(PrecedenceTest as any, {
        results: [{ id: 1, val: 10 }],
        fields: [],
      });

      expect((result as any).val).toBe(11); // transformer.from, not legacy
    });
  });

  describe("transformer.to() on write", () => {
    let em: EntityManager;
    const UserClass = class User {};

    beforeEach(() => {
      MetadataLayerRegistry.reset();
      Container.reset();
      jest.clearAllMocks();
      em = new EntityManager();
      (em as any).driver = {
        wrap: (name: string) => `\`${name}\``,
      };

      const metadata = {
        name: "User",
        target: UserClass,
        columns: [
          {
            name: "id",
            propertyKey: "id",
            options: { primary: true, autoIncrement: true },
            type: Number,
          },
          {
            name: "email",
            propertyKey: "email",
            options: {},
            type: String,
            transformer: {
              to: (v: string) => v?.toLowerCase(),
              from: (v: string) => v?.toUpperCase(),
            },
          },
        ],
      };

      (em as any).resolver = {
        resolveEntityMetadata: jest.fn().mockReturnValue(metadata),
        resolveManyToOneMetadata: jest.fn().mockReturnValue([]),
        resolveOneToOneMetadata: jest.fn().mockReturnValue([]),
        resolveOneToManyMetadata: jest.fn().mockReturnValue([]),
        getCreateTimestampColumn: jest.fn().mockReturnValue(null),
        getUpdateTimestampColumn: jest.fn().mockReturnValue(null),
        getVersionColumn: jest.fn().mockReturnValue(null),
        getDeletedAtColumn: jest.fn().mockReturnValue(null),
      };

      mockQuery.mockResolvedValue({
        results: { insertId: 1, affectedRows: 1 },
        fields: [],
      });
    });

    it("should apply transformer.to() during INSERT", async () => {
      await em.save(UserClass, { email: "TEST@EXAMPLE.COM" } as any);

      expect(mockQuery).toHaveBeenCalled();
      // The SQL query object contains values — check that the transformer was applied
      const calls = mockQuery.mock.calls;
      const insertCall = calls.find((c: any[]) => {
        const sqlStr = String(c[0]?.text ?? c[0]?.sql ?? c[0]);
        return sqlStr.includes("INSERT");
      });
      expect(insertCall).toBeDefined();
      const sqlObj = insertCall![0];
      // Values in the Sql object should contain the lowercased email
      const hasLowerEmail = sqlObj.values?.some((v: any) => v === "test@example.com");
      const hasUpperEmail = sqlObj.values?.some((v: any) => v === "TEST@EXAMPLE.COM");
      expect(hasLowerEmail).toBe(true);
      expect(hasUpperEmail).toBeFalsy();
    });
  });
});
