import "reflect-metadata";
import sql from "sql-template-tag";
import { resetScannerContainer } from "../../src/scanner/ScannerContainer";
import { EntityManager } from "../../src/core/EntityManager";
import { MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";
import { qAlias } from "../../src/core/query-builder/alias/qAlias";
import { qExcluded } from "../../src/core/query-builder/alias/qExcluded";
import { greatest, least } from "../../src/core/expressions/ComparisonExpression";
import { coalesce } from "../../src/core/expressions/NullishExpression";
import { iff } from "../../src/core/expressions/CaseExpression";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";

// ── Mocks ─────────────────────────────────────────────────

jest.mock("../../src/DatabaseClient", () => ({
  DatabaseClient: {
    getInstance: jest.fn().mockReturnValue({
      type: "postgres",
      getConnection: jest.fn(),
      getOptions: jest.fn().mockReturnValue({ synchronize: false }),
      connect: jest.fn(),
    }),
  },
}));

jest.mock("../../src/dialects/TransactionSessionManager", () => {
  const mockQuery = jest.fn();
  return {
    TransactionSessionManager: jest.fn().mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      query: mockQuery,
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    })),
    __mockQuery: mockQuery,
  };
});

// ── Fixtures ──────────────────────────────────────────────

interface SyncMarkerShape {
  mac: string;
  bucketStart: Date;
  records: number;
  lastTime: Date;
  syncedAt: Date | null;
}
class SyncMarker {}

const markerMetadata = {
  name: "ble_sensor_sync_markers",
  target: SyncMarker,
  columns: [
    { name: "mac", propertyKey: "mac", options: { primary: true } },
    { name: "bucket_start", propertyKey: "bucketStart", options: { primary: true } },
    { name: "records", propertyKey: "records", options: {} },
    { name: "last_time", propertyKey: "lastTime", options: {} },
    { name: "synced_at", propertyKey: "syncedAt", options: {} },
  ],
};

type Dialect = "mysql" | "postgres" | "sqlite";

function createTestEntityManager(dialect: Dialect): EntityManager {
  const em = new EntityManager();
  (em as any).driver = {
    wrap: (name: string) =>
      dialect === "mysql"
        ? `\`${name.replace(/`/g, "``")}\``
        : `"${name.replace(/"/g, '""')}"`,
  };
  (em as any)._ctx.getDialect = () => dialect;
  jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(dialect === "mysql");
  jest.spyOn(em as any, "isPostgres").mockReturnValue(dialect === "postgres");
  jest.spyOn(em as any, "isSqlite").mockReturnValue(dialect === "sqlite");
  jest.spyOn(em as any, "assertEntityInScope").mockImplementation(() => undefined);
  jest
    .spyOn((em as any).resolver, "resolveEntityMetadata")
    .mockReturnValue(markerMetadata);
  jest
    .spyOn((em as any).resolver, "resolveManyToOneMetadata")
    .mockReturnValue([]);
  jest.spyOn((em as any).resolver, "getDeletedAtColumn").mockReturnValue(null);
  jest.spyOn((em as any).resolver, "getVersionColumn").mockReturnValue(null);
  return em;
}

const ROWS: Array<Partial<SyncMarkerShape>> = [
  {
    mac: "aa:bb",
    bucketStart: new Date("2026-09-01T00:00:00Z"),
    records: 12,
    lastTime: new Date("2026-09-01T00:00:30Z"),
  },
  {
    mac: "aa:bb",
    bucketStart: new Date("2026-09-01T01:00:00Z"),
    records: 7,
    lastTime: new Date("2026-09-01T01:00:10Z"),
  },
];

function accumulatingUpsert(em: EntityManager) {
  return em
    .createInsertBuilder(SyncMarker as any, "m")
    .values(ROWS as any)
    .onConflict(["mac", "bucketStart"] as any)
    .doUpdate((t: any, ex: any) => ({
      records: t.records.add(ex.records),
      lastTime: greatest(t.lastTime, ex.lastTime),
      syncedAt: sql`NOW()`,
    }));
}

// ── Tests ─────────────────────────────────────────────────

