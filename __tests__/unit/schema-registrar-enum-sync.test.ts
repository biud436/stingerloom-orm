/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SchemaRegistrar: PostgreSQL ENUM 타입 프로비저닝 (V4-T0-4)
 *
 * PG의 enum 컬럼은 명명 타입 참조라 CREATE TABLE / ADD COLUMN보다 CREATE TYPE이
 * 먼저 실행되어야 합니다. 이 패스가 없으면 DDL이 `type ... does not exist`로
 * 실패하고 continueOnError 기본값이 warn으로 삼켜, 테이블/컬럼이 조용히
 * 누락됩니다 (2026-08-16 실 PG 확정).
 */
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

const FULL: SynchronizePolicy = {
  mode: true,
  continueOnError: true,
  failOnDestructiveChange: false,
  logDDL: false,
};

/** pg_type/pg_enum을 흉내내는 인메모리 enum 카탈로그. */
function makeEnumDriver(types: Record<string, string[]> = {}) {
  return {
    catalog: types,
    hasEnumType: jest.fn(async (name: string) =>
      types[name] ? [{ typname: name }] : [],
    ),
    listEnumValues: jest.fn(async (name: string) =>
      (types[name] ?? []).map((enumlabel) => ({ enumlabel })),
    ),
    createEnumType: jest.fn(async (name: string, values: string[]) => {
      types[name] = [...values];
    }),
    addEnumValue: jest.fn(
      async (
        name: string,
        value: string,
        placement?: { before?: string; after?: string },
      ) => {
        const current = types[name] ?? [];
        const anchor = placement?.before
          ? current.indexOf(placement.before)
          : -1;
        current.splice(anchor < 0 ? current.length : anchor, 0, value);
        types[name] = current;
      },
    ),
  };
}

function makeRegistrar(
  driver: any,
  policy: SynchronizePolicy = FULL,
  overrides: Partial<Record<string, any>> = {},
) {
  const ctx = {
    wrap: (c: string) => c,
    wrapTable: (t: string) => t,
    isMySqlFamily: () => false,
    isPostgres: () => true,
    isSqlite: () => false,
    getDriver: () => driver,
    getSynchronize: () => policy.mode,
    getSynchronizePolicy: () => policy,
    getDialect: () => "postgres",
    getSchema: () => undefined,
    getConnection: () => undefined,
    getEntities: () => [],
    ...overrides,
  } as unknown as EntityManagerInternals;

  const registrar = new SchemaRegistrar(
    {} as RelationMetadataResolver,
    ctx,
  );
  (registrar as any).activePolicy = policy;
  return registrar;
}

function enumColumn(
  name: string,
  values: string[] | undefined,
  enumName?: string,
): any {
  return {
    name,
    propertyKey: name,
    options: { type: "enum", enumValues: values, enumName },
  };
}

function sync(
  registrar: SchemaRegistrar,
  columns: any[],
  tableName = "post",
  policy: SynchronizePolicy = FULL,
  processed = new Set<string>(),
): Promise<void> {
  return (registrar as any).syncEnumTypes(
    columns,
    tableName,
    policy,
    processed,
  );
}

