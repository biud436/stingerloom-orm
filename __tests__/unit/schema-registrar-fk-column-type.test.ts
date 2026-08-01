/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";

jest.mock("../../src/scanner/ScannerContainer", () => ({
  getScannerInstance: jest.fn(() => ({
    scan: (entity: any) => mockEntityScans.get(entity),
  })),
}));

import { COLUMN_TOKEN } from "../../src/decorators";
import { SchemaRegistrar } from "../../src/core/SchemaRegistrar";
import type { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import type { EntityManagerInternals } from "../../src/core/EntityManagerInternals";

// ──────────────────────────────────────────────
// Test fixtures
// ──────────────────────────────────────────────

const mockEntityScans = new Map<any, any>();

class IntPkParent {}
class UuidPkParent {}
class VarcharPkParent {}
class BigintPkParent {}

class IntChild {}
class UuidChild {}
class VarcharChild {}
class BigintChild {}
class O2OChild {}

beforeAll(() => {
  // Define COLUMN_TOKEN metadata directly so resolvePkColumnType can read PK types.
  Reflect.defineMetadata(
    COLUMN_TOKEN,
    [{ name: "id", propertyKey: "id", options: { primary: true, type: "int" } }],
    IntPkParent.prototype,
  );
  Reflect.defineMetadata(
    COLUMN_TOKEN,
    [{ name: "id", propertyKey: "id", options: { primary: true, type: "uuid" } }],
    UuidPkParent.prototype,
  );
  Reflect.defineMetadata(
    COLUMN_TOKEN,
    [
      {
        name: "id",
        propertyKey: "id",
        options: { primary: true, type: "varchar", length: 36 },
      },
    ],
    VarcharPkParent.prototype,
  );
  Reflect.defineMetadata(
    COLUMN_TOKEN,
    [{ name: "id", propertyKey: "id", options: { primary: true, type: "bigint" } }],
    BigintPkParent.prototype,
  );

  // Stub entityScanner.scan() return values: only `name` and `columns` are read by registerForeignKeys.
  mockEntityScans.set(IntPkParent, {
    name: "int_pk_parent",
    columns: [{ name: "id", options: { primary: true, type: "int" } }],
  });
  mockEntityScans.set(UuidPkParent, {
    name: "uuid_pk_parent",
    columns: [{ name: "id", options: { primary: true, type: "uuid" } }],
  });
  mockEntityScans.set(VarcharPkParent, {
    name: "varchar_pk_parent",
    columns: [
      { name: "id", options: { primary: true, type: "varchar", length: 36 } },
    ],
  });
  mockEntityScans.set(BigintPkParent, {
    name: "bigint_pk_parent",
    columns: [{ name: "id", options: { primary: true, type: "bigint" } }],
  });
});

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function makeDriver() {
  const calls = {
    addColumn: [] as Array<{ table: string; col: string; type: string }>,
    addForeignKey: [] as Array<{ table: string; col: string; refTable: string; refCol: string }>,
  };

  const driver = {
    castType: (type: string) => {
      // Mimic an MySQL-ish driver — only the int branch matters for the
      // regression case; resolvePkColumnType handles uuid/varchar/bigint via
      // its own logic that reuses driver.castType for the type→SQL mapping.
      switch (type) {
        case "int":
          return "INT";
        case "uuid":
          return "CHAR(36)";
        case "varchar":
          return "VARCHAR";
        case "bigint":
          return "BIGINT";
        default:
          return type.toUpperCase();
      }
    },
    hasColumn: jest.fn(async () => false),
    addColumn: jest.fn(async (table: string, col: string, type: string) => {
      calls.addColumn.push({ table, col, type });
    }),
    hasForeignKey: jest.fn(async () => false),
    addForeignKey: jest.fn(
      async (table: string, col: string, refTable: string, refCol: string) => {
        calls.addForeignKey.push({ table, col, refTable, refCol });
      },
    ),
  } as any;

  return { driver, calls };
}

function makeCtx(driver: any): EntityManagerInternals {
  return {
    wrap: (c: string) => `\`${c}\``,
    wrapTable: (t: string) => `\`${t}\``,
    isMySqlFamily: () => true,
    isPostgres: () => false,
    isSqlite: () => false,
    getDriver: () => driver,
    getSynchronize: () => true,
    getDialect: () => "mysql",
    getSchema: () => undefined,
    getConnection: () => undefined,
    getEntities: () => [],
    getNameStrategy: (e: any) => mockEntityScans.get(e)?.name ?? e.name,
  } as unknown as EntityManagerInternals;
}

function makeM2OResolver(items: any[]): RelationMetadataResolver {
  return {
    resolveManyToOneMetadata: () => items,
    resolveOneToOneMetadata: () => [],
  } as unknown as RelationMetadataResolver;
}

function makeO2OResolver(items: any[]): RelationMetadataResolver {
  return {
    resolveManyToOneMetadata: () => [],
    resolveOneToOneMetadata: () => items,
  } as unknown as RelationMetadataResolver;
}

function m2oItem(parent: any, joinColumn: string, option: any = {}) {
  return {
    joinColumn,
    getMappingEntity: () => parent,
    option,
    references: undefined,
  };
}

function o2oItem(parent: any, joinColumn: string, option: any = {}) {
  return {
    joinColumn,
    getRelatedEntity: () => parent,
    option,
  };
}

// ──────────────────────────────────────────────
// #284 — M2O FK column type derivation
// ──────────────────────────────────────────────

describe("SchemaRegistrar.registerForeignKeys — M2O/O2O FK column type (#284)", () => {
  it("auto-adds INT FK column when parent has INT PK (regression)", async () => {
    const { driver, calls } = makeDriver();
    const registrar = new SchemaRegistrar(
      makeM2OResolver([m2oItem(IntPkParent, "parent_id")]),
      makeCtx(driver),
    );

    await registrar.registerForeignKeys(IntChild, "int_child");

    expect(calls.addColumn).toHaveLength(1);
    expect(calls.addColumn[0].col).toBe("parent_id");
    expect(calls.addColumn[0].type).toBe("INT NULL");
  });

  it("auto-adds UUID FK column (CHAR(36)) when parent has UUID PK", async () => {
    const { driver, calls } = makeDriver();
    const registrar = new SchemaRegistrar(
      makeM2OResolver([m2oItem(UuidPkParent, "parent_id")]),
      makeCtx(driver),
    );

    await registrar.registerForeignKeys(UuidChild, "uuid_child");

    expect(calls.addColumn).toHaveLength(1);
    expect(calls.addColumn[0].col).toBe("parent_id");
    expect(calls.addColumn[0].type).toBe("CHAR(36) NULL");
  });

  it("auto-adds VARCHAR(36) FK column when parent has varchar(36) PK", async () => {
    const { driver, calls } = makeDriver();
    const registrar = new SchemaRegistrar(
      makeM2OResolver([m2oItem(VarcharPkParent, "parent_id")]),
      makeCtx(driver),
    );

    await registrar.registerForeignKeys(VarcharChild, "varchar_child");

    expect(calls.addColumn).toHaveLength(1);
    expect(calls.addColumn[0].col).toBe("parent_id");
    expect(calls.addColumn[0].type).toBe("VARCHAR(36) NULL");
  });

  it("auto-adds BIGINT FK column when parent has BIGINT PK", async () => {
    const { driver, calls } = makeDriver();
    const registrar = new SchemaRegistrar(
      makeM2OResolver([m2oItem(BigintPkParent, "parent_id")]),
      makeCtx(driver),
    );

    await registrar.registerForeignKeys(BigintChild, "bigint_child");

    expect(calls.addColumn).toHaveLength(1);
    expect(calls.addColumn[0].col).toBe("parent_id");
    expect(calls.addColumn[0].type).toBe("BIGINT NULL");
  });

  it("does not auto-add a column when it already exists, regardless of PK type", async () => {
    const { driver, calls } = makeDriver();
    driver.hasColumn = jest.fn(async () => true);
    const registrar = new SchemaRegistrar(
      makeM2OResolver([m2oItem(UuidPkParent, "parent_id")]),
      makeCtx(driver),
    );

    await registrar.registerForeignKeys(UuidChild, "uuid_child");

    expect(calls.addColumn).toHaveLength(0);
  });

  // ──────────────────────────────────────────────
  // O2O owning side coverage (#284)
  // ──────────────────────────────────────────────

  it("auto-adds UUID FK column for O2O owning side when related has UUID PK", async () => {
    const { driver, calls } = makeDriver();
    const registrar = new SchemaRegistrar(
      makeO2OResolver([o2oItem(UuidPkParent, "profile_id")]),
      makeCtx(driver),
    );

    await registrar.registerForeignKeys(O2OChild, "o2o_child");

    expect(calls.addColumn).toHaveLength(1);
    expect(calls.addColumn[0].col).toBe("profile_id");
    expect(calls.addColumn[0].type).toBe("CHAR(36) NULL");
  });

  it("auto-adds INT FK column for O2O owning side when related has INT PK (regression)", async () => {
    const { driver, calls } = makeDriver();
    const registrar = new SchemaRegistrar(
      makeO2OResolver([o2oItem(IntPkParent, "profile_id")]),
      makeCtx(driver),
    );

    await registrar.registerForeignKeys(O2OChild, "o2o_child");

    expect(calls.addColumn).toHaveLength(1);
    expect(calls.addColumn[0].type).toBe("INT NULL");
  });
});

// ──────────────────────────────────────────────
// createForeignKeyConstraints: false — runtime ALTER path
// (SchemaGenerator path is covered in referential-actions.test.ts; this
//  guards the SchemaRegistrar.registerForeignKeys ALTER-based path, where
//  the O2O branch previously ignored the flag.)
// ──────────────────────────────────────────────

describe("SchemaRegistrar.registerForeignKeys — createForeignKeyConstraints: false", () => {
  it("skips the FK constraint and column for a ManyToOne when the flag is false", async () => {
    const { driver, calls } = makeDriver();
    const registrar = new SchemaRegistrar(
      makeM2OResolver([
        m2oItem(IntPkParent, "parent_id", {
          createForeignKeyConstraints: false,
        }),
      ]),
      makeCtx(driver),
    );

    await registrar.registerForeignKeys(IntChild, "int_child");

    expect(calls.addForeignKey).toHaveLength(0);
    expect(calls.addColumn).toHaveLength(0);
  });

  it("skips the FK constraint and column for a OneToOne owning side when the flag is false", async () => {
    const { driver, calls } = makeDriver();
    const registrar = new SchemaRegistrar(
      makeO2OResolver([
        o2oItem(IntPkParent, "profile_id", {
          createForeignKeyConstraints: false,
        }),
      ]),
      makeCtx(driver),
    );

    await registrar.registerForeignKeys(O2OChild, "o2o_child");

    expect(calls.addForeignKey).toHaveLength(0);
    expect(calls.addColumn).toHaveLength(0);
  });

  it("still creates the FK constraint for a OneToOne owning side when the flag is unset", async () => {
    const { driver, calls } = makeDriver();
    const registrar = new SchemaRegistrar(
      makeO2OResolver([o2oItem(IntPkParent, "profile_id")]),
      makeCtx(driver),
    );

    await registrar.registerForeignKeys(O2OChild, "o2o_child");

    expect(calls.addForeignKey).toHaveLength(1);
    expect(calls.addForeignKey[0].col).toBe("profile_id");
  });
});

// ──────────────────────────────────────────────
// Missing joinColumn — the hint must cover both authoring APIs (#436)
// ──────────────────────────────────────────────

describe("SchemaRegistrar.registerForeignKeys — missing joinColumn hint", () => {
  it("suggests the decorator and code-first syntax for a M2O without joinColumn", async () => {
    const { driver } = makeDriver();
    const registrar = new SchemaRegistrar(
      makeM2OResolver([m2oItem(IntPkParent, undefined as any)]),
      makeCtx(driver),
    );

    await expect(
      registrar.registerForeignKeys(IntChild, "int_child"),
    ).rejects.toMatchObject({
      name: "InvalidQueryError",
      suggestion: expect.stringMatching(/@ManyToOne\(.*t\.manyToOne\(/s),
    });
  });
});
