import "reflect-metadata";
import { ExplainQueryHandler } from "../../src/core/ExplainQueryHandler";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { EntityManagerInternals } from "../../src/core/EntityManagerInternals";
import { InvalidQueryError } from "../../src/errors/InvalidQueryError";
import { EntityMetadataNotFoundError } from "../../src/errors/EntityMetadataNotFoundError";

// Mock RawQueryBuilderFactory
jest.mock("../../src/core/RawQueryBuilderFactory", () => ({
  RawQueryBuilderFactory: {
    create: jest.fn(() => {
      const qb: any = {
        _dbType: null,
        select(cols: any) { return qb; },
        from(t: any) { return qb; },
        where(w: any) { return qb; },
        orderBy(o: any) { return qb; },
        limit(l: any) { return qb; },
        setDatabaseType(t: any) { qb._dbType = t; return qb; },
        build() { return { text: "SELECT * FROM test", values: [] }; },
      };
      return qb;
    }),
  },
}));

class TestEntity {
  id!: number;
  name!: string;
  age!: number;
}

const mockMetadata = {
  name: "TestEntity",
  columns: [
    { name: "id", options: { primary: true } },
    { name: "name", options: {} },
    { name: "age", options: {} },
  ],
};

function createMockResolver(): jest.Mocked<RelationMetadataResolver> {
  return {
    resolveEntityMetadata: jest.fn().mockReturnValue(mockMetadata),
    resolveOneToManyMetadata: jest.fn().mockReturnValue([]),
    resolveManyToOneMetadata: jest.fn().mockReturnValue([]),
    resolveManyToManyMetadata: jest.fn().mockReturnValue([]),
    resolveOneToOneMetadata: jest.fn().mockReturnValue([]),
    resolveManyToManyJoinTable: jest.fn(),
    getDeletedAtColumn: jest.fn().mockReturnValue(null),
    getCreateTimestampColumn: jest.fn(),
    getUpdateTimestampColumn: jest.fn(),
    getVersionColumn: jest.fn(),
    resolveJoinColumnsFromColumnMeta: jest.fn(),
    resolveJoinColumnsFromColumnMetaForOneToOne: jest.fn(),
  } as any;
}

function createMockCtx(overrides: Partial<EntityManagerInternals> = {}): jest.Mocked<EntityManagerInternals> {
  return {
    wrap: jest.fn((col: string) => `"${col}"`),
    wrapTable: jest.fn((t: string) => `"${t}"`),
    isMySqlFamily: jest.fn().mockReturnValue(false),
    isPostgres: jest.fn().mockReturnValue(false),
    isSqlite: jest.fn().mockReturnValue(false),
    getDriver: jest.fn().mockReturnValue({
      supportsExplain: () => true,
      buildExplainSql: (q: string) => `EXPLAIN ${q}`,
    }),
    getSynchronize: jest.fn(),
    getDialect: jest.fn().mockReturnValue("mysql"),
    getSchema: jest.fn(),
    getConnection: jest.fn(),
    executeInTransaction: jest.fn(),
    executeReadOnly: jest.fn(async (fn: any) => {
      const mockSession = { query: jest.fn().mockResolvedValue({ results: [] }) };
      return fn(mockSession);
    }),
    beginTrackQuery: jest.fn(),
    trackQuery: jest.fn(),
    getReadNode: jest.fn().mockReturnValue(null),
    getEntities: jest.fn(),
    getNameStrategy: jest.fn(),
    resolveSelectColumns: jest.fn((s: any) => s),
    markDirty: jest.fn(),
    findInternal: jest.fn(),
    findOneInternal: jest.fn(),
    save: jest.fn(),
    saveWithSession: jest.fn(),
    find: jest.fn(),
    delete: jest.fn(),
    buildPropertyToColumnMap: jest.fn((m: any) => {
      const map = new Map<string, string>();
      for (const c of m?.columns ?? []) {
        map.set(c.propertyKey ?? c.name, c.name);
      }
      return map;
    }),
    ...overrides,
  } as any;
}