describe("SchemaRegistrar: PostgreSQL enum type provisioning", () => {
  let output: string[];

  beforeEach(() => {
    output = [];
    Logger.reset();
    Logger.setOutput((m) => output.push(m));
  });

  afterEach(() => {
    Logger.reset();
  });

  it("creates a missing enum type before the table that references it", async () => {
    const driver = makeEnumDriver();
    const registrar = makeRegistrar(driver);

    await sync(registrar, [enumColumn("status", ["draft", "published"])]);

    expect(driver.createEnumType).toHaveBeenCalledTimes(1);
    expect(driver.createEnumType).toHaveBeenCalledWith("post_status_enum", [
      "draft",
      "published",
    ]);
    expect(driver.addEnumValue).not.toHaveBeenCalled();
  });

  it("honors an explicit enumName", async () => {
    const driver = makeEnumDriver();
    const registrar = makeRegistrar(driver);

    await sync(registrar, [
      enumColumn("status", ["draft"], "post_status"),
    ]);

    expect(driver.createEnumType).toHaveBeenCalledWith("post_status", [
      "draft",
    ]);
  });

  it("adds only the missing values to an existing type", async () => {
    const driver = makeEnumDriver({ post_status_enum: ["draft", "published"] });
    const registrar = makeRegistrar(driver);

    await sync(registrar, [
      enumColumn("status", ["draft", "published", "archived"]),
    ]);

    expect(driver.createEnumType).not.toHaveBeenCalled();
    expect(driver.addEnumValue).toHaveBeenCalledTimes(1);
    expect(driver.addEnumValue).toHaveBeenCalledWith(
      "post_status_enum",
      "archived",
      undefined,
    );
  });

  it("inserts a new value at its declared position instead of appending", async () => {
    // 선언 순서 ["draft","archived","published"] — "archived"는 가운데라
    // 그냥 붙이면 ORDER BY 결과가 엔티티 선언과 달라진다.
    const driver = makeEnumDriver({ post_status_enum: ["draft", "published"] });
    const registrar = makeRegistrar(driver);

    await sync(registrar, [
      enumColumn("status", ["draft", "archived", "published"]),
    ]);

    expect(driver.addEnumValue).toHaveBeenCalledWith(
      "post_status_enum",
      "archived",
      { before: "published" },
    );
    expect(driver.catalog.post_status_enum).toEqual([
      "draft",
      "archived",
      "published",
    ]);
  });

  it("anchors consecutive new values against each other", async () => {
    const driver = makeEnumDriver({ post_status_enum: ["draft", "published"] });
    const registrar = makeRegistrar(driver);

    await sync(registrar, [
      enumColumn("status", ["draft", "review", "queued", "published"]),
    ]);

    expect(driver.catalog.post_status_enum).toEqual([
      "draft",
      "review",
      "queued",
      "published",
    ]);
  });

  it("does nothing when the type already matches", async () => {
    const driver = makeEnumDriver({ post_status_enum: ["draft", "published"] });
    const registrar = makeRegistrar(driver);

    await sync(registrar, [enumColumn("status", ["draft", "published"])]);

    expect(driver.createEnumType).not.toHaveBeenCalled();
    expect(driver.addEnumValue).not.toHaveBeenCalled();
    expect(output).toEqual([]);
  });

  it("reports database values the entity dropped instead of removing them", async () => {
    const driver = makeEnumDriver({
      post_status_enum: ["draft", "published", "legacy"],
    });
    const registrar = makeRegistrar(driver);

    await sync(registrar, [enumColumn("status", ["draft", "published"])]);

    const warn = output.filter((l) => l.includes("WARN"));
    expect(warn).toHaveLength(1);
    expect(warn[0]).toContain('"legacy"');
    expect(driver.catalog.post_status_enum).toContain("legacy");
  });

  it("warns when an enum column declares no values", async () => {
    const driver = makeEnumDriver();
    const registrar = makeRegistrar(driver);

    await sync(registrar, [enumColumn("status", undefined)]);

    expect(driver.hasEnumType).not.toHaveBeenCalled();
    expect(
      output.some(
        (l) => l.includes("WARN") && l.includes("declares no enumValues"),
      ),
    ).toBe(true);
  });

  it("inspects each enum type once per run", async () => {
    const driver = makeEnumDriver();
    const registrar = makeRegistrar(driver);
    const processed = new Set<string>();

    await sync(
      registrar,
      [
        enumColumn("status", ["a"], "shared_enum"),
        enumColumn("prev_status", ["a"], "shared_enum"),
      ],
      "post",
      FULL,
      processed,
    );
    await sync(registrar, [enumColumn("kind", ["a"], "shared_enum")], "comment", FULL, processed);

    expect(driver.hasEnumType).toHaveBeenCalledTimes(1);
    expect(driver.createEnumType).toHaveBeenCalledTimes(1);
  });

  describe("synchronize modes", () => {
    it("applies additive enum DDL in safe mode", async () => {
      // CREATE TYPE / ADD VALUE는 비파괴적이고, safe 모드가 수행하는
      // CREATE TABLE·ADD COLUMN이 이 타입을 필요로 한다.
      const policy: SynchronizePolicy = { ...FULL, mode: "safe" };
      const driver = makeEnumDriver({ post_status_enum: ["draft"] });
      const registrar = makeRegistrar(driver, policy);

      await sync(
        registrar,
        [enumColumn("status", ["draft", "published"])],
        "post",
        policy,
      );

      expect(driver.addEnumValue).toHaveBeenCalledTimes(1);
    });

    it("only logs in dry-run mode", async () => {
      const policy: SynchronizePolicy = { ...FULL, mode: "dry-run" };
      const driver = makeEnumDriver();
      const registrar = makeRegistrar(driver, policy);

      await sync(
        registrar,
        [enumColumn("status", ["draft", "published"])],
        "post",
        policy,
      );

      expect(driver.createEnumType).not.toHaveBeenCalled();
      expect(
        output.some((l) =>
          l.includes(
            `[dry-run] Would CREATE TYPE post_status_enum AS ENUM ('draft', 'published')`,
          ),
        ),
      ).toBe(true);
    });

    it("logs the ADD VALUE it would run in dry-run mode", async () => {
      const policy: SynchronizePolicy = { ...FULL, mode: "dry-run" };
      const driver = makeEnumDriver({ post_status_enum: ["draft"] });
      const registrar = makeRegistrar(driver, policy);

      await sync(
        registrar,
        [enumColumn("status", ["draft", "published"])],
        "post",
        policy,
      );

      expect(driver.addEnumValue).not.toHaveBeenCalled();
      expect(
        output.some((l) =>
          l.includes(
            `[dry-run] Would ALTER TYPE post_status_enum ADD VALUE IF NOT EXISTS 'published'`,
          ),
        ),
      ).toBe(true);
    });

    it("prints the executed DDL when logDDL is on, and stays quiet otherwise", async () => {
      const loud: SynchronizePolicy = { ...FULL, logDDL: true };
      const driver = makeEnumDriver();
      const registrar = makeRegistrar(driver, loud);

      await sync(registrar, [enumColumn("status", ["draft"])], "post", loud);

      expect(
        output.some((l) =>
          l.includes(`[sync] CREATE TYPE post_status_enum AS ENUM ('draft')`),
        ),
      ).toBe(true);

      output.length = 0;
      const quietDriver = makeEnumDriver();
      const quiet = makeRegistrar(quietDriver, FULL);
      await sync(quiet, [enumColumn("status", ["draft"])]);
      expect(output).toEqual([]);
    });
  });

  describe("non-PostgreSQL dialects", () => {
    it("is a no-op when the connection is not PostgreSQL", async () => {
      const driver = makeEnumDriver();
      const registrar = makeRegistrar(driver, FULL, {
        isPostgres: () => false,
        isMySqlFamily: () => true,
        getDialect: () => "mysql",
      });

      await sync(registrar, [enumColumn("status", ["draft"])]);

      expect(driver.hasEnumType).not.toHaveBeenCalled();
    });

    it("is a no-op when the driver has no enum API", async () => {
      const registrar = makeRegistrar({ createTable: jest.fn() });

      await expect(
        sync(registrar, [enumColumn("status", ["draft"])]),
      ).resolves.toBeUndefined();
    });
  });

  describe("failure handling", () => {
    it("warns and continues when continueOnError is true", async () => {
      const driver = makeEnumDriver();
      driver.createEnumType.mockRejectedValueOnce(new Error("boom"));
      const registrar = makeRegistrar(driver);

      await sync(registrar, [enumColumn("status", ["draft"])]);

      expect(
        output.some(
          (l) =>
            l.includes("WARN") &&
            l.includes("Failed to create enum type post_status_enum"),
        ),
      ).toBe(true);
    });

    it("aborts boot when continueOnError is false", async () => {
      const policy: SynchronizePolicy = { ...FULL, continueOnError: false };
      const driver = makeEnumDriver();
      driver.createEnumType.mockRejectedValueOnce(new Error("boom"));
      const registrar = makeRegistrar(driver, policy);

      const error = await sync(
        registrar,
        [enumColumn("status", ["draft"])],
        "post",
        policy,
      ).catch((e) => e);

      expect(error).toBeInstanceOf(OrmError);
      expect(error).toMatchObject({ code: OrmErrorCode.SCHEMA_SYNC_FAILED });
    });

    it("skips the type when the catalog lookup itself fails", async () => {
      const driver = makeEnumDriver();
      driver.hasEnumType.mockRejectedValueOnce(new Error("no catalog"));
      const registrar = makeRegistrar(driver);

      await sync(registrar, [enumColumn("status", ["draft"])]);

      expect(driver.createEnumType).not.toHaveBeenCalled();
      expect(
        output.some((l) => l.includes("Failed to inspect enum type")),
      ).toBe(true);
    });
  });
});

