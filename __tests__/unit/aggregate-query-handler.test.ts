/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { AggregateQueryHandler } from "../../src/core/AggregateQueryHandler";
import { EntityManagerInternals } from "../../src/core/EntityManagerInternals";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { EntityMetadataNotFoundError } from "../../src/errors/EntityMetadataNotFoundError";
import { ENTITY_TOKEN } from "../../src/decorators/Entity";

// ---------------------------------------------------------------------------
// Helpers: mock EntityManagerInternals & RelationMetadataResolver
// ---------------------------------------------------------------------------
function createMockCtx(
  overrides?: Partial<EntityManagerInternals>,
): EntityManagerInternals {
  return {
    wrap: jest.fn((col: string) => `\`${col}\``),
    wrapTable: jest.fn((t: string) => `\`${t}\``),
    isMySqlFamily: jest.fn().mockReturnValue(true),
    isPostgres: jest.fn().mockReturnValue(false),
    getDriver: jest.fn().mockReturnValue(undefined),
    getSynchronize: jest.fn().mockReturnValue(false),
    getDialect: jest.fn().mockReturnValue("mysql"),
    getSchema: jest.fn().mockReturnValue(undefined),
    getConnection: jest.fn().mockReturnValue(undefined),
    executeInTransaction: jest
      .fn()
      .mockImplementation((fn: any, session?: any) => {
        if (session) return fn(session);
        const mockSession = { query: jest.fn() };
        return fn(mockSession);
      }),
    executeReadOnly: jest.fn().mockImplementation((fn: any) => {
      const mockSession = { query: jest.fn() };
      return fn(mockSession);
    }),
    beginTrackQuery: jest.fn(),
    trackQuery: jest.fn(),
    getReadNode: jest.fn().mockReturnValue(null),
    getEntities: jest.fn().mockReturnValue([]),
    getNameStrategy: jest.fn().mockReturnValue(""),
    resolveSelectColumns: jest.fn().mockReturnValue([]),
    markDirty: jest.fn(),
    findInternal: jest.fn(),
    findOneInternal: jest.fn(),
    save: jest.fn(),
    saveWithSession: jest.fn(),
    find: jest.fn(),
    delete: jest.fn(),
    getTenantColumnConfig: jest.fn().mockReturnValue(null),
    buildTenantWhereClause: jest.fn().mockReturnValue(null),
    ...overrides,
  } as unknown as EntityManagerInternals;
}

function createMockResolver(
  overrides?: Partial<Record<keyof RelationMetadataResolver, any>>,
): RelationMetadataResolver {
  return {
    resolveEntityMetadata: jest.fn().mockReturnValue(null),
    resolveManyToOneMetadata: jest.fn().mockReturnValue([]),
    resolveOneToManyMetadata: jest.fn().mockReturnValue([]),
    resolveManyToManyMetadata: jest.fn().mockReturnValue([]),
    resolveOneToOneMetadata: jest.fn().mockReturnValue([]),
    getDeletedAtColumn: jest.fn().mockReturnValue(null),
    getCreateTimestampColumn: jest.fn().mockReturnValue(null),
    getUpdateTimestampColumn: jest.fn().mockReturnValue(null),
    getVersionColumn: jest.fn().mockReturnValue(null),
    resolveJoinColumnsFromColumnMeta: jest.fn((_, rels) => rels),
    resolveJoinColumnsFromColumnMetaForOneToOne: jest.fn((_, rels) => rels),
    resolveManyToManyJoinTable: jest.fn().mockReturnValue(null),
    ...overrides,
  } as unknown as RelationMetadataResolver;
}

// ---------------------------------------------------------------------------
// Test entity class
// ---------------------------------------------------------------------------
class Product {
  id!: number;
  price!: number;
  quantity!: number;
}

const productMetadata = {
  name: "product",
  target: Product,
  columns: [
    { name: "id", options: { primary: true, autoIncrement: true } },
    { name: "price", options: {} },
    { name: "quantity", options: {} },
  ],
};