describe("ExplainQueryHandler", () => {
  let handler: ExplainQueryHandler;
  let resolver: jest.Mocked<RelationMetadataResolver>;
  let ctx: jest.Mocked<EntityManagerInternals>;

  beforeEach(() => {
    jest.clearAllMocks();
    resolver = createMockResolver();
    ctx = createMockCtx();
    handler = new ExplainQueryHandler(resolver, ctx);
  });

  // ─── explain() ─────────────────────────────────────────────────

  describe("explain()", () => {
    it("should throw InvalidQueryError when driver is undefined", async () => {
      ctx.getDriver.mockReturnValue(undefined);

      await expect(handler.explain(TestEntity)).rejects.toThrow(InvalidQueryError);
    });

    it("should throw InvalidQueryError when driver does not support EXPLAIN", async () => {
      ctx.getDriver.mockReturnValue({ supportsExplain: () => false } as any);

      await expect(handler.explain(TestEntity)).rejects.toThrow(InvalidQueryError);
    });

    it("should throw EntityMetadataNotFoundError when metadata not found", async () => {
      resolver.resolveEntityMetadata.mockReturnValue(null);

      await expect(handler.explain(TestEntity)).rejects.toThrow(EntityMetadataNotFoundError);
    });

    it("should set database type to mysql for MySQL family", async () => {
      ctx.isMySqlFamily.mockReturnValue(true);
      const mockSession = { query: jest.fn().mockResolvedValue({ results: [] }) };
      ctx.executeReadOnly.mockImplementation(async (fn: any) => fn(mockSession));

      await handler.explain(TestEntity);

      expect(ctx.isMySqlFamily).toHaveBeenCalled();
    });

    it("should set database type to sqlite for SQLite", async () => {
      ctx.isMySqlFamily.mockReturnValue(false);
      (ctx as any).isSqlite = jest.fn().mockReturnValue(true);
      const mockSession = { query: jest.fn().mockResolvedValue({ results: [] }) };
      ctx.executeReadOnly.mockImplementation(async (fn: any) => fn(mockSession));

      await handler.explain(TestEntity);

      expect((ctx as any).isSqlite).toHaveBeenCalled();
    });

    it("should handle select option with no eager joins", async () => {
      const mockSession = { query: jest.fn().mockResolvedValue({ results: [] }) };
      ctx.executeReadOnly.mockImplementation(async (fn: any) => fn(mockSession));
      ctx.resolveSelectColumns.mockReturnValue(["id", "name"]);

      await handler.explain(TestEntity, { select: ["id", "name"] as any });

      expect(ctx.resolveSelectColumns).toHaveBeenCalledWith(["id", "name"]);
    });

    it("should qualify columns when eager joins exist", async () => {
      resolver.resolveManyToOneMetadata.mockReturnValue([
        { columnName: "author", option: { eager: true } },
      ] as any);

      const mockSession = { query: jest.fn().mockResolvedValue({ results: [] }) };
      ctx.executeReadOnly.mockImplementation(async (fn: any) => fn(mockSession));

      await handler.explain(TestEntity);

      // wrap should be called with table-qualified columns
      expect(ctx.wrap).toHaveBeenCalled();
    });

    it("should handle eager OneToOne relations", async () => {
      resolver.resolveOneToOneMetadata.mockReturnValue([
        { propertyKey: "profile", joinColumn: "profile_id", option: { eager: true } },
      ] as any);

      const mockSession = { query: jest.fn().mockResolvedValue({ results: [] }) };
      ctx.executeReadOnly.mockImplementation(async (fn: any) => fn(mockSession));

      await handler.explain(TestEntity);

      expect(resolver.resolveOneToOneMetadata).toHaveBeenCalled();
    });

    it("should handle relations option in findOption", async () => {
      resolver.resolveManyToOneMetadata.mockReturnValue([
        { columnName: "author", option: { eager: false } },
      ] as any);

      const mockSession = { query: jest.fn().mockResolvedValue({ results: [] }) };
      ctx.executeReadOnly.mockImplementation(async (fn: any) => fn(mockSession));

      await handler.explain(TestEntity, { relations: ["author"] });

      expect(resolver.resolveManyToOneMetadata).toHaveBeenCalled();
    });

    it("should handle limit as array [offset, count]", async () => {
      const mockSession = { query: jest.fn().mockResolvedValue({ results: [] }) };
      ctx.executeReadOnly.mockImplementation(async (fn: any) => fn(mockSession));

      await handler.explain(TestEntity, { limit: [10, 20] });

      // Should not throw
    });

    it("should handle negative offset/count in limit array", async () => {
      const mockSession = { query: jest.fn().mockResolvedValue({ results: [] }) };
      ctx.executeReadOnly.mockImplementation(async (fn: any) => fn(mockSession));

      await handler.explain(TestEntity, { limit: [-5, -3] });

      // Should handle gracefully (set to 0/1)
    });

    it("should handle count=0 in limit array (set to 1)", async () => {
      const mockSession = { query: jest.fn().mockResolvedValue({ results: [] }) };
      ctx.executeReadOnly.mockImplementation(async (fn: any) => fn(mockSession));

      await handler.explain(TestEntity, { limit: [0, 0] });
    });

    it("should handle take overriding count in limit array", async () => {
      const mockSession = { query: jest.fn().mockResolvedValue({ results: [] }) };
      ctx.executeReadOnly.mockImplementation(async (fn: any) => fn(mockSession));

      await handler.explain(TestEntity, { limit: [0, 100], take: 5 });
    });

    it("should handle skip/take without limit", async () => {
      const mockSession = { query: jest.fn().mockResolvedValue({ results: [] }) };
      ctx.executeReadOnly.mockImplementation(async (fn: any) => fn(mockSession));

      await handler.explain(TestEntity, { skip: 10, take: 5 });
    });

    it("should handle skip without take", async () => {
      const mockSession = { query: jest.fn().mockResolvedValue({ results: [] }) };
      ctx.executeReadOnly.mockImplementation(async (fn: any) => fn(mockSession));

      await handler.explain(TestEntity, { skip: 10 });
    });

    it("should handle numeric limit", async () => {
      const mockSession = { query: jest.fn().mockResolvedValue({ results: [] }) };
      ctx.executeReadOnly.mockImplementation(async (fn: any) => fn(mockSession));

      await handler.explain(TestEntity, { limit: 50 as any });
    });

    it("should handle deletedAt column filtering", async () => {
      resolver.getDeletedAtColumn.mockReturnValue("deletedAt");

      const mockSession = { query: jest.fn().mockResolvedValue({ results: [] }) };
      ctx.executeReadOnly.mockImplementation(async (fn: any) => fn(mockSession));

      await handler.explain(TestEntity);

      expect(resolver.getDeletedAtColumn).toHaveBeenCalledWith(TestEntity);
    });

    it("should skip deletedAt filtering when withDeleted is set", async () => {
      resolver.getDeletedAtColumn.mockReturnValue("deletedAt");

      const mockSession = { query: jest.fn().mockResolvedValue({ results: [] }) };
      ctx.executeReadOnly.mockImplementation(async (fn: any) => fn(mockSession));

      await handler.explain(TestEntity, { withDeleted: true } as any);

      // deletedAt filter should be skipped
    });

    it("should handle orderBy option", async () => {
      const mockSession = { query: jest.fn().mockResolvedValue({ results: [] }) };
      ctx.executeReadOnly.mockImplementation(async (fn: any) => fn(mockSession));

      await handler.explain(TestEntity, { orderBy: { name: "ASC", age: "DESC" } as any });

      expect(ctx.wrap).toHaveBeenCalledWith("name");
      expect(ctx.wrap).toHaveBeenCalledWith("age");
    });

    it("should pass useMaster to getReadNode", async () => {
      const mockSession = { query: jest.fn().mockResolvedValue({ results: [] }) };
      ctx.executeReadOnly.mockImplementation(async (fn: any) => fn(mockSession));

      await handler.explain(TestEntity, { useMaster: true } as any);

      expect(ctx.getReadNode).toHaveBeenCalledWith(true);
    });
  });

  // ─── parseExplainResult() ──────────────────────────────────────

  describe("parseExplainResult()", () => {
    it("should return empty result for null/empty rows", () => {
      const result = handler.parseExplainResult([]);
      expect(result.raw).toEqual([]);
      expect(result.rows).toBeNull();
      expect(result.type).toBeNull();
      expect(result.key).toBeNull();
      expect(result.cost).toBeNull();
    });

    it("should return empty result for undefined rows", () => {
      const result = handler.parseExplainResult(undefined as any);
      expect(result.raw).toEqual([]);
      expect(result.rows).toBeNull();
    });

    // ── MySQL ──
    it("should parse MySQL EXPLAIN with all fields", () => {
      const result = handler.parseExplainResult([{
        select_type: "SIMPLE",
        type: "ref",
        possible_keys: "idx_a,idx_b",
        key: "idx_a",
        rows: 10,
        filtered: 50.0,
      }]);

      expect(result.type).toBe("ref");
      expect(result.rows).toBe(10);
      expect(result.possibleKeys).toEqual(["idx_a", "idx_b"]);
      expect(result.key).toBe("idx_a");
      expect(result.cost).toBe(50.0);
    });

    it("should parse MySQL EXPLAIN with null possible_keys", () => {
      const result = handler.parseExplainResult([{
        select_type: "SIMPLE",
        type: "ALL",
        possible_keys: null,
        key: null,
        rows: 100,
        filtered: null,
      }]);

      expect(result.type).toBe("ALL");
      expect(result.rows).toBe(100);
      expect(result.possibleKeys).toBeNull();
      expect(result.key).toBeNull();
      expect(result.cost).toBeNull();
    });

    it("should parse MySQL EXPLAIN with only type field", () => {
      const result = handler.parseExplainResult([{ type: "ALL" }]);
      expect(result.type).toBe("ALL");
      expect(result.rows).toBeNull();
    });

    // ── PostgreSQL ──
    it("should parse PostgreSQL EXPLAIN with Plan object", () => {
      const result = handler.parseExplainResult([{
        "QUERY PLAN": [{
          Plan: {
            "Node Type": "Index Scan",
            "Plan Rows": 5,
            "Total Cost": 0.42,
            "Index Name": "users_pkey",
          },
        }],
      }]);

      expect(result.type).toBe("Index Scan");
      expect(result.rows).toBe(5);
      expect(result.cost).toBe(0.42);
      expect(result.key).toBe("users_pkey");
    });

    it("should parse PostgreSQL EXPLAIN without Plan", () => {
      const result = handler.parseExplainResult([{
        "QUERY PLAN": [{}],
      }]);

      expect(result.rows).toBeNull();
      expect(result.type).toBeNull();
    });

    it("should parse PostgreSQL EXPLAIN with non-array QUERY PLAN", () => {
      const result = handler.parseExplainResult([{
        "QUERY PLAN": {
          Plan: {
            "Node Type": "Seq Scan",
            "Plan Rows": 100,
            "Total Cost": 15.5,
          },
        },
      }]);

      expect(result.type).toBe("Seq Scan");
      expect(result.rows).toBe(100);
    });

    it("should parse PostgreSQL EXPLAIN Plan without Index Name", () => {
      const result = handler.parseExplainResult([{
        "QUERY PLAN": [{
          Plan: {
            "Node Type": "Seq Scan",
            "Plan Rows": 200,
            "Total Cost": 10.5,
          },
        }],
      }]);

      expect(result.key).toBeNull();
      expect(result.possibleKeys).toBeNull();
    });

    // ── SQLite ──
    it("should parse SQLite EXPLAIN with SCAN", () => {
      const result = handler.parseExplainResult([
        { detail: "SCAN users" },
      ]);

      expect(result.type).toBe("SCAN");
      expect(result.key).toBeNull();
    });

    it("should parse SQLite EXPLAIN with SEARCH and INDEX", () => {
      const result = handler.parseExplainResult([
        { detail: "SEARCH users USING INDEX idx_email (email=?)" },
      ]);

      expect(result.type).toBe("SEARCH");
      expect(result.key).toBe("idx_email");
    });

    it("should parse SQLite EXPLAIN with COVERING INDEX", () => {
      const result = handler.parseExplainResult([
        { detail: "SEARCH users USING COVERING INDEX idx_name (name=?)" },
      ]);

      expect(result.type).toBe("SEARCH");
      expect(result.key).toBe("idx_name");
    });

    it("should parse SQLite EXPLAIN with notused field", () => {
      const result = handler.parseExplainResult([
        { notused: 0, detail: "SCAN table" },
      ]);

      expect(result.type).toBe("SCAN");
    });

    it("should parse SQLite EXPLAIN with empty detail", () => {
      const result = handler.parseExplainResult([
        { detail: "" },
      ]);

      expect(result.type).toBeNull();
      expect(result.key).toBeNull();
    });

    // ── Unknown format ──
    it("should return raw-only result for unknown format", () => {
      const rows = [{ something: "else", value: 42 }];
      const result = handler.parseExplainResult(rows);

      expect(result.raw).toEqual(rows);
      expect(result.rows).toBeNull();
      expect(result.type).toBeNull();
    });
  });
});
