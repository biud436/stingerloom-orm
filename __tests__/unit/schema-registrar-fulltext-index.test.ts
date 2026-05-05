/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";

jest.mock("../../src/scanner/ScannerContainer", () => ({
  getScannerInstance: jest.fn(() => ({
    scan: () => undefined,
  })),
}));

import { ENTITY_TOKEN } from "../../src/decorators/Entity";
import {
  FULLTEXT_INDEX_TOKEN,
  FullTextIndexMetadata,
} from "../../src/decorators/FullTextIndex";
import { SchemaRegistrar } from "../../src/core/SchemaRegistrar";
import type { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import type { EntityManagerInternals } from "../../src/core/EntityManagerInternals";

// ──────────────────────────────────────────────
// Test fixtures (decorator-free — the FT pass only reads class-level
// metadata, so we set it via Reflect to keep the scanner mock viable).
// ──────────────────────────────────────────────

class Post {}
class NamedPost {}
class PlainEntity {}

beforeAll(() => {
  Reflect.defineMetadata(ENTITY_TOKEN, { name: "post" }, Post);
  Reflect.defineMetadata(
    FULLTEXT_INDEX_TOKEN,
    [{ columns: ["title", "body"] }] as FullTextIndexMetadata[],
    Post,
  );

  Reflect.defineMetadata(ENTITY_TOKEN, { name: "named_post" }, NamedPost);
  Reflect.defineMetadata(
    FULLTEXT_INDEX_TOKEN,
    [
      { columns: ["title"], name: "custom_fts_name", language: "simple" },
    ] as FullTextIndexMetadata[],
    NamedPost,
  );

  Reflect.defineMetadata(ENTITY_TOKEN, { name: "plain" }, PlainEntity);
});

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function makeDriver(opts: {
  existingIndexNames?: string[];
  dialect: "mysql" | "postgres" | "sqlite";
}) {
  const calls = {
    executeRaw: [] as string[],
    getIndexes: [] as string[],
  };

  const indexRows =
    opts.dialect === "mysql"
      ? (opts.existingIndexNames ?? []).map((n) => ({ Key_name: n }))
      : (opts.existingIndexNames ?? []).map((n) => ({ Field: n }));

  const driver = {
    getIndexes: jest.fn(async (table: string) => {
      calls.getIndexes.push(table);
      return indexRows;
    }),
    executeRaw: jest.fn(async (ddl: string) => {
      calls.executeRaw.push(ddl);
    }),
  } as any;

  return { driver, calls };
}

function makeCtx(
  driver: any,
  dialect: "mysql" | "postgres" | "sqlite",
): EntityManagerInternals {
  return {
    wrap: (c: string) => (dialect === "mysql" ? `\`${c}\`` : `"${c}"`),
    wrapTable: (t: string) => (dialect === "mysql" ? `\`${t}\`` : `"${t}"`),
    isMySqlFamily: () => dialect === "mysql",
    isPostgres: () => dialect === "postgres",
    isSqlite: () => dialect === "sqlite",
    getDriver: () => driver,
    getSynchronize: () => true,
    getDialect: () => dialect,
    getSchema: () => undefined,
    getConnection: () => undefined,
    getEntities: () => [],
    getNameStrategy: (e: any) => e.name,
  } as unknown as EntityManagerInternals;
}

const noopResolver: RelationMetadataResolver = {
  resolveManyToOneMetadata: () => [],
  resolveOneToOneMetadata: () => [],
} as unknown as RelationMetadataResolver;

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

describe("SchemaRegistrar.registerFullTextIndexes", () => {
  it("MySQL: emits CREATE FULLTEXT INDEX with default name on first sync", async () => {
    const { driver, calls } = makeDriver({ dialect: "mysql" });
    const registrar = new SchemaRegistrar(noopResolver, makeCtx(driver, "mysql"));

    await registrar.registerFullTextIndexes(Post, "post");

    expect(calls.executeRaw).toHaveLength(1);
    expect(calls.executeRaw[0]).toMatch(/CREATE FULLTEXT INDEX/);
    expect(calls.executeRaw[0]).toContain("`fts_post_title_body`");
    expect(calls.executeRaw[0]).toContain("`title`");
    expect(calls.executeRaw[0]).toContain("`body`");
  });

  it("MySQL: respects user-supplied index name", async () => {
    const { driver, calls } = makeDriver({ dialect: "mysql" });
    const registrar = new SchemaRegistrar(noopResolver, makeCtx(driver, "mysql"));

    await registrar.registerFullTextIndexes(NamedPost, "named_post");

    expect(calls.executeRaw).toHaveLength(1);
    expect(calls.executeRaw[0]).toContain("`custom_fts_name`");
  });

  it("PostgreSQL: emits CREATE INDEX IF NOT EXISTS ... USING gin (to_tsvector(...))", async () => {
    const { driver, calls } = makeDriver({ dialect: "postgres" });
    const registrar = new SchemaRegistrar(
      noopResolver,
      makeCtx(driver, "postgres"),
    );

    await registrar.registerFullTextIndexes(Post, "post");

    expect(calls.executeRaw).toHaveLength(1);
    const ddl = calls.executeRaw[0];
    expect(ddl).toMatch(/CREATE INDEX IF NOT EXISTS/);
    expect(ddl).toContain('"fts_post_title_body"');
    expect(ddl).toMatch(/USING gin/);
    expect(ddl).toMatch(/to_tsvector\('english'/);
    expect(ddl).toContain('"title"');
    expect(ddl).toContain('"body"');
  });

  it("PostgreSQL: honors language option", async () => {
    const { driver, calls } = makeDriver({ dialect: "postgres" });
    const registrar = new SchemaRegistrar(
      noopResolver,
      makeCtx(driver, "postgres"),
    );

    await registrar.registerFullTextIndexes(NamedPost, "named_post");

    expect(calls.executeRaw).toHaveLength(1);
    expect(calls.executeRaw[0]).toMatch(/to_tsvector\('simple'/);
  });

  it("SQLite: emits no DDL", async () => {
    const { driver, calls } = makeDriver({ dialect: "sqlite" });
    const registrar = new SchemaRegistrar(
      noopResolver,
      makeCtx(driver, "sqlite"),
    );

    await registrar.registerFullTextIndexes(Post, "post");

    expect(calls.executeRaw).toHaveLength(0);
    expect(calls.getIndexes).toHaveLength(0);
  });

  it("is a noop for entities without @FullTextIndex", async () => {
    const { driver, calls } = makeDriver({ dialect: "mysql" });
    const registrar = new SchemaRegistrar(noopResolver, makeCtx(driver, "mysql"));

    await registrar.registerFullTextIndexes(PlainEntity, "plain");

    expect(calls.executeRaw).toHaveLength(0);
    expect(calls.getIndexes).toHaveLength(0);
  });

  it("MySQL: skips re-issuing DDL when the index already exists", async () => {
    const { driver, calls } = makeDriver({
      dialect: "mysql",
      existingIndexNames: ["fts_post_title_body"],
    });
    const registrar = new SchemaRegistrar(noopResolver, makeCtx(driver, "mysql"));

    await registrar.registerFullTextIndexes(Post, "post");

    expect(calls.executeRaw).toHaveLength(0);
  });

  it("PostgreSQL: skips re-issuing DDL when the index already exists", async () => {
    const { driver, calls } = makeDriver({
      dialect: "postgres",
      existingIndexNames: ["fts_post_title_body"],
    });
    const registrar = new SchemaRegistrar(
      noopResolver,
      makeCtx(driver, "postgres"),
    );

    await registrar.registerFullTextIndexes(Post, "post");

    expect(calls.executeRaw).toHaveLength(0);
  });

  it("MySQL: warns and continues on driver failure for one index", async () => {
    const { driver } = makeDriver({ dialect: "mysql" });
    driver.executeRaw = jest.fn(async () => {
      throw new Error("simulated DDL failure");
    });
    const registrar = new SchemaRegistrar(noopResolver, makeCtx(driver, "mysql"));

    await expect(
      registrar.registerFullTextIndexes(Post, "post"),
    ).resolves.toBeUndefined();
  });
});