// ==========================================================================
// describe: aggregate()
// ==========================================================================
describe("AggregateQueryHandler.aggregate()", () => {
  let ctx: EntityManagerInternals;
  let resolver: RelationMetadataResolver;
  let handler: AggregateQueryHandler;

  beforeEach(() => {
    ctx = createMockCtx();
    resolver = createMockResolver();
    handler = new AggregateQueryHandler(resolver, ctx);
  });

  it("should generate correct SQL structure for COUNT(*)", async () => {
    (resolver.resolveEntityMetadata as jest.Mock).mockReturnValue(productMetadata);

    let capturedQuery: any;
    (ctx.executeReadOnly as jest.Mock).mockImplementation(async (fn: any) => {
      const mockSession = {
        query: jest.fn().mockResolvedValue({
          results: [{ result: 5 }],
          fields: [],
        }),
      };
      capturedQuery = mockSession.query;
      return fn(mockSession);
    });

    const result = await handler.aggregate(Product, "COUNT", "*");

    expect(result).toBe(5);
    expect(capturedQuery).toHaveBeenCalledTimes(1);

    const sqlObj = capturedQuery.mock.calls[0][0];
    const sqlText = sqlObj.text || sqlObj.sql || String(sqlObj);
    expect(sqlText).toContain("COUNT(*)");
    expect(sqlText).toContain("`product`");
  });

  it("should generate correct SQL for SUM with a field name", async () => {
    (resolver.resolveEntityMetadata as jest.Mock).mockReturnValue(productMetadata);

    let capturedQuery: any;
    (ctx.executeReadOnly as jest.Mock).mockImplementation(async (fn: any) => {
      const mockSession = {
        query: jest.fn().mockResolvedValue({
          results: [{ result: 1500 }],
          fields: [],
        }),
      };
      capturedQuery = mockSession.query;
      return fn(mockSession);
    });

    const result = await handler.aggregate(Product, "SUM", "price");

    expect(result).toBe(1500);
    const sqlText =
      capturedQuery.mock.calls[0][0].text ||
      capturedQuery.mock.calls[0][0].sql ||
      String(capturedQuery.mock.calls[0][0]);
    expect(sqlText).toContain("SUM(`price`)");
  });

  it("should return 0 for empty results", async () => {
    (resolver.resolveEntityMetadata as jest.Mock).mockReturnValue(productMetadata);

    (ctx.executeReadOnly as jest.Mock).mockImplementation(async (fn: any) => {
      const mockSession = {
        query: jest.fn().mockResolvedValue({
          results: [],
          fields: [],
        }),
      };
      return fn(mockSession);
    });

    const result = await handler.aggregate(Product, "COUNT", "*");
    expect(result).toBe(0);
  });

  it("should return 0 for null result value", async () => {
    (resolver.resolveEntityMetadata as jest.Mock).mockReturnValue(productMetadata);

    (ctx.executeReadOnly as jest.Mock).mockImplementation(async (fn: any) => {
      const mockSession = {
        query: jest.fn().mockResolvedValue({
          results: [{ result: null }],
          fields: [],
        }),
      };
      return fn(mockSession);
    });

    const result = await handler.aggregate(Product, "SUM", "price");
    expect(result).toBe(0);
  });

  it("should return 0 for undefined result value", async () => {
    (resolver.resolveEntityMetadata as jest.Mock).mockReturnValue(productMetadata);

    (ctx.executeReadOnly as jest.Mock).mockImplementation(async (fn: any) => {
      const mockSession = {
        query: jest.fn().mockResolvedValue({
          results: [{ result: undefined }],
          fields: [],
        }),
      };
      return fn(mockSession);
    });

    const result = await handler.aggregate(Product, "AVG", "price");
    expect(result).toBe(0);
  });

  it("should throw EntityMetadataNotFoundError for unregistered entity", async () => {
    class UnknownEntity {}
    (resolver.resolveEntityMetadata as jest.Mock).mockReturnValue(null);

    await expect(
      handler.aggregate(UnknownEntity, "COUNT", "*"),
    ).rejects.toThrow(EntityMetadataNotFoundError);
    await expect(
      handler.aggregate(UnknownEntity, "COUNT", "*"),
    ).rejects.toThrow('Entity metadata for "UnknownEntity" does not exist.');
  });

  it("should use existing session when provided", async () => {
    (resolver.resolveEntityMetadata as jest.Mock).mockReturnValue(productMetadata);

    const fakeSession = {
      query: jest.fn().mockResolvedValue({
        results: [{ result: 10 }],
        fields: [],
      }),
    };

    (ctx.executeInTransaction as jest.Mock).mockImplementation(
      async (fn: any, session?: any) => {
        return fn(session ?? fakeSession);
      },
    );

    const result = await handler.aggregate(
      Product,
      "COUNT",
      "*",
      undefined,
      fakeSession as any,
    );

    expect(result).toBe(10);
    expect(ctx.executeInTransaction).toHaveBeenCalled();
    // executeReadOnly should NOT be called since we passed an existing session
    expect(ctx.executeReadOnly).not.toHaveBeenCalled();
  });

  it("should include WHERE clause when where is provided", async () => {
    (resolver.resolveEntityMetadata as jest.Mock).mockReturnValue(productMetadata);

    let capturedQuery: any;
    (ctx.executeReadOnly as jest.Mock).mockImplementation(async (fn: any) => {
      const mockSession = {
        query: jest.fn().mockResolvedValue({
          results: [{ result: 3 }],
          fields: [],
        }),
      };
      capturedQuery = mockSession.query;
      return fn(mockSession);
    });

    const result = await handler.aggregate(Product, "COUNT", "*", {
      price: 100,
    } as any);

    expect(result).toBe(3);
    const sqlText =
      capturedQuery.mock.calls[0][0].text ||
      capturedQuery.mock.calls[0][0].sql ||
      String(capturedQuery.mock.calls[0][0]);
    expect(sqlText).toContain("WHERE");
  });

  it("should return numeric result even if DB returns string", async () => {
    (resolver.resolveEntityMetadata as jest.Mock).mockReturnValue(productMetadata);

    (ctx.executeReadOnly as jest.Mock).mockImplementation(async (fn: any) => {
      const mockSession = {
        query: jest.fn().mockResolvedValue({
          results: [{ result: "42" }],
          fields: [],
        }),
      };
      return fn(mockSession);
    });

    const result = await handler.aggregate(Product, "COUNT", "*");
    expect(result).toBe(42);
    expect(typeof result).toBe("number");
  });
});

