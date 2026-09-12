/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SchemaRegistrar + `@Entity({ schema })` — second round.
 *
 * Covers the registrar paths the first round left out:
 *
 *   - `synchronize: false` (migrations-managed production, `attach()`): the
 *     pins must still be recorded — for the pinned tables *and* for a pinned
 *     owner's ManyToMany join table — without a single DDL statement;
 *   - `"safe"` mode creates the pinned schema and table (both are CREATEs);
 *   - a failing CREATE SCHEMA follows `continueOnError`;
 *   - one CREATE SCHEMA / one driver view per distinct schema;
 *   - a FK from a pinned table back to a default-schema table spells out the
 *     default schema (the reverse of the first-round case);
 *   - TPT: a child inherits the root's schema (or pins its own) and the
 *     child→root FK crosses schemas correctly;
 *   - STI: a child's contradictory schema never overrides the root's pin for
 *     the table they share, whichever is registered first;
 *   - ManyToMany with an unpinned owner and a pinned inverse side.
 */
import "reflect-metadata";
import { Logger } from "../../src/utils/Logger";

const entityQueue: any[] = [];

jest.mock("../../src/scanner/ScannerContainer", () => ({
  getScannerInstance: jest.fn(() => ({
    makeEntities: () => entityQueue[Symbol.iterator](),
    scan: (entity: any) =>
      entityQueue.find((m) => m.target === entity) ?? null,
  })),
}));

import { SchemaRegistrar } from "../../src/core/SchemaRegistrar";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { EntityManagerInternals } from "../../src/core/EntityManagerInternals";
import { SynchronizePolicy } from "../../src/core/DatabaseClientOptions";
import { ENTITY_TOKEN, getEntitySchema } from "../../src/decorators/Entity";
import { COLUMN_TOKEN } from "../../src/decorators/Column";
import { MANY_TO_MANY_TOKEN } from "../../src/decorators/ManyToMany";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";

const FULL: SynchronizePolicy = {
  mode: true,
  continueOnError: true,
  failOnDestructiveChange: false,
  logDDL: false,
};
const OFF: SynchronizePolicy = { ...FULL, mode: false };
const SAFE: SynchronizePolicy = { ...FULL, mode: "safe" };
const STRICT: SynchronizePolicy = { ...FULL, continueOnError: false };

// ─────────────────────────────────────────────────
// Fixtures — hand-written metadata (the scanner container is mocked, so
// the decorators cannot register here).
// ─────────────────────────────────────────────────

const pkColumn = {
  name: "id",
  propertyKey: "id",
  options: { primary: true, type: "int" },
};

function intColumn(name: string) {
  return { name, propertyKey: name, options: { type: "int", nullable: true } };
}

function defineEntityMeta(
  target: Function,
  name: string,
  schema?: string,
  extra: Record<string, unknown> = {},
  columns: any[] = [pkColumn],
) {
  const meta = {
    target,
    name,
    columns,
    ...(schema ? { schema } : {}),
    ...extra,
  };
  Reflect.defineMetadata(ENTITY_TOKEN, meta, target);
  Reflect.defineMetadata(COLUMN_TOKEN, columns, target.prototype);
  return meta;
}

function defineManyToMany(
  owner: Function,
  related: Function,
  joinTable: { name: string; joinColumn: string; inverseJoinColumn: string },
) {
  Reflect.defineMetadata(
    MANY_TO_MANY_TOKEN,
    [
      {
        target: owner,
        propertyKey: "items",
        getRelatedEntity: () => related,
        joinTable,
      },
    ],
    owner,
  );
}

// Shared pair in "public" — the owner's join table follows it.
class Plan {}
class Feature {}
const planMeta = defineEntityMeta(Plan, "plan", "public");
const featureMeta = defineEntityMeta(Feature, "feature", "public");
defineManyToMany(Plan, Feature, {
  name: "plan_feature",
  joinColumn: "plan_id",
  inverseJoinColumn: "feature_id",
});

// Unpinned owner with a pinned inverse side.
class Post {}
class Tag {}
const postMeta = defineEntityMeta(Post, "post");
const tagMeta = defineEntityMeta(Tag, "tag", "public");
defineManyToMany(Post, Tag, {
  name: "post_tag",
  joinColumn: "post_id",
  inverseJoinColumn: "tag_id",
});