describe("InsertQueryBuilder", () => {
  beforeEach(() => {
    MetadataLayerRegistry.reset();
    resetScannerContainer();
    jest.clearAllMocks();
  });

  describe("expression-based DO UPDATE", () => {
    it("PostgreSQL: reads the stored row and EXCLUDED in one statement", () => {
      const em = createTestEntityManager("postgres");
      const { text } = accumulatingUpsert(em).toSql();

      expect(text).toContain('INSERT INTO "ble_sensor_sync_markers"');
      expect(text).toContain('ON CONFLICT ("mac", "bucket_start") DO UPDATE SET');
      expect(text).toContain('"records" = ("records" + EXCLUDED."records")');
      expect(text).toContain(
        '"last_time" = GREATEST("last_time", EXCLUDED."last_time")',
      );
      expect(text).toContain('"synced_at" = NOW()');
    });

    it("SQLite: lowercase excluded and MAX() for the row-wise maximum", () => {
      const em = createTestEntityManager("sqlite");
      const { text } = accumulatingUpsert(em).toSql();

      expect(text).toContain('ON CONFLICT ("mac", "bucket_start") DO UPDATE SET');
      expect(text).toContain('"records" = ("records" + excluded."records")');
      expect(text).toContain('"last_time" = MAX("last_time", excluded."last_time")');
    });

    it("MySQL: VALUES() for the proposed row, no conflict target", () => {
      const em = createTestEntityManager("mysql");
      const { text } = accumulatingUpsert(em).toSql();

      expect(text).toContain("ON DUPLICATE KEY UPDATE");
      expect(text).toContain("`records` = (`records` + VALUES(`records`))");
      expect(text).toContain(
        "`last_time` = GREATEST(`last_time`, VALUES(`last_time`))",
      );
      expect(text).not.toContain("ON CONFLICT");
    });

    it("emits one VALUES tuple per row with the values bound as parameters", () => {
      const em = createTestEntityManager("postgres");
      const { text, values } = accumulatingUpsert(em).toSql();

      expect(text.match(/VALUES \(.+\), \(/)).not.toBeNull();
      expect(values).toContain(12);
      expect(values).toContain(7);
      expect(values).toContain("aa:bb");
    });
  });

  describe("conflict target", () => {
    it("defaults to the primary key when onConflict is omitted", () => {
      const em = createTestEntityManager("postgres");
      const { text } = em
        .createInsertBuilder(SyncMarker as any)
        .values(ROWS[0] as any)
        .doUpdate(["records"] as any)
        .toSql();

      expect(text).toContain('ON CONFLICT ("mac", "bucket_start")');
      expect(text).toContain('"records" = EXCLUDED."records"');
    });

    it("accepts qAlias column references as the target", () => {
      const em = createTestEntityManager("postgres");
      const m = qAlias(SyncMarker as any, "m") as any;
      const { text } = em
        .createInsertBuilder(SyncMarker as any)
        .values(ROWS[0] as any)
        .onConflict([m.mac, m.bucketStart])
        .doNothing()
        .toSql();

      expect(text).toContain('ON CONFLICT ("mac", "bucket_start") DO NOTHING');
    });

    it("emits a partial-index predicate on PostgreSQL", () => {
      const em = createTestEntityManager("postgres");
      const m = qAlias(SyncMarker as any, "m") as any;
      const { text } = em
        .createInsertBuilder(SyncMarker as any)
        .values(ROWS[0] as any)
        .onConflict(["mac", "bucketStart"] as any, {
          where: m.syncedAt.isNull(),
        })
        .doUpdate(["records"] as any)
        .toSql();

      expect(text).toContain(
        'ON CONFLICT ("mac", "bucket_start") WHERE "synced_at" IS NULL DO UPDATE',
      );
    });

    it("emits ON CONSTRAINT on PostgreSQL", () => {
      const em = createTestEntityManager("postgres");
      const { text } = em
        .createInsertBuilder(SyncMarker as any)
        .values(ROWS[0] as any)
        .onConflictConstraint("marker_pk")
        .doNothing()
        .toSql();

      expect(text).toContain('ON CONFLICT ON CONSTRAINT "marker_pk" DO NOTHING');
    });

    it("rejects ON CONSTRAINT on SQLite", () => {
      const em = createTestEntityManager("sqlite");
      const build = () =>
        em
          .createInsertBuilder(SyncMarker as any)
          .values(ROWS[0] as any)
          .onConflictConstraint("marker_pk")
          .doNothing()
          .toSql();

      expect(build).toThrow(OrmError);
      expect(build).toThrow(/PostgreSQL-only/);
    });

    it("rejects a partial-index predicate on MySQL instead of dropping it", () => {
      const em = createTestEntityManager("mysql");
      const m = qAlias(SyncMarker as any, "m") as any;
      const build = () =>
        em
          .createInsertBuilder(SyncMarker as any)
          .values(ROWS[0] as any)
          .onConflict(["mac"] as any, { where: m.syncedAt.isNull() })
          .doUpdate(["records"] as any)
          .toSql();

      expect(build).toThrow(/no MySQL\/MariaDB equivalent/);
    });
  });

  describe("DO NOTHING", () => {
    it("PostgreSQL / SQLite emit DO NOTHING", () => {
      for (const dialect of ["postgres", "sqlite"] as const) {
        const em = createTestEntityManager(dialect);
        const { text } = em
          .createInsertBuilder(SyncMarker as any)
          .values(ROWS[0] as any)
          .onConflict(["mac", "bucketStart"] as any)
          .doNothing()
          .toSql();
        expect(text).toContain("DO NOTHING");
      }
    });

    it("MySQL rewrites to INSERT IGNORE", () => {
      const em = createTestEntityManager("mysql");
      const { text } = em
        .createInsertBuilder(SyncMarker as any)
        .values(ROWS[0] as any)
        .onConflict(["mac", "bucketStart"] as any)
        .doNothing()
        .toSql();

      expect(text).toMatch(/^INSERT IGNORE INTO/);
      expect(text).not.toContain("ON DUPLICATE KEY UPDATE");
    });
  });

  describe("doUpdateWhere", () => {
    it("filters which conflicting rows are updated on PostgreSQL", () => {
      const em = createTestEntityManager("postgres");
      const m = qAlias(SyncMarker as any, "m") as any;
      const ex = qExcluded(SyncMarker as any) as any;
      const { text } = em
        .createInsertBuilder(SyncMarker as any)
        .values(ROWS[0] as any)
        .onConflict(["mac", "bucketStart"] as any)
        .doUpdate({ lastTime: ex.lastTime } as any)
        .doUpdateWhere(m.lastTime.lt(new Date("2026-09-01T00:00:00Z")))
        .toSql();

      expect(text).toContain("DO UPDATE SET");
      expect(text).toMatch(/DO UPDATE SET .+ WHERE "last_time" </);
    });

    it("throws on MySQL rather than silently dropping the predicate", () => {
      const em = createTestEntityManager("mysql");
      const m = qAlias(SyncMarker as any, "m") as any;
      const build = () =>
        em
          .createInsertBuilder(SyncMarker as any)
          .values(ROWS[0] as any)
          .doUpdate(["records"] as any)
          .doUpdateWhere(m.records.gt(0))
          .toSql();

      expect(build).toThrow(/takes no WHERE clause/);
    });

    it("rejects doUpdateWhere before doUpdate", () => {
      const em = createTestEntityManager("postgres");
      const m = qAlias(SyncMarker as any, "m") as any;
      expect(() =>
        em
          .createInsertBuilder(SyncMarker as any)
          .values(ROWS[0] as any)
          .doUpdateWhere(m.records.gt(0)),
      ).toThrow(/must follow \.doUpdate\(\)/);
    });
  });

  describe("expression composition", () => {
    it("composes least() and coalesce() over both rows", () => {
      const em = createTestEntityManager("postgres");
      const { text } = em
        .createInsertBuilder(SyncMarker as any)
        .values(ROWS[0] as any)
        .onConflict(["mac", "bucketStart"] as any)
        .doUpdate((t: any, ex: any) => ({
          lastTime: least(coalesce(t.lastTime, ex.lastTime), ex.lastTime),
        }))
        .toSql();

      expect(text).toContain(
        'LEAST(COALESCE("last_time", EXCLUDED."last_time"), EXCLUDED."last_time")',
      );
    });

    it("binds a literal SET value as a parameter", () => {
      const em = createTestEntityManager("postgres");
      const { text, values } = em
        .createInsertBuilder(SyncMarker as any)
        .values(ROWS[0] as any)
        .onConflict(["mac", "bucketStart"] as any)
        .doUpdate({ records: 0 } as any)
        .toSql();

      expect(text).toContain('"records" = $');
      expect(values).toContain(0);
    });

    it("greatest() requires at least two arguments", () => {
      const m = qAlias(SyncMarker as any, "m") as any;
      expect(() => greatest(m.records)).toThrow(/at least 2 arguments/);
    });
  });

  describe("values()", () => {
    it("accumulates rows across multiple calls", () => {
      const em = createTestEntityManager("postgres");
      const { text, values } = em
        .createInsertBuilder(SyncMarker as any)
        .values(ROWS[0] as any)
        .values(ROWS[1] as any)
        .toSql();

      expect(text.match(/VALUES \(.+\), \(/)).not.toBeNull();
      expect(values).toContain(12);
      expect(values).toContain(7);
    });

    it("splices a raw Sql cell as written instead of binding it", () => {
      const em = createTestEntityManager("postgres");
      const { text, values } = em
        .createInsertBuilder(SyncMarker as any)
        .values({ ...ROWS[0], syncedAt: sql`NOW()` } as any)
        .toSql();

      expect(text).toContain("NOW()");
      expect(values).not.toContainEqual(expect.objectContaining({ strings: expect.anything() }));
    });

    it("names the union of columns for heterogeneous rows", () => {
      const em = createTestEntityManager("postgres");
      const { text } = em
        .createInsertBuilder(SyncMarker as any)
        .values([
          { mac: "aa", bucketStart: new Date(0), records: 1 },
          { mac: "bb", bucketStart: new Date(0), lastTime: new Date(0) },
        ] as any)
        .toSql();

      expect(text).toContain('"records"');
      expect(text).toContain('"last_time"');
    });
  });

  describe("portable conditional updates", () => {
    it("compares the stored row against the proposed one in doUpdateWhere", () => {
      const em = createTestEntityManager("postgres");
      const m = qAlias(SyncMarker as any, "m") as any;
      const ex = qExcluded(SyncMarker as any) as any;
      const { text } = em
        .createInsertBuilder(SyncMarker as any)
        .values(ROWS[0] as any)
        .onConflict(["mac", "bucketStart"] as any)
        .doUpdate({ lastTime: ex.lastTime, records: ex.records } as any)
        .doUpdateWhere(m.lastTime.lt(ex.lastTime))
        .toSql();

      expect(text).toContain('WHERE "last_time" < EXCLUDED."last_time"');
    });

    it("renders the iff() CASE fold on MySQL, where doUpdateWhere throws", () => {
      const em = createTestEntityManager("mysql");
      const { text } = em
        .createInsertBuilder(SyncMarker as any)
        .values(ROWS[0] as any)
        .doUpdate((t: any, ex: any) => ({
          lastTime: iff(ex.lastTime.gt(t.lastTime), ex.lastTime, t.lastTime),
        }))
        .toSql();

      expect(text).toContain(
        "`last_time` = CASE WHEN VALUES(`last_time`) > `last_time` " +
          "THEN VALUES(`last_time`) ELSE `last_time` END",
      );
    });
  });

  describe("validation", () => {
    it("rejects a build with no rows", () => {
      const em = createTestEntityManager("postgres");
      expect(() =>
        em.createInsertBuilder(SyncMarker as any).doNothing().toSql(),
      ).toThrow(/no rows to insert/);
    });

    it("rejects an empty conflict target list", () => {
      const em = createTestEntityManager("postgres");
      expect(() =>
        em.createInsertBuilder(SyncMarker as any).onConflict([]),
      ).toThrow(OrmError);
    });

    it("rejects doUpdate with no assignments", () => {
      const em = createTestEntityManager("postgres");
      expect(() =>
        em
          .createInsertBuilder(SyncMarker as any)
          .values(ROWS[0] as any)
          .doUpdate({} as any),
      ).toThrow(/no assignments/);
    });
  });

  describe("execute", () => {
    it("runs the statement and reports the affected count", async () => {
      const em = createTestEntityManager("postgres");
      const { __mockQuery } = jest.requireMock(
        "../../src/dialects/TransactionSessionManager",
      );
      __mockQuery.mockResolvedValue({ results: { rowCount: 2 }, fields: [] });

      const result = await accumulatingUpsert(em).execute();

      expect(result.affected).toBe(2);
      const [statement] = __mockQuery.mock.calls.at(-1);
      expect(statement.text).toContain("ON CONFLICT");
    });
  });
});
