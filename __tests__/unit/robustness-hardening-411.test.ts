/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * #411 robustness hardening regression tests.
 *
 * 1. DependencyGraph toposort — no non-null assertions: cycles fall back with
 *    a diagnosable warning, duplicate/self-referencing/foreign inputs cannot
 *    make the sort throw mid-flush.
 * 2. Connection liveness probing — pg/mysql2 undocumented internals are read
 *    through readInternalFlag() with an "assume alive" fallback.
 * 3. User-defined FK names — drivers honor an explicit constraint name and
 *    SchemaRegistrar passes the NamingStrategy-derived name to addForeignKey
 *    (previously only the existence check used it).
 */
import "reflect-metadata";

jest.mock("../../src/scanner/ScannerContainer", () => ({
  getScannerInstance: jest.fn(() => ({
    scan: (entity: any) => mockEntityScans.get(entity),
  })),
}));

import { topologicalSort } from "../../src/core/plugin/buffer/DependencyGraph";
import { MANY_TO_ONE_TOKEN } from "../../src/decorators/ManyToOne";
import { COLUMN_TOKEN } from "../../src/decorators";
import { readInternalFlag } from "../../src/dialects/connection-liveness";
import { PostgresConnection } from "../../src/dialects/postgres/PostgresConnection";
import { MysqlConnection } from "../../src/dialects/mysql/MysqlConnection";
import { MySqlDriver } from "../../src/dialects/mysql/MySqlDriver";
import { PostgresDriver } from "../../src/dialects/postgres/PostgresDriver";
import { SchemaRegistrar } from "../../src/core/SchemaRegistrar";
import { DefaultNamingStrategy } from "../../src/core/generators/NamingStrategy";
import type { NamingStrategy } from "../../src/core/generators/NamingStrategy";
import type { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import type { EntityManagerInternals } from "../../src/core/EntityManagerInternals";

const mockEntityScans = new Map<any, any>();

// ──────────────────────────────────────────────
// 1. DependencyGraph toposort hardening
// ──────────────────────────────────────────────

function defineM2O(child: any, parent: any) {
  const existing: any[] = Reflect.getMetadata(MANY_TO_ONE_TOKEN, child) ?? [];
  Reflect.defineMetadata(
    MANY_TO_ONE_TOKEN,
    [
      ...existing,
      {
        target: child,
        type: parent,
        columnName: "p",
        joinColumn: "pId",
        getMappingEntity: () => parent,
        option: {},
      },
    ],
    child,
  );
}

describe("DependencyGraph toposort hardening (#411)", () => {
  // Logger.warn is an instance field bound at construction, so intercept at
  // the console.log sink it prints through.
  let logSpy: jest.SpyInstance;

  const cycleWarnings = () =>
    logSpy.mock.calls.filter((call) =>
      call.map(String).join(" ").includes("Circular FK dependency"),
    );

  beforeEach(() => {
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("falls back to input order on a cycle and names the entities involved", () => {
    class RingA {}
    class RingB {}
    defineM2O(RingA, RingB);
    defineM2O(RingB, RingA);

    const sorted = topologicalSort([RingA, RingB]);

    expect(sorted).toEqual([RingA, RingB]);
    expect(cycleWarnings()).toHaveLength(1);
    const message = cycleWarnings()[0].map(String).join(" ");
    expect(message).toContain("RingA");
    expect(message).toContain("RingB");
  });

  it("duplicate input entries do not trigger a false cycle warning", () => {
    class DupParent {}
    class DupChild {}
    defineM2O(DupChild, DupParent);

    const sorted = topologicalSort([DupChild, DupParent, DupChild]);

    expect(cycleWarnings()).toHaveLength(0);
    expect(sorted.indexOf(DupParent)).toBeLessThan(sorted.indexOf(DupChild));
  });

  it("ignores a self-referencing relation instead of dying", () => {
    class SelfRef {}
    defineM2O(SelfRef, SelfRef);

    expect(topologicalSort([SelfRef, class Other {}])).toHaveLength(2);
    expect(cycleWarnings()).toHaveLength(0);
  });

  it("ignores a parent outside the sorted set", () => {
    class Outside {}
    class InsideChild {}
    defineM2O(InsideChild, Outside);

    const sorted = topologicalSort([InsideChild, class Peer {}]);
    expect(sorted).toContain(InsideChild);
    expect(sorted).toHaveLength(2);
    expect(cycleWarnings()).toHaveLength(0);
  });

  it("tolerates malformed relation metadata (getMappingEntity returning null)", () => {
    class Broken {}
    Reflect.defineMetadata(
      MANY_TO_ONE_TOKEN,
      [{ getMappingEntity: () => null, option: {} }],
      Broken,
    );

    expect(() => topologicalSort([Broken, class Peer2 {}])).not.toThrow();
  });
});

// ──────────────────────────────────────────────
// 2. Connection liveness probing isolation
// ──────────────────────────────────────────────

describe("connection liveness probing (#411)", () => {
  it("readInternalFlag treats a missing field / non-object as flag-not-set", () => {
    expect(readInternalFlag(null, "_ending")).toBe(false);
    expect(readInternalFlag(undefined, "_ending")).toBe(false);
    expect(readInternalFlag("client", "_ending")).toBe(false);
    expect(readInternalFlag({}, "_ending")).toBe(false);
    expect(readInternalFlag({ _ending: true }, "_ending")).toBe(true);
    expect(readInternalFlag({ _ending: false }, "_ending")).toBe(false);
    // truthy-but-not-boolean internals do not count as the flag
    expect(readInternalFlag({ _ending: 1 }, "_ending")).toBe(false);
  });

  it("PostgresConnection.isAlive: alive on unknown client shape, dead once _ending or released", async () => {
    const alive = new PostgresConnection({ release: jest.fn() } as any);
    expect(alive.isAlive()).toBe(true);

    const ending = new PostgresConnection({ release: jest.fn(), _ending: true } as any);
    expect(ending.isAlive()).toBe(false);

    await alive.release();
    expect(alive.isAlive()).toBe(false);
  });

  it("MysqlConnection.isAlive: alive on unknown client shape, dead once destroyed or released", async () => {
    const alive = new MysqlConnection({ release: jest.fn() } as any);
    expect(alive.isAlive()).toBe(true);

    const destroyed = new MysqlConnection({ release: jest.fn(), destroyed: true } as any);
    expect(destroyed.isAlive()).toBe(false);

    await alive.release();
    expect(alive.isAlive()).toBe(false);
  });
});

// ──────────────────────────────────────────────
// 3. User-defined FK constraint names
// ──────────────────────────────────────────────

function makeConnector() {
  return { query: jest.fn(async () => ({})), getVersion: () => undefined } as any;
}

describe("user-defined FK constraint names (#411)", () => {
  it("MySqlDriver.addForeignKey uses the explicit name, wrapped", async () => {
    const connector = makeConnector();
    const driver = new MySqlDriver(connector);

    await driver.addForeignKey("child", "parent_id", "parent", "id", "fk_custom_name");

    const ddl = connector.query.mock.calls[0][0] as string;
    expect(ddl).toContain("ADD CONSTRAINT `fk_custom_name`");
    expect(ddl).toContain("FOREIGN KEY (`parent_id`) REFERENCES `parent`(`id`)");
  });

  it("MySqlDriver.addForeignKey falls back to the hash-based name when omitted", async () => {
    const connector = makeConnector();
    const driver = new MySqlDriver(connector);

    await driver.addForeignKey("child", "parent_id", "parent", "id");

    const expected = driver.generateForeignKeyName("child", "parent", "parent_id");
    const ddl = connector.query.mock.calls[0][0] as string;
    expect(ddl).toContain(`ADD CONSTRAINT \`${expected}\``);
  });

  it("PostgresDriver.addForeignKey uses the explicit name, wrapped", async () => {
    const connector = makeConnector();
    const driver = new PostgresDriver(connector);

    await driver.addForeignKey("child", "parent_id", "parent", "id", "fk_custom_name");

    const ddl = connector.query.mock.calls[0][0] as string;
    expect(ddl).toContain('ADD CONSTRAINT "fk_custom_name"');
    expect(ddl).toContain('FOREIGN KEY ("parent_id")');
  });

  // ── SchemaRegistrar passes the NamingStrategy name through ──

  class FkParent {}
  class FkChild {}

  beforeAll(() => {
    Reflect.defineMetadata(
      COLUMN_TOKEN,
      [{ name: "id", propertyKey: "id", options: { primary: true, type: "int" } }],
      FkParent.prototype,
    );
    mockEntityScans.set(FkParent, {
      name: "fk_parent",
      columns: [{ name: "id", options: { primary: true, type: "int" } }],
    });
  });

  function makeDriver() {
    return {
      castType: (t: string) => t.toUpperCase(),
      hasColumn: jest.fn(async () => true),
      addColumn: jest.fn(async () => {}),
      hasForeignKey: jest.fn(async () => false),
      addForeignKey: jest.fn(async () => {}),
    } as any;
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
      getNameStrategy: (e: any) => mockEntityScans.get(e)?.name ?? e.name,
    } as unknown as EntityManagerInternals;
  }

  function makeResolver(): RelationMetadataResolver {
    return {
      resolveManyToOneMetadata: () => [
        { joinColumn: "parent_id", getMappingEntity: () => FkParent, option: {} },
      ],
      resolveOneToOneMetadata: () => [],
    } as unknown as RelationMetadataResolver;
  }

  it("registerForeignKeys passes the default NamingStrategy name to addForeignKey", async () => {
    const driver = makeDriver();
    const registrar = new SchemaRegistrar(makeResolver(), makeCtx(driver));

    await registrar.registerForeignKeys(FkChild, "fk_child");

    const expected = new DefaultNamingStrategy().foreignKeyName(
      "fk_child",
      "parent_id",
      "fk_parent",
    );
    expect(driver.hasForeignKey).toHaveBeenCalledWith("fk_child", expected);
    expect(driver.addForeignKey).toHaveBeenCalledWith(
      "fk_child",
      "parent_id",
      "fk_parent",
      "id",
      expected,
    );
  });

  it("registerForeignKeys checks AND creates under a custom NamingStrategy name", async () => {
    const driver = makeDriver();
    const custom: NamingStrategy = {
      ...new DefaultNamingStrategy(),
      foreignKeyName: (table, column, refTable) => `FK_${table}_${column}_${refTable}`,
    } as NamingStrategy;
    const registrar = new SchemaRegistrar(makeResolver(), makeCtx(driver), custom);

    await registrar.registerForeignKeys(FkChild, "fk_child");

    expect(driver.hasForeignKey).toHaveBeenCalledWith(
      "fk_child",
      "FK_fk_child_parent_id_fk_parent",
    );
    expect(driver.addForeignKey).toHaveBeenCalledWith(
      "fk_child",
      "parent_id",
      "fk_parent",
      "id",
      "FK_fk_child_parent_id_fk_parent",
    );
  });
});