// Two entities in one non-default schema, one in another.
class Ledger {}
class Rate {}
class Audit {}
const ledgerMeta = defineEntityMeta(Ledger, "ledger", "billing");
const rateMeta = defineEntityMeta(Rate, "rate", "billing");
const auditMeta = defineEntityMeta(Audit, "audit", "audit");

// TPT: root pinned to "billing"; one child inherits, one pins "archive".
const discriminatorColumn = { name: "dtype", type: "varchar", length: 31 };
class Invoice {}
class CreditInvoice {}
class ArchivedInvoice {}
const invoiceMeta = defineEntityMeta(Invoice, "invoice", "billing", {
  inheritanceStrategy: "JOINED",
  childEntities: [CreditInvoice, ArchivedInvoice],
  discriminatorColumn,
  discriminatorValue: "Invoice",
});
const creditInvoiceMeta = defineEntityMeta(
  CreditInvoice,
  "credit_invoice",
  "billing",
  {
    inheritanceRoot: Invoice,
    inheritanceStrategy: "JOINED",
    discriminatorColumn,
    discriminatorValue: "CreditInvoice",
  },
  [pkColumn, intColumn("credit")],
);
const archivedInvoiceMeta = defineEntityMeta(
  ArchivedInvoice,
  "archived_invoice",
  "archive",
  {
    inheritanceRoot: Invoice,
    inheritanceStrategy: "JOINED",
    discriminatorColumn,
    discriminatorValue: "ArchivedInvoice",
  },
  [pkColumn, intColumn("reason")],
);

// STI: root pinned to "public"; the child's metadata carries a contradictory
// schema for the very same table (something the decorator now normalizes,
// but the registrar must be robust to it regardless).
class Vehicle {}
class Truck {}
const vehicleMeta = defineEntityMeta(Vehicle, "vehicle", "public", {
  inheritanceStrategy: "SINGLE_TABLE",
  childEntities: [Truck],
  discriminatorColumn,
  discriminatorValue: "Vehicle",
});
const truckMeta = defineEntityMeta(
  Truck,
  "vehicle",
  "fleet",
  {
    inheritanceRoot: Vehicle,
    inheritanceStrategy: "SINGLE_TABLE",
    discriminatorColumn,
    discriminatorValue: "Truck",
  },
  [pkColumn, intColumn("axles")],
);

// ─────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────

/**
 * Driver mock: the base is bound to "app"; `withSchema()` hands out one
 * cached view per schema so the test can see which view ran which DDL.
 */
function makeDriver(
  existingSchemas: string[] = ["app"],
  existingTables: string[] = [],
  opts: { failCreateSchema?: string } = {},
) {
  const schemas = new Set(existingSchemas);
  const tables = new Set(existingTables);
  const makeDdl = (schema: string) => ({
    getSchema: () => schema,
    hasTable: jest.fn(async (name: string) =>
      tables.has(`${schema}.${name}`) ? [{ tablename: name }] : [],
    ),
    createTable: jest.fn(async () => []),
    hasColumn: jest.fn(async () => true),
    addColumn: jest.fn(async () => []),
    dropColumn: jest.fn(async () => []),
    executeRaw: jest.fn(async () => []),
    hasForeignKey: jest.fn(async () => false),
    addForeignKey: jest.fn(async () => []),
    getIndexes: jest.fn(async () => []),
    getCapabilities: () => ({ supportsAlterAddForeignKey: true }),
    castType: (type: string) => (type === "int" ? "INTEGER" : type.toUpperCase()),
  });
  const views = new Map<string, ReturnType<typeof makeDdl>>();
  const base = {
    ...makeDdl("app"),
    views,
    hasSchema: jest.fn(async (name?: string) =>
      schemas.has(name ?? "app") ? [{ schema_name: name ?? "app" }] : [],
    ),
    createSchema: jest.fn(async (name?: string) => {
      if (name && name === opts.failCreateSchema) {
        throw new Error(`permission denied for database (schema ${name})`);
      }
      schemas.add(name ?? "app");
      return [];
    }),
    setSearchPath: jest.fn(async () => []),
    withSchema: jest.fn((schema: string) => {
      let view = views.get(schema);
      if (!view) {
        view = makeDdl(schema);
        views.set(schema, view);
      }
      return view;
    }),
  };
  return base;
}

type Driver = ReturnType<typeof makeDriver>;

