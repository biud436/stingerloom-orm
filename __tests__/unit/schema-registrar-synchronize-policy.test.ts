/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { Logger } from "../../src/utils/Logger";

jest.mock("../../src/scanner/ScannerContainer", () => ({
  getScannerInstance: jest.fn(() => ({
    makeEntities: () => ({
      next: () => ({ done: true, value: undefined }),
    }),
  })),
}));

import { SchemaRegistrar } from "../../src/core/SchemaRegistrar";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { EntityManagerInternals } from "../../src/core/EntityManagerInternals";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";
import { SynchronizePolicy } from "../../src/core/DatabaseClientOptions";
import { UNIQUE_INDEX_TOKEN } from "../../src/decorators/UniqueIndex";

function makeCtxWithPolicy(policy: SynchronizePolicy): EntityManagerInternals {
  return {
    wrap: (c: string) => c,
    wrapTable: (t: string) => t,
    isMySqlFamily: () => true,
    isPostgres: () => false,
    isSqlite: () => false,
    getDriver: () => undefined,
    getSynchronize: () => policy.mode,
    getSynchronizePolicy: () => policy,
    getDialect: () => "mysql",
    getSchema: () => undefined,
    getConnection: () => undefined,
    getEntities: () => [],
  } as unknown as EntityManagerInternals;
}

