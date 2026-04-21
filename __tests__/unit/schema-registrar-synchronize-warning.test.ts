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

function makeCtx(
  syncOption: boolean | "safe" | "dry-run",
): EntityManagerInternals {
  return {
    wrap: (c: string) => c,
    wrapTable: (t: string) => t,
    isMySqlFamily: () => true,
    isPostgres: () => false,
    isSqlite: () => false,
    getDriver: () => undefined,
    getSynchronize: () => syncOption,
    getDialect: () => "mysql",
    getSchema: () => undefined,
    getConnection: () => undefined,
    getEntities: () => [],
  } as unknown as EntityManagerInternals;
}

describe("SchemaRegistrar: synchronize: true production warning", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAllow = process.env.STINGERLOOM_ALLOW_SYNC_IN_PROD;
  let output: string[];

  beforeEach(() => {
    output = [];
    Logger.reset();
    Logger.setOutput((m) => output.push(m));
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalAllow === undefined) {
      delete process.env.STINGERLOOM_ALLOW_SYNC_IN_PROD;
    } else {
      process.env.STINGERLOOM_ALLOW_SYNC_IN_PROD = originalAllow;
    }
    Logger.reset();
  });

  it("warns when synchronize: true and NODE_ENV=production", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.STINGERLOOM_ALLOW_SYNC_IN_PROD;

    const resolver = {} as RelationMetadataResolver;
    const registrar = new SchemaRegistrar(resolver, makeCtx(true));

    await registrar.registerEntities();

    const warnLines = output.filter((l) => l.includes("WARN"));
    expect(warnLines.length).toBeGreaterThanOrEqual(1);
    expect(warnLines[0]).toContain("synchronize: true");
    expect(warnLines[0]).toContain("DATA LOSS");
  });

  it("does not warn when synchronize: true and NODE_ENV=development", async () => {
    process.env.NODE_ENV = "development";

    const resolver = {} as RelationMetadataResolver;
    const registrar = new SchemaRegistrar(resolver, makeCtx(true));

    await registrar.registerEntities();

    const warnLines = output.filter(
      (l) => l.includes("WARN") && l.includes("synchronize: true"),
    );
    expect(warnLines).toHaveLength(0);
  });

  it("does not warn when synchronize: \"safe\" and NODE_ENV=production", async () => {
    process.env.NODE_ENV = "production";

    const resolver = {} as RelationMetadataResolver;
    const registrar = new SchemaRegistrar(resolver, makeCtx("safe"));

    await registrar.registerEntities();

    const warnLines = output.filter(
      (l) => l.includes("WARN") && l.includes("synchronize: true"),
    );
    expect(warnLines).toHaveLength(0);
  });

  it("does not warn when synchronize: \"dry-run\" and NODE_ENV=production", async () => {
    process.env.NODE_ENV = "production";

    const resolver = {} as RelationMetadataResolver;
    const registrar = new SchemaRegistrar(resolver, makeCtx("dry-run"));

    await registrar.registerEntities();

    const warnLines = output.filter(
      (l) => l.includes("WARN") && l.includes("synchronize: true"),
    );
    expect(warnLines).toHaveLength(0);
  });

  it("silences the warning when STINGERLOOM_ALLOW_SYNC_IN_PROD=true", async () => {
    process.env.NODE_ENV = "production";
    process.env.STINGERLOOM_ALLOW_SYNC_IN_PROD = "true";

    const resolver = {} as RelationMetadataResolver;
    const registrar = new SchemaRegistrar(resolver, makeCtx(true));

    await registrar.registerEntities();

    const warnLines = output.filter(
      (l) => l.includes("WARN") && l.includes("synchronize: true"),
    );
    expect(warnLines).toHaveLength(0);
  });
});