/** Every DDL-shaped call on the base driver and all of its views. */
function ddlCalls(driver: Driver): string[] {
  const out: string[] = [];
  const collect = (label: string, d: any) => {
    for (const method of [
      "hasTable",
      "createTable",
      "addColumn",
      "dropColumn",
      "executeRaw",
      "addForeignKey",
    ]) {
      for (const call of d[method].mock.calls) {
        out.push(`${label}.${method}(${JSON.stringify(call[0])})`);
      }
    }
  };
  collect("base", driver);
  for (const [schema, view] of driver.views) collect(`view:${schema}`, view);
  for (const method of ["hasSchema", "createSchema"]) {
    for (const call of (driver as any)[method].mock.calls) {
      out.push(`base.${method}(${JSON.stringify(call[0])})`);
    }
  }
  return out;
}

function makeRegistrar(
  driver: Driver,
  policy: SynchronizePolicy = FULL,
  overrides: Partial<Record<string, any>> = {},
  resolverOverrides: Partial<Record<string, any>> = {},
) {
  const isPostgres = overrides.isPostgres ?? (() => true);
  // Pins recorded by the registrar, consulted by wrapTable() the way the
  // real TenantScopeManager does.
  const pins = new Map<string, string>();
  const ctx = {
    wrap: (c: string) => `"${c}"`,
    wrapTable: (t: string) =>
      pins.has(t) ? `"${pins.get(t)}"."${t}"` : `"${t}"`,
    isMySqlFamily: () => false,
    isPostgres,
    isSqlite: () => false,
    getDriver: () => driver,
    getSynchronize: () => policy.mode,
    getSynchronizePolicy: () => policy,
    getDialect: () => "postgres",
    getSchema: () => "app",
    getConnection: () => undefined,
    getEntities: () => [],
    getTenantColumnConfig: () => null,
    resolveEntitySchema: (e: any) => (isPostgres() ? getEntitySchema(e) : undefined),
    pinTableSchema: jest.fn((table: string, schema: string) => {
      pins.set(table, schema);
    }),
    getNameStrategy: (e: any) => e.name.toLowerCase(),
    ...overrides,
  } as unknown as EntityManagerInternals;

  const resolver = {
    resolveManyToOneMetadata: () => [],
    resolveOneToOneMetadata: () => [],
    resolveEntityMetadata: (e: any) => Reflect.getMetadata(ENTITY_TOKEN, e),
    ...resolverOverrides,
  } as unknown as RelationMetadataResolver;

  const registrar = new SchemaRegistrar(resolver, ctx);
  return { registrar, ctx: ctx as any, pins };
}