describe("SchemaRegistrar: synchronize policy", () => {
  let output: string[];

  beforeEach(() => {
    output = [];
    Logger.reset();
    Logger.setOutput((m) => output.push(m));
  });

  afterEach(() => {
    Logger.reset();
  });

  describe("addCompositeUniqueIndex error path", () => {
    function makeDriverThatFailsUnique() {
      return {
        getIndexes: jest.fn(async () => []),
        addCompositeUniqueIndex: jest.fn(async () => {
          throw new Error("boom");
        }),
      } as any;
    }

    function makeRegistrarWithFailingDriver(policy: SynchronizePolicy) {
      const driver = makeDriverThatFailsUnique();
      const ctx = {
        ...makeCtxWithPolicy(policy),
        getDriver: () => driver,
      } as EntityManagerInternals;
      const resolver = {} as RelationMetadataResolver;
      const registrar = new SchemaRegistrar(resolver, ctx);
      // Prime activePolicy without running full registerEntities()
      (registrar as any).activePolicy = policy;
      return { registrar, driver };
    }

    class FakeEntity {}
    // Inject a UniqueIndex declaration so registerUniqueIndexes() actually runs
    Reflect.defineMetadata(
      UNIQUE_INDEX_TOKEN,
      [{ name: "uq_x", columns: ["a", "b"] }],
      FakeEntity,
    );

    it("warns and continues when continueOnError=true (default)", async () => {
      const policy: SynchronizePolicy = {
        mode: true,
        continueOnError: true,
        failOnDestructiveChange: false,
        logDDL: false,
      };
      const { registrar } = makeRegistrarWithFailingDriver(policy);

      // Should not throw
      await registrar.registerUniqueIndexes(FakeEntity, "fake_table");

      const warnLines = output.filter((l) => l.includes("WARN"));
      expect(warnLines.length).toBeGreaterThan(0);
      expect(warnLines.some((l) => l.includes("Could not create unique index"))).toBe(
        true,
      );
    });

    it("throws when continueOnError=false", async () => {
      const policy: SynchronizePolicy = {
        mode: true,
        continueOnError: false,
        failOnDestructiveChange: false,
        logDDL: false,
      };
      const { registrar } = makeRegistrarWithFailingDriver(policy);

      await expect(
        registrar.registerUniqueIndexes(FakeEntity, "fake_table"),
      ).rejects.toBeInstanceOf(OrmError);

      await expect(
        registrar.registerUniqueIndexes(FakeEntity, "fake_table"),
      ).rejects.toMatchObject({ code: OrmErrorCode.SCHEMA_SYNC_FAILED });
    });
  });

  describe("destructive-change guard", () => {
    function callApplyDiff(
      policy: SynchronizePolicy,
      diff: any,
    ): Promise<void> {
      const driverCalls: string[] = [];
      const driver: any = {
        dropColumn: jest.fn(async () => {
          driverCalls.push("dropColumn");
        }),
        addColumn: jest.fn(async () => {
          driverCalls.push("addColumn");
        }),
        executeRaw: jest.fn(async () => {
          driverCalls.push("executeRaw");
        }),
      };
      const ctx = {
        ...makeCtxWithPolicy(policy),
        getDriver: () => driver,
      } as EntityManagerInternals;
      const registrar = new SchemaRegistrar(
        {} as RelationMetadataResolver,
        ctx,
      );
      (registrar as any).activePolicy = policy;
      return (registrar as any).applySchemaDiff(
        diff,
        new Map(),
        policy,
        "mysql",
      );
    }

    it("throws SCHEMA_SYNC_DESTRUCTIVE_CHANGE on DROP COLUMN when failOnDestructiveChange=true", async () => {
      const diff = {
        addTables: [],
        dropTables: [],
        addColumns: [],
        alterColumns: [],
        dropColumns: [
          { tableName: "t", columnName: "stale" },
        ],
      };
      const policy: SynchronizePolicy = {
        mode: true,
        continueOnError: true,
        failOnDestructiveChange: true,
        logDDL: false,
      };

      await expect(callApplyDiff(policy, diff)).rejects.toMatchObject({
        code: OrmErrorCode.SCHEMA_SYNC_DESTRUCTIVE_CHANGE,
      });
    });

    it("throws on narrowing ALTER (varchar → int) when failOnDestructiveChange=true", async () => {
      const diff = {
        addTables: [],
        dropTables: [],
        addColumns: [],
        dropColumns: [],
        alterColumns: [
          {
            tableName: "t",
            columnName: "code",
            currentType: "VARCHAR",
            columnType: "INT",
          },
        ],
      };
      const policy: SynchronizePolicy = {
        mode: true,
        continueOnError: true,
        failOnDestructiveChange: true,
        logDDL: false,
      };

      await expect(callApplyDiff(policy, diff)).rejects.toMatchObject({
        code: OrmErrorCode.SCHEMA_SYNC_DESTRUCTIVE_CHANGE,
      });
    });

    it("throws on length-shrinking ALTER (varchar(255) → varchar(64))", async () => {
      const diff = {
        addTables: [],
        dropTables: [],
        addColumns: [],
        dropColumns: [],
        alterColumns: [
          {
            tableName: "t",
            columnName: "name",
            currentType: "VARCHAR",
            columnType: "VARCHAR",
            actualLength: 255,
            expectedLength: 64,
          },
        ],
      };
      const policy: SynchronizePolicy = {
        mode: true,
        continueOnError: true,
        failOnDestructiveChange: true,
        logDDL: false,
      };

      await expect(callApplyDiff(policy, diff)).rejects.toMatchObject({
        code: OrmErrorCode.SCHEMA_SYNC_DESTRUCTIVE_CHANGE,
      });
    });

    it("does not throw on a widening ALTER (varchar(64) → varchar(255))", async () => {
      const diff = {
        addTables: [],
        dropTables: [],
        addColumns: [],
        dropColumns: [],
        alterColumns: [
          {
            tableName: "t",
            columnName: "name",
            currentType: "VARCHAR",
            columnType: "VARCHAR",
            actualLength: 64,
            expectedLength: 255,
          },
        ],
      };
      const policy: SynchronizePolicy = {
        mode: true,
        continueOnError: true,
        failOnDestructiveChange: true,
        logDDL: false,
      };

      await expect(callApplyDiff(policy, diff)).resolves.toBeUndefined();
    });

    it("throws on a tightening nullability ALTER (NULL → NOT NULL) when failOnDestructiveChange=true", async () => {
      const diff = {
        addTables: [],
        dropTables: [],
        addColumns: [],
        dropColumns: [],
        alterColumns: [
          {
            tableName: "t",
            columnName: "email",
            columnType: "VARCHAR",
            currentType: "varchar",
            nullable: false,
            currentNullable: true,
            typeChanged: false,
            expectedLength: 255,
          },
        ],
      };
      const policy: SynchronizePolicy = {
        mode: true,
        continueOnError: true,
        failOnDestructiveChange: true,
        logDDL: false,
      };

      await expect(callApplyDiff(policy, diff)).rejects.toMatchObject({
        code: OrmErrorCode.SCHEMA_SYNC_DESTRUCTIVE_CHANGE,
      });
    });

    it("does not throw on a loosening nullability ALTER (NOT NULL → NULL)", async () => {
      const diff = {
        addTables: [],
        dropTables: [],
        addColumns: [],
        dropColumns: [],
        alterColumns: [
          {
            tableName: "t",
            columnName: "bio",
            columnType: "TEXT",
            currentType: "text",
            nullable: true,
            currentNullable: false,
            typeChanged: false,
          },
        ],
      };
      const policy: SynchronizePolicy = {
        mode: true,
        continueOnError: true,
        failOnDestructiveChange: true,
        logDDL: false,
      };

      await expect(callApplyDiff(policy, diff)).resolves.toBeUndefined();
    });

    it("does not throw on DROP COLUMN when failOnDestructiveChange=false (default)", async () => {
      const diff = {
        addTables: [],
        dropTables: [],
        addColumns: [],
        alterColumns: [],
        dropColumns: [
          { tableName: "t", columnName: "stale" },
        ],
      };
      const policy: SynchronizePolicy = {
        mode: true,
        continueOnError: true,
        failOnDestructiveChange: false,
        logDDL: false,
      };

      await expect(callApplyDiff(policy, diff)).resolves.toBeUndefined();
    });
  });

  describe("buildAlterColumnDDL — nullability (PostgreSQL)", () => {
    function buildDDL(col: any, dialect: "postgres" | "mysql" = "postgres"): string | null {
      const policy: SynchronizePolicy = {
        mode: true,
        continueOnError: true,
        failOnDestructiveChange: false,
        logDDL: false,
      };
      const registrar = new SchemaRegistrar(
        {} as RelationMetadataResolver,
        makeCtxWithPolicy(policy),
      );
      return (registrar as any).buildAlterColumnDDL(col, dialect);
    }

    it("emits SET NOT NULL without a TYPE rewrite for a nullability-only tighten", () => {
      const ddl = buildDDL({
        tableName: "t",
        columnName: "email",
        columnType: "VARCHAR",
        currentType: "varchar",
        nullable: false,
        currentNullable: true,
        typeChanged: false,
        expectedLength: 255,
      });
      expect(ddl).toContain("SET NOT NULL");
      expect(ddl).not.toContain("TYPE");
    });

    it("emits DROP NOT NULL for a nullability-only loosen", () => {
      const ddl = buildDDL({
        tableName: "t",
        columnName: "bio",
        columnType: "TEXT",
        currentType: "text",
        nullable: true,
        currentNullable: false,
        typeChanged: false,
      });
      expect(ddl).toContain("DROP NOT NULL");
    });

    it("combines a TYPE rewrite and a nullability action in a single ALTER TABLE", () => {
      const ddl = buildDDL({
        tableName: "t",
        columnName: "email",
        columnType: "TEXT",
        currentType: "varchar",
        nullable: false,
        currentNullable: true,
        // typeChanged omitted → real type alter
      });
      expect(ddl).toContain("TYPE TEXT");
      expect(ddl).toContain("SET NOT NULL");
      // a single statement, not two
      expect((ddl ?? "").match(/ALTER TABLE/g)).toHaveLength(1);
    });

    it("returns null when neither type nor nullability changed", () => {
      const ddl = buildDDL({
        tableName: "t",
        columnName: "name",
        columnType: "VARCHAR",
        currentType: "varchar",
        nullable: false,
        currentNullable: false,
        typeChanged: false,
        expectedLength: 255,
      });
      expect(ddl).toBeNull();
    });
  });

  describe("logDDL flag", () => {
    function captureInfo() {
      return output.filter((l) => l.includes("INFO"));
    }

    it("does NOT emit per-DDL info logs by default", async () => {
      const policy: SynchronizePolicy = {
        mode: true,
        continueOnError: true,
        failOnDestructiveChange: false,
        logDDL: false,
      };
      const ctx = makeCtxWithPolicy(policy);
      const registrar = new SchemaRegistrar(
        {} as RelationMetadataResolver,
        ctx,
      );
      (registrar as any).activePolicy = policy;

      (registrar as any).logDdl("[sync] CREATE TABLE foo", policy);

      expect(captureInfo()).toHaveLength(0);
    });

    it("emits the DDL string when logDDL=true", async () => {
      const policy: SynchronizePolicy = {
        mode: true,
        continueOnError: true,
        failOnDestructiveChange: false,
        logDDL: true,
      };
      const ctx = makeCtxWithPolicy(policy);
      const registrar = new SchemaRegistrar(
        {} as RelationMetadataResolver,
        ctx,
      );
      (registrar as any).activePolicy = policy;

      (registrar as any).logDdl("[sync] CREATE TABLE foo", policy);

      const infoLines = captureInfo();
      expect(infoLines.length).toBeGreaterThan(0);
      expect(infoLines.some((l) => l.includes("CREATE TABLE foo"))).toBe(true);
    });
  });
});