// ==========================================================================
// describe: convenience methods (count, sum, avg, min, max)
// ==========================================================================
describe("AggregateQueryHandler convenience methods", () => {
  let ctx: EntityManagerInternals;
  let resolver: RelationMetadataResolver;
  let handler: AggregateQueryHandler;
  let aggregateSpy: jest.SpyInstance;

  beforeEach(() => {
    ctx = createMockCtx();
    resolver = createMockResolver();
    handler = new AggregateQueryHandler(resolver, ctx);
    aggregateSpy = jest
      .spyOn(handler, "aggregate")
      .mockResolvedValue(42);
  });

  afterEach(() => {
    aggregateSpy.mockRestore();
  });

  // aggregate() signature is (entity, fn, field, where, existingSession, withDeleted).
  // Convenience methods never pass a session, so existingSession is undefined and
  // withDeleted lands in the 6th slot.
  it("count() should delegate to aggregate() with COUNT and *", async () => {
    const result = await handler.count(Product);

    expect(result).toBe(42);
    expect(aggregateSpy).toHaveBeenCalledWith(
      Product,
      "COUNT",
      "*",
      undefined,
      undefined,
      undefined,
    );
  });

  it("count() should pass where clause", async () => {
    const where = { price: 100 } as any;
    await handler.count(Product, where);

    expect(aggregateSpy).toHaveBeenCalledWith(
      Product,
      "COUNT",
      "*",
      where,
      undefined,
      undefined,
    );
  });

  it("count() should forward withDeleted opt-in", async () => {
    await handler.count(Product, undefined, true);

    expect(aggregateSpy).toHaveBeenCalledWith(
      Product,
      "COUNT",
      "*",
      undefined,
      undefined,
      true,
    );
  });

  it("sum() should delegate to aggregate() with SUM and field", async () => {
    const result = await handler.sum(Product, "price");

    expect(result).toBe(42);
    expect(aggregateSpy).toHaveBeenCalledWith(
      Product,
      "SUM",
      "price",
      undefined,
      undefined,
      undefined,
    );
  });

  it("sum() should pass where clause and withDeleted", async () => {
    const where = { quantity: 10 } as any;
    await handler.sum(Product, "price", where, true);

    expect(aggregateSpy).toHaveBeenCalledWith(
      Product,
      "SUM",
      "price",
      where,
      undefined,
      true,
    );
  });

  it("avg() should delegate to aggregate() with AVG and field", async () => {
    const result = await handler.avg(Product, "price");

    expect(result).toBe(42);
    expect(aggregateSpy).toHaveBeenCalledWith(
      Product,
      "AVG",
      "price",
      undefined,
      undefined,
      undefined,
    );
  });

  it("avg() should pass where clause", async () => {
    const where = { id: 1 } as any;
    await handler.avg(Product, "price", where);

    expect(aggregateSpy).toHaveBeenCalledWith(
      Product,
      "AVG",
      "price",
      where,
      undefined,
      undefined,
    );
  });

  it("min() should delegate to aggregate() with MIN and field", async () => {
    const result = await handler.min(Product, "price");

    expect(result).toBe(42);
    expect(aggregateSpy).toHaveBeenCalledWith(
      Product,
      "MIN",
      "price",
      undefined,
      undefined,
      undefined,
    );
  });

  it("min() should pass where clause", async () => {
    const where = { id: 5 } as any;
    await handler.min(Product, "price", where);

    expect(aggregateSpy).toHaveBeenCalledWith(
      Product,
      "MIN",
      "price",
      where,
      undefined,
      undefined,
    );
  });

  it("max() should delegate to aggregate() with MAX and field", async () => {
    const result = await handler.max(Product, "price");

    expect(result).toBe(42);
    expect(aggregateSpy).toHaveBeenCalledWith(
      Product,
      "MAX",
      "price",
      undefined,
      undefined,
      undefined,
    );
  });

  it("max() should pass where clause", async () => {
    const where = { quantity: 100 } as any;
    await handler.max(Product, "price", where);

    expect(aggregateSpy).toHaveBeenCalledWith(
      Product,
      "MAX",
      "price",
      where,
      undefined,
      undefined,
    );
  });
});