describe("SchemaRegistrar: ADD COLUMN backfill default", () => {
  let output: string[];

  beforeEach(() => {
    output = [];
    Logger.reset();
    Logger.setOutput((m) => output.push(m));
  });

  afterEach(() => {
    Logger.reset();
  });

  function typeDef(col: any, mysql = true): string {
    const registrar = makeRegistrar(makeEnumDriver(), FULL, {
      isPostgres: () => !mysql,
      isMySqlFamily: () => mysql,
      getDialect: () => (mysql ? "mysql" : "postgres"),
    });
    return (registrar as any).buildAddColumnTypeDef(col);
  }

  it("adds a NOT NULL enum column as nullable rather than DEFAULT ''", () => {
    // `''`는 선언된 값 목록에 없으면 유효한 기본값이 아니라서 MySQL이
    // ENUM(...) NOT NULL DEFAULT '' 를 1067로 거절한다. 반대로 첫 번째 값을
    // 채우면 없는 데이터를 만들어내므로, 컬럼을 nullable로 추가한다.
    const def = typeDef({
      tableName: "post",
      columnName: "status",
      columnType: "ENUM",
      enumValues: ["draft", "published"],
      nullable: false,
    });

    expect(def).toBe(`ENUM('draft','published') NULL`);
  });

  it("reports the weakened nullability instead of applying it silently", () => {
    typeDef({
      tableName: "post",
      columnName: "status",
      columnType: "ENUM",
      enumValues: ["draft"],
      nullable: false,
    });

    expect(
      output.some(
        (l) =>
          l.includes("WARN") &&
          l.includes("post.status") &&
          l.includes("no safe backfill default"),
      ),
    ).toBe(true);
  });

  it("keeps the existing defaults for string and numeric columns", () => {
    expect(
      typeDef({
        tableName: "post",
        columnName: "title",
        columnType: "VARCHAR",
        expectedLength: 255,
        nullable: false,
      }),
    ).toBe(`VARCHAR(255) NOT NULL DEFAULT ''`);

    expect(
      typeDef({
        tableName: "post",
        columnName: "views",
        columnType: "INT",
        nullable: false,
      }),
    ).toBe(`INT NOT NULL DEFAULT 0`);
  });
});
