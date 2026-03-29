/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { rawPipelinePlugin } from "../../src/core/plugin/raw-pipeline/rawPipelinePlugin";
import { RawPipeline, MappedPipeline, FilteredMappedPipeline } from "../../src/core/plugin/raw-pipeline/RawPipeline";
import { OrmError } from "../../src/errors/OrmError";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";

// ── Mock setup ──────────────────────────────────────────────

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

// ── Test entity ─────────────────────────────────────────────

@Entity()
class TestUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 100 })
  name!: string;

  @Column({ type: "int" })
  age!: number;

  @Column({ type: "boolean" })
  active!: boolean;
}

// ── Helper: generate fake rows ──────────────────────────────

function generateRows(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    name: `user_${i + 1}`,
    age: 20 + (i % 50),
    active: i % 2 === 0,
  }));
}

// ── Tests ───────────────────────────────────────────────────

describe("RawPipeline Plugin", () => {
  let em: EntityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    em = new EntityManager();
  });

  // ── Plugin Registration ─────────────────────────��───────

  describe("Plugin Registration", () => {
    it("should throw when pipe() is called without plugin installed", () => {
      expect(() => em.pipe(TestUser)).toThrow(OrmError);
      expect(() => em.pipe(TestUser)).toThrow(/raw-pipeline plugin/);
    });

    it("should install rawPipelinePlugin and add pipe() method", () => {
      em.extend(rawPipelinePlugin());
      const pipeline = em.pipe(TestUser);
      expect(pipeline).toBeInstanceOf(RawPipeline);
    });

    it("should be idempotent", () => {
      em.extend(rawPipelinePlugin());
      em.extend(rawPipelinePlugin());
      expect(em.hasPlugin("raw-pipeline")).toBe(true);
    });

    it("should accept options in pipe()", () => {
      em.extend(rawPipelinePlugin());
      const pipeline = em.pipe(TestUser, {
        where: { active: true },
        batchSize: 5000,
      });
      expect(pipeline).toBeInstanceOf(RawPipeline);
    });
  });

  // ── RawPipeline.raw() ───────────────────────────────────

  describe("raw() streaming", () => {
    it("should yield batches of raw rows", async () => {
      const rows = generateRows(250);
      const queryMock = jest.fn()
        .mockResolvedValueOnce(rows.slice(0, 100))
        .mockResolvedValueOnce(rows.slice(100, 200))
        .mockResolvedValueOnce(rows.slice(200, 250))
        .mockResolvedValueOnce([]); // signal end

      em.extend(rawPipelinePlugin());
      (em as any).query = queryMock;

      const pipeline = em.pipe(TestUser, { batchSize: 100 });
      const batches: Record<string, unknown>[][] = [];

      for await (const batch of pipeline.raw()) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(3);
      expect(batches[0]).toHaveLength(100);
      expect(batches[1]).toHaveLength(100);
      expect(batches[2]).toHaveLength(50);
    });

    it("should stop when empty batch is returned", async () => {
      const queryMock = jest.fn().mockResolvedValue([]);
      em.extend(rawPipelinePlugin());
      (em as any).query = queryMock;

      const pipeline = em.pipe(TestUser, { batchSize: 100 });
      const batches: any[][] = [];

      for await (const batch of pipeline.raw()) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(0);
      expect(queryMock).toHaveBeenCalledTimes(1);
    });

    it("should stop when batch is smaller than batchSize", async () => {
      const rows = generateRows(50);
      const queryMock = jest.fn().mockResolvedValueOnce(rows);
      em.extend(rawPipelinePlugin());
      (em as any).query = queryMock;

      const pipeline = em.pipe(TestUser, { batchSize: 100 });
      const batches: any[][] = [];

      for await (const batch of pipeline.raw()) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(50);
      // Only 1 query call since batch < batchSize
      expect(queryMock).toHaveBeenCalledTimes(1);
    });

    it("should use default batchSize of 1000", async () => {
      const rows = generateRows(500);
      const queryMock = jest.fn().mockResolvedValueOnce(rows);
      em.extend(rawPipelinePlugin());
      (em as any).query = queryMock;

      const pipeline = em.pipe(TestUser);
      const batches: any[][] = [];

      for await (const batch of pipeline.raw()) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      // Query should include LIMIT 1000 (default)
      const sqlArg = queryMock.mock.calls[0][0];
      expect(sqlArg.sql).toContain("LIMIT");
    });
  });

  // ── map() chaining ──────────────────────────────────────

  describe("map() chaining", () => {
    it("should transform rows via map()", async () => {
      const rows = generateRows(10);
      const queryMock = jest.fn().mockResolvedValueOnce(rows);
      em.extend(rawPipelinePlugin());
      (em as any).query = queryMock;

      const pipeline = em.pipe(TestUser, { batchSize: 100 });
      const mapped = pipeline.map((row) => ({
        userId: row.id,
        displayName: row.name,
      }));

      expect(mapped).toBeInstanceOf(MappedPipeline);

      const batches: any[][] = [];
      for await (const batch of mapped.raw()) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0][0]).toEqual({
        userId: 1,
        displayName: "user_1",
      });
    });

    it("should support chained map().map()", async () => {
      const rows = generateRows(5);
      const queryMock = jest.fn().mockResolvedValueOnce(rows);
      em.extend(rawPipelinePlugin());
      (em as any).query = queryMock;

      const pipeline = em.pipe(TestUser, { batchSize: 100 });
      const result = await pipeline
        .map((row) => ({ id: row.id, name: row.name }))
        .map((row) => `${row.id}:${row.name}`)
        .collect();

      expect(result).toHaveLength(5);
      expect(result[0]).toBe("1:user_1");
      expect(result[4]).toBe("5:user_5");
    });
  });

  // ── filter() ────────────────────────────────────────────

  describe("filter()", () => {
    it("should filter rows in MappedPipeline", async () => {
      const rows = generateRows(10);
      const queryMock = jest.fn().mockResolvedValueOnce(rows);
      em.extend(rawPipelinePlugin());
      (em as any).query = queryMock;

      const pipeline = em.pipe(TestUser, { batchSize: 100 });
      const result = await pipeline
        .map((row) => ({ id: row.id as number, active: row.active as boolean }))
        .filter((row) => row.active)
        .collect();

      // Even indices are active (0-based: id 1,3,5,7,9 are active)
      expect(result.length).toBe(5);
      expect(result.every((r) => r.active)).toBe(true);
    });
  });

  // ── collect() ───────────────────────────────────────────

  describe("collect()", () => {
    it("should collect all batches into a single array", async () => {
      const rows = generateRows(250);
      const queryMock = jest.fn()
        .mockResolvedValueOnce(rows.slice(0, 100))
        .mockResolvedValueOnce(rows.slice(100, 200))
        .mockResolvedValueOnce(rows.slice(200, 250))
        .mockResolvedValueOnce([]);

      em.extend(rawPipelinePlugin());
      (em as any).query = queryMock;

      const pipeline = em.pipe(TestUser, { batchSize: 100 });
      const all = await pipeline.collect();

      expect(all).toHaveLength(250);
      expect(all[0]).toEqual(rows[0]);
      expect(all[249]).toEqual(rows[249]);
    });
  });

  // ── binary() mode ───────────────────────────────────────

  describe("binary() mode", () => {
    it("should fall back to raw() when driver has no queryWithOptions", async () => {
      const rows = generateRows(5);
      const queryMock = jest.fn().mockResolvedValueOnce(rows);
      em.extend(rawPipelinePlugin());
      (em as any).query = queryMock;

      const pipeline = em.pipe(TestUser, { batchSize: 100 });
      const batches: any[][] = [];

      for await (const batch of pipeline.binary()) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(5);
    });

    it("should use driver.queryWithOptions when available", async () => {
      const bufferRows = [Buffer.from("row1"), Buffer.from("row2")];
      const mockQueryWithOptions = jest.fn()
        .mockResolvedValueOnce(bufferRows)
        .mockResolvedValueOnce([]);

      em.extend(rawPipelinePlugin());

      // Inject a mock driver with queryWithOptions
      const mockDriver = { queryWithOptions: mockQueryWithOptions };
      (em as any).driver = mockDriver;

      // Override getPluginContext to return our mock driver
      const ctx = (em as any).getPluginContext();
      Object.defineProperty(ctx, "driver", { get: () => mockDriver });

      // Create pipeline using the plugin context directly
      const { RawPipeline: RP } = require("../../src/core/plugin/raw-pipeline/RawPipeline");
      const pipeline = new RP(ctx, TestUser, { batchSize: 100 });

      const batches: any[][] = [];
      for await (const batch of pipeline.binary()) {
        batches.push(batch);
      }

      expect(mockQueryWithOptions).toHaveBeenCalled();
      expect(batches).toHaveLength(1);
      expect(batches[0]).toEqual(bufferRows);
    });
  });

  // ── SQL Generation ──────────────────────────────────────

  describe("SQL generation", () => {
    it("should generate SQL with table name from entity metadata", async () => {
      const queryMock = jest.fn().mockResolvedValue([]);
      em.extend(rawPipelinePlugin());
      (em as any).query = queryMock;

      const pipeline = em.pipe(TestUser, { batchSize: 100 });

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of pipeline.raw()) {
        // consume
      }

      expect(queryMock).toHaveBeenCalledTimes(1);
      const sqlArg = queryMock.mock.calls[0][0];
      expect(sqlArg.sql).toContain("SELECT");
      expect(sqlArg.sql).toContain("LIMIT");
    });

    it("should include WHERE clause when where option is provided", async () => {
      const queryMock = jest.fn().mockResolvedValue([]);
      em.extend(rawPipelinePlugin());
      (em as any).query = queryMock;

      const pipeline = em.pipe(TestUser, {
        where: { active: true } as any,
        batchSize: 100,
      });

      for await (const _ of pipeline.raw()) {
        // consume
      }

      const sqlArg = queryMock.mock.calls[0][0];
      expect(sqlArg.sql).toContain("WHERE");
      expect(sqlArg.values).toContain(true);
    });

    it("should include ORDER BY when orderBy option is provided", async () => {
      const queryMock = jest.fn().mockResolvedValue([]);
      em.extend(rawPipelinePlugin());
      (em as any).query = queryMock;

      const pipeline = em.pipe(TestUser, {
        orderBy: { name: "ASC" } as any,
        batchSize: 100,
      });

      for await (const _ of pipeline.raw()) {
        // consume
      }

      const sqlArg = queryMock.mock.calls[0][0];
      expect(sqlArg.sql).toContain("ORDER BY");
      expect(sqlArg.sql).toContain("ASC");
    });

    it("should paginate with OFFSET on subsequent batches", async () => {
      const rows = generateRows(100);
      const queryMock = jest.fn()
        .mockResolvedValueOnce(rows)
        .mockResolvedValueOnce([]);

      em.extend(rawPipelinePlugin());
      (em as any).query = queryMock;

      const pipeline = em.pipe(TestUser, { batchSize: 100 });

      for await (const _ of pipeline.raw()) {
        // consume
      }

      // Second call should have OFFSET
      expect(queryMock).toHaveBeenCalledTimes(2);
      const secondSql = queryMock.mock.calls[1][0];
      expect(secondSql.sql).toContain("OFFSET");
      expect(secondSql.values).toContain(100); // offset = 100
    });
  });

  // ── WHERE clause builder ────────────────────────────────

  describe("WHERE clause builder", () => {
    let queryMock: jest.Mock;

    beforeEach(() => {
      queryMock = jest.fn().mockResolvedValue([]);
      em.extend(rawPipelinePlugin());
      (em as any).query = queryMock;
    });

    it("should handle null values with IS NULL", async () => {
      const pipeline = em.pipe(TestUser, {
        where: { name: null } as any,
        batchSize: 100,
      });

      for await (const _ of pipeline.raw()) { /* consume */ }

      const sql = queryMock.mock.calls[0][0].sql;
      expect(sql).toContain("IS NULL");
    });

    it("should handle filter operators (gt, lt, in)", async () => {
      const pipeline = em.pipe(TestUser, {
        where: {
          age: { gt: 25, lt: 50 },
        } as any,
        batchSize: 100,
      });

      for await (const _ of pipeline.raw()) { /* consume */ }

      const sql = queryMock.mock.calls[0][0].sql;
      const values = queryMock.mock.calls[0][0].values;
      expect(sql).toContain(">");
      expect(sql).toContain("<");
      expect(values).toContain(25);
      expect(values).toContain(50);
    });

    it("should handle IN operator", async () => {
      const pipeline = em.pipe(TestUser, {
        where: {
          id: { in: [1, 2, 3] },
        } as any,
        batchSize: 100,
      });

      for await (const _ of pipeline.raw()) { /* consume */ }

      const sql = queryMock.mock.calls[0][0].sql;
      expect(sql).toContain("IN");
      expect(sql).toContain("?, ?, ?");
    });

    it("should handle BETWEEN operator", async () => {
      const pipeline = em.pipe(TestUser, {
        where: {
          age: { between: [20, 30] },
        } as any,
        batchSize: 100,
      });

      for await (const _ of pipeline.raw()) { /* consume */ }

      const sql = queryMock.mock.calls[0][0].sql;
      expect(sql).toContain("BETWEEN");
    });

    it("should handle LIKE operator", async () => {
      const pipeline = em.pipe(TestUser, {
        where: {
          name: { like: "%test%" },
        } as any,
        batchSize: 100,
      });

      for await (const _ of pipeline.raw()) { /* consume */ }

      const sql = queryMock.mock.calls[0][0].sql;
      expect(sql).toContain("LIKE");
    });
  });

  // ── Edge cases ──────────────────────────────────────────

  describe("Edge cases", () => {
    it("should enforce minimum batchSize of 1", async () => {
      const rows = [{ id: 1 }];
      const queryMock = jest.fn()
        .mockResolvedValueOnce(rows)
        .mockResolvedValueOnce([]);

      em.extend(rawPipelinePlugin());
      (em as any).query = queryMock;

      const pipeline = em.pipe(TestUser, { batchSize: 0 });

      const batches: any[][] = [];
      for await (const batch of pipeline.raw()) {
        batches.push(batch);
      }

      // batchSize should be clamped to 1
      expect(batches).toHaveLength(1);
    });

    it("should handle select option for specific columns", async () => {
      const queryMock = jest.fn().mockResolvedValue([]);
      em.extend(rawPipelinePlugin());
      (em as any).query = queryMock;

      const pipeline = em.pipe(TestUser, {
        select: ["id", "name"] as any,
        batchSize: 100,
      });

      for await (const _ of pipeline.raw()) { /* consume */ }

      const sql = queryMock.mock.calls[0][0].sql;
      // Should not be SELECT *
      expect(sql).not.toContain("*");
    });
  });

  // ── count() ─────────────────────────────────────────────

  describe("count()", () => {
    it("should return total row count", async () => {
      const queryMock = jest.fn().mockResolvedValue([{ cnt: 42 }]);
      em.extend(rawPipelinePlugin());
      (em as any).query = queryMock;

      const pipeline = em.pipe(TestUser);
      const count = await pipeline.count();

      expect(count).toBe(42);
    });

    it("should handle string count result (MySQL)", async () => {
      const queryMock = jest.fn().mockResolvedValue([{ cnt: "100" }]);
      em.extend(rawPipelinePlugin());
      (em as any).query = queryMock;

      const pipeline = em.pipe(TestUser);
      const count = await pipeline.count();

      expect(count).toBe(100);
    });
  });
});