// ==========================================================================
// describe: soft-delete (@DeletedAt) filtering — regression for #351
// ==========================================================================
describe("AggregateQueryHandler @DeletedAt filtering (#351)", () => {
  let ctx: EntityManagerInternals;
  let resolver: RelationMetadataResolver;
  let handler: AggregateQueryHandler;

  function captureSql(): { getText: () => string } {
    const box: { text: string } = { text: "" };
    (ctx.executeReadOnly as jest.Mock).mockImplementation(async (fn: any) => {
      const mockSession = {
        query: jest.fn().mockImplementation((q: any) => {
          box.text = q.text || q.sql || String(q);
          return Promise.resolve({ results: [{ result: 7 }], fields: [] });
        }),
      };
      return fn(mockSession);
    });
    return { getText: () => box.text };
  }

  beforeEach(() => {
    ctx = createMockCtx();
    // Entity declares a soft-delete column "deleted_at".
    resolver = createMockResolver({
      getDeletedAtColumn: jest.fn().mockReturnValue("deleted_at"),
    });
    (resolver.resolveEntityMetadata as jest.Mock).mockReturnValue(
      productMetadata,
    );
    handler = new AggregateQueryHandler(resolver, ctx);
  });

  it("excludes soft-deleted rows by default (adds deleted_at IS NULL)", async () => {
    const cap = captureSql();
    await handler.aggregate(Product, "COUNT", "*");
    expect(cap.getText()).toContain("`deleted_at` IS NULL");
  });

  it("excludes soft-deleted rows even when a where clause is present", async () => {
    const cap = captureSql();
    await handler.aggregate(Product, "COUNT", "*", { price: 100 } as any);
    const sql = cap.getText();
    expect(sql).toContain("WHERE");
    expect(sql).toContain("`deleted_at` IS NULL");
  });

  it("includes soft-deleted rows when withDeleted=true", async () => {
    const cap = captureSql();
    await handler.aggregate(Product, "COUNT", "*", undefined, undefined, true);
    expect(cap.getText()).not.toContain("deleted_at");
  });

  it("count() excludes soft-deleted rows by default", async () => {
    const cap = captureSql();
    await handler.count(Product);
    expect(cap.getText()).toContain("`deleted_at` IS NULL");
  });

  it("count() with withDeleted=true includes soft-deleted rows", async () => {
    const cap = captureSql();
    await handler.count(Product, undefined, true);
    expect(cap.getText()).not.toContain("deleted_at");
  });

  it("does not add the filter when the entity has no @DeletedAt column", async () => {
    (resolver.getDeletedAtColumn as jest.Mock).mockReturnValue(null);
    const cap = captureSql();
    await handler.aggregate(Product, "COUNT", "*");
    expect(cap.getText()).not.toContain("deleted_at");
  });
});
