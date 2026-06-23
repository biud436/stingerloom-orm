/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";

jest.mock("../../src/scanner/ScannerContainer", () => ({
  getScannerInstance: jest.fn(() => ({
    scan: () => undefined,
  })),
}));

import { INDEX_TOKEN, IndexMetadata } from "../../src/decorators/Indexer";
import { COLUMN_TOKEN } from "../../src/decorators/Column";
import { ColumnMetadata } from "../../src/scanner";
import { SchemaRegistrar } from "../../src/core/SchemaRegistrar";
import type { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import type { EntityManagerInternals } from "../../src/core/EntityManagerInternals";

// ──────────────────────────────────────────────
// Fixture: an entity with a single-column @Index() on `email`.
// ──────────────────────────────────────────────
class IndexedUser {}

beforeAll(() => {
  Reflect.defineMetadata(
    INDEX_TOKEN,
    [{ target: IndexedUser, name: "email", type: undefined }] as IndexMetadata[],
    IndexedUser.prototype,
  );
  Reflect.defineMetadata(
    COLUMN_TOKEN,
    [{ propertyKey: "email", name: "email" }] as ColumnMetadata[],
    IndexedUser.prototype,
  );
});

function makeSqliteDriver(opts: { existingIndexNames?: string[] }) {
  const calls = { getIndexes: [] as string[], addIndex: [] as any[] };

  // SQLite's PRAGMA index_list exposes the index name under `name`
  // (not MySQL's `Key_name` / PostgreSQL's `Field`).
  const indexRows = (opts.existingIndexNames ?? []).map((n) => ({ name: n }));

  const driver = {
    getIndexes: jest.fn(async (table: string) => {
      calls.getIndexes.push(table);
      return indexRows;
    }),
    addIndex: jest.fn(async (table: string, column: string, name: string) => {
      calls.addIndex.push({ table, column, name });
    }),
  } as any;

  return { driver, calls };
}

function makeSqliteCtx(driver: any): EntityManagerInternals {
  return {
    wrap: (c: string) => `"${c}"`,
    wrapTable: (t: string) => `"${t}"`,
    isMySqlFamily: () => false,
    isPostgres: () => false,
    isSqlite: () => true,
    getDriver: () => driver,
    getSynchronize: () => true,
    getDialect: () => "sqlite",
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

describe("SchemaRegistrar.registerIndex — SQLite idempotency", () => {
  it("creates the index when none exists", async () => {
    const { driver, calls } = makeSqliteDriver({});
    const registrar = new SchemaRegistrar(noopResolver, makeSqliteCtx(driver));

    await registrar.registerIndex(IndexedUser, "indexed_user");

    expect(calls.addIndex).toHaveLength(1);
    expect(calls.addIndex[0]).toEqual({
      table: "indexed_user",
      column: "email",
      name: "INDEX_indexed_user_email",
    });
  });

  it("detects an existing SQLite index (PRAGMA index_list `name`) and does not re-create it", async () => {
    // Regression: the existence check used Key_name ?? Field only, so SQLite
    // index rows (keyed by `name`) never matched and addIndex re-ran every
    // boot — and SQLite's CREATE INDEX has no IF NOT EXISTS, throwing on the
    // second start.
    const { driver, calls } = makeSqliteDriver({
      existingIndexNames: ["INDEX_indexed_user_email"],
    });
    const registrar = new SchemaRegistrar(noopResolver, makeSqliteCtx(driver));

    await registrar.registerIndex(IndexedUser, "indexed_user");

    expect(calls.getIndexes).toEqual(["indexed_user"]);
    expect(calls.addIndex).toHaveLength(0);
  });
});