describe("SchemaRegistrar: pinned schema edge cases", () => {
  beforeEach(() => {
    entityQueue.length = 0;
    Logger.reset();
    Logger.setOutput(() => {});
  });

  afterEach(() => {
    Logger.reset();
  });

  // ── synchronize: false ─────────────────────────────────────────────

  it("synchronize: false still pins the tables and the pinned owner's join table, without any DDL", async () => {
    entityQueue.push(planMeta, featureMeta, postMeta);
    const driver = makeDriver(["app"]);
    const { registrar, ctx, pins } = makeRegistrar(driver, OFF);

    await registrar.registerEntities();

    expect(pins.get("plan")).toBe("public");
    expect(pins.get("feature")).toBe("public");
    // The join table is only *created* by pass 3, which synchronize: false
    // skips — but runtime ManyToMany loading still names it, so the pin must
    // be recorded regardless.
    expect(pins.get("plan_feature")).toBe("public");
    expect(pins.has("post")).toBe(false);
    expect(ctx.pinTableSchema).not.toHaveBeenCalledWith("post", expect.anything());

    expect(ddlCalls(driver)).toEqual([]);
  });

  it("synchronize: false does not pin the join table of an unpinned owner", async () => {
    entityQueue.push(postMeta, tagMeta);
    const driver = makeDriver(["app"]);
    const { registrar, pins } = makeRegistrar(driver, OFF);

    await registrar.registerEntities();

    expect(pins.get("tag")).toBe("public");
    expect(pins.has("post_tag")).toBe(false);
    expect(ddlCalls(driver)).toEqual([]);
  });

  // ── "safe" mode ────────────────────────────────────────────────────

  it("safe mode creates the pinned schema and the pinned table (both are CREATEs)", async () => {
    entityQueue.push(planMeta, postMeta);
    const driver = makeDriver(["app"]);
    const { registrar, pins } = makeRegistrar(driver, SAFE);

    await registrar.registerEntities();

    expect(pins.get("plan")).toBe("public");
    expect(driver.createSchema).toHaveBeenCalledWith("public");
    expect(driver.views.get("public")!.createTable).toHaveBeenCalledWith(
      "plan",
      expect.any(Array),
      undefined,
      expect.any(Array),
    );
    expect(driver.createTable).toHaveBeenCalledWith(
      "post",
      expect.any(Array),
      undefined,
      expect.any(Array),
    );
  });

  // ── CREATE SCHEMA failure ──────────────────────────────────────────

  it("a failing CREATE SCHEMA aborts the boot when continueOnError is false", async () => {
    entityQueue.push(planMeta, postMeta);
    const driver = makeDriver(["app"], [], { failCreateSchema: "public" });
    const { registrar } = makeRegistrar(driver, STRICT);

    await expect(registrar.registerEntities()).rejects.toMatchObject({
      code: OrmErrorCode.SCHEMA_SYNC_FAILED,
    });
    // Nothing else ran after the failure.
    expect(driver.views.get("public")!.createTable).not.toHaveBeenCalled();
    expect(driver.createTable).not.toHaveBeenCalled();
  });

  it("a failing CREATE SCHEMA is logged and the boot continues when continueOnError is true", async () => {
    entityQueue.push(planMeta, postMeta);
    const driver = makeDriver(["app"], [], { failCreateSchema: "public" });
    const { registrar, pins } = makeRegistrar(driver, FULL);

    await expect(registrar.registerEntities()).resolves.toBeUndefined();

    expect(pins.get("plan")).toBe("public");
    // The registrar goes on to the table — on a real server that CREATE
    // would fail too and be reported the same way; here it just shows the
    // schema failure did not stop the run.
    expect(driver.views.get("public")!.createTable).toHaveBeenCalledWith(
      "plan",
      expect.any(Array),
      undefined,
      expect.any(Array),
    );
    expect(driver.createTable).toHaveBeenCalledWith(
      "post",
      expect.any(Array),
      undefined,
      expect.any(Array),
    );
  });

  // ── one schema, one view ───────────────────────────────────────────

  it("creates each missing pinned schema once and hands out one view per schema", async () => {
    entityQueue.push(ledgerMeta, rateMeta, auditMeta, postMeta);
    const driver = makeDriver(["app"]);
    const { registrar, pins } = makeRegistrar(driver);

    await registrar.registerEntities();

    expect(driver.createSchema.mock.calls.map((c: any[]) => c[0])).toEqual(["billing", "audit"]);
    expect(driver.withSchema.mock.calls.map((c: any[]) => c[0])).toEqual(["billing", "audit"]);

    const billing = driver.views.get("billing")!;
    const audit = driver.views.get("audit")!;
    expect(billing.createTable.mock.calls.map((c: any[]) => c[0])).toEqual(["ledger", "rate"]);
    expect(audit.createTable.mock.calls.map((c: any[]) => c[0])).toEqual(["audit"]);
    expect(driver.createTable.mock.calls.map((c: any[]) => c[0])).toEqual(["post"]);

    expect(pins.get("ledger")).toBe("billing");
    expect(pins.get("rate")).toBe("billing");
    expect(pins.get("audit")).toBe("audit");
  });

  // ── FK from a pinned table to the default schema ───────────────────

  it("a FK from a pinned table to a default-schema table spells out the default schema", async () => {
    entityQueue.push(ledgerMeta, postMeta);
    const driver = makeDriver(["app", "billing"]);
    const { registrar } = makeRegistrar(driver, FULL, {}, {
      resolveManyToOneMetadata: (entity: any) =>
        entity === Ledger
          ? [{ joinColumn: "post_id", getMappingEntity: () => Post, option: {} }]
          : [],
    });

    await registrar.registerEntities();

    const billing = driver.views.get("billing")!;
    expect(billing.addForeignKey).toHaveBeenCalledTimes(1);
    const [table, column, refTable, refColumn, , refSchema] = billing
      .addForeignKey.mock.calls[0] as any[];
    expect([table, column, refTable, refColumn, refSchema]).toEqual([
      "ledger",
      "post_id",
      "post",
      "id",
      "app",
    ]);
    expect(driver.addForeignKey).not.toHaveBeenCalled();
  });

  // ── TPT ────────────────────────────────────────────────────────────

  it("TPT: the child table lands in the schema it inherits or pins, and its FK to the root names the root's schema", async () => {
    entityQueue.push(invoiceMeta, creditInvoiceMeta, archivedInvoiceMeta);
    const driver = makeDriver(["app"]);
    const { registrar, pins } = makeRegistrar(driver);

    await registrar.registerEntities();

    expect(pins.get("invoice")).toBe("billing");
    expect(pins.get("credit_invoice")).toBe("billing");
    expect(pins.get("archived_invoice")).toBe("archive");

    const billing = driver.views.get("billing")!;
    const archive = driver.views.get("archive")!;
    expect(billing.createTable.mock.calls.map((c: any[]) => c[0])).toEqual([
      "invoice",
      "credit_invoice",
    ]);
    expect(archive.createTable.mock.calls.map((c: any[]) => c[0])).toEqual(["archived_invoice"]);
    expect(driver.createTable).not.toHaveBeenCalled();

    // Child PK → root PK, through the child's own view, referencing the
    // root's schema explicitly (same schema for one child, another for the
    // other).
    const fkOf = (view: any) =>
      view.addForeignKey.mock.calls.map((c: any[]) => [c[0], c[1], c[2], c[3], c[5]]);
    expect(fkOf(billing)).toEqual([
      ["credit_invoice", "id", "invoice", "id", "billing"],
    ]);
    expect(fkOf(archive)).toEqual([
      ["archived_invoice", "id", "invoice", "id", "billing"],
    ]);
    expect(driver.addForeignKey).not.toHaveBeenCalled();
  });

  // ── STI ────────────────────────────────────────────────────────────

  it.each([
    ["root first", () => [vehicleMeta, truckMeta]],
    ["child first", () => [truckMeta, vehicleMeta]],
  ])(
    "STI: the root's pin wins for the shared table (%s)",
    async (_label, order) => {
      entityQueue.push(...order());
      const driver = makeDriver(["app", "public"]);
      const { registrar, ctx, pins } = makeRegistrar(driver);

      await registrar.registerEntities();

      expect(pins.get("vehicle")).toBe("public");
      expect(ctx.pinTableSchema).not.toHaveBeenCalledWith("vehicle", "fleet");
      expect(driver.withSchema).not.toHaveBeenCalledWith("fleet");

      // One table, created once, through the root's view.
      const publicView = driver.views.get("public")!;
      expect(publicView.createTable.mock.calls.map((c: any[]) => c[0])).toEqual(["vehicle"]);
      expect(driver.createTable).not.toHaveBeenCalled();
    },
  );

  // ── ManyToMany: unpinned owner, pinned inverse side ────────────────

  it("ManyToMany: an unpinned owner's join table stays in the default schema and references the pinned side with its schema", async () => {
    const driver = makeDriver(["app", "public"]);
    const { registrar, pins } = makeRegistrar(driver);

    await registrar.registerManyToManyJoinTables([Post]);

    expect(pins.has("post_tag")).toBe(false);
    expect(pins.get("tag")).toBe("public");

    expect(driver.hasTable).toHaveBeenCalledWith("post_tag");
    const ddls = driver.executeRaw.mock.calls.map(([ddl]: any[]) => ddl as string);
    expect(ddls[0]).toMatch(/^CREATE TABLE IF NOT EXISTS "post_tag" \(/);
    expect(ddls[1]).toContain(`ALTER TABLE "post_tag"`);
    expect(ddls[1]).toContain(`REFERENCES "post"("id")`);
    expect(ddls[2]).toContain(`REFERENCES "public"."tag"("id")`);
    expect(driver.views.size).toBe(0);
  });

  it("ManyToMany: a pinned owner's join table is created through the owner's view even when only pass 3 runs", async () => {
    const driver = makeDriver(["app", "public"]);
    const { registrar, pins } = makeRegistrar(driver);

    await registrar.registerManyToManyJoinTables([Plan]);

    expect(pins.get("plan_feature")).toBe("public");
    const view = driver.views.get("public")!;
    expect(view.hasTable).toHaveBeenCalledWith("plan_feature");
    const ddls = view.executeRaw.mock.calls.map(([ddl]: any[]) => ddl as string);
    expect(ddls[0]).toMatch(/^CREATE TABLE IF NOT EXISTS "public"\."plan_feature" \(/);
    expect(driver.executeRaw).not.toHaveBeenCalled();
  });
});
