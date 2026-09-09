/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SchemaRegistrar: synchronize for entities pinned via `@Entity({ schema })`.
 *
 * A pinned table lives in its own schema, so its DDL must not run through the
 * connection's default-schema driver: `hasTable("plan")` would look in the
 * wrong schema, `createTable` would create the table there, and a FK from a
 * per-tenant table to the shared one would reference a table that does not
 * exist in the referencing schema. The registrar routes DDL through a
 * `withSchema()` view of the driver, creates the pinned schema on first
 * sight, and records the pin so runtime queries qualify the table.
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

const FULL: SynchronizePolicy = {
  mode: true,
  continueOnError: true,
  failOnDestructiveChange: false,
  logDDL: false,
};

const DRY_RUN: SynchronizePolicy = { ...FULL, mode: "dry-run" };

// ─────────────────────────────────────────────────
// Fixtures — plain classes with hand-written metadata (the scanner
// container is mocked, so the @Entity decorator cannot register here).
// ─────────────────────────────────────────────────

class Plan {}
class Post {}

const pkColumn = {
  name: "id",
  propertyKey: "id",
  options: { primary: true, type: "int" },
};

function defineEntityMeta(target: Function, name: string, schema?: string) {
  const meta = {
    target,
    name,
    columns: [pkColumn],
    ...(schema ? { schema } : {}),
  };
  Reflect.defineMetadata(ENTITY_TOKEN, meta, target);
  Reflect.defineMetadata(COLUMN_TOKEN, [pkColumn], target.prototype);
  return meta;
}

const planMeta = defineEntityMeta(Plan, "plan", "public");
const postMeta = defineEntityMeta(Post, "post");

/** Pinned table that already exists and gained a column: exercises the diff pass. */
class PlanV2 {}
const codeColumn = {
  name: "code",
  propertyKey: "code",
  options: { type: "varchar", length: 50, nullable: true },
};
const planV2Meta = {
  target: PlanV2,
  name: "plan_v2",
  schema: "public",
  columns: [pkColumn, codeColumn],
};
Reflect.defineMetadata(ENTITY_TOKEN, planV2Meta, PlanV2);
Reflect.defineMetadata(COLUMN_TOKEN, [pkColumn, codeColumn], PlanV2.prototype);

/** Pinned ManyToMany pair: the join table follows the owning side. */
class PlanM2M {}
class FeatureM2M {}
const planM2MMeta = defineEntityMeta(PlanM2M, "plan_m2m", "public");
defineEntityMeta(FeatureM2M, "feature_m2m", "public");
Reflect.defineMetadata(
  MANY_TO_MANY_TOKEN,
  [
    {
      target: PlanM2M,
      propertyKey: "features",
      getRelatedEntity: () => FeatureM2M,
      joinTable: {
        name: "plan_feature",
        joinColumn: "plan_id",
        inverseJoinColumn: "feature_id",
      },
    },
  ],
  PlanM2M,
);

/**
 * Driver mock: the base is bound to "app"; `withSchema()` hands out one
 * cached view per schema so the test can see which view ran which DDL.
 */
function makeDriver(
  existingSchemas: string[] = ["app"],
  existingTables: string[] = [],
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

function makeRegistrar(
  driver: any,
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
    // Mirrors TenantScopeManager.resolveEntitySchema: explicit pin, PG only.
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
    resolveEntityMetadata: () => undefined,
    ...resolverOverrides,
  } as unknown as RelationMetadataResolver;

  const registrar = new SchemaRegistrar(resolver, ctx);
  return { registrar, ctx: ctx as any };
}

describe("SchemaRegistrar: entities pinned to a schema", () => {
  beforeEach(() => {
    entityQueue.length = 0;
    entityQueue.push(planMeta, postMeta);
    Logger.reset();
    Logger.setOutput(() => {});
  });

  afterEach(() => {
    Logger.reset();
  });

  it("creates the pinned schema and runs the table's DDL through the schema view", async () => {
    const driver = makeDriver(["app"]);
    const { registrar, ctx } = makeRegistrar(driver);

    await registrar.registerEntities();

    // The pin is recorded before any DDL names the table.
    expect(ctx.pinTableSchema).toHaveBeenCalledWith("plan", "public");
    expect(ctx.pinTableSchema).not.toHaveBeenCalledWith("post", expect.anything());

    // "public" did not exist → created once; the default schema is left alone.
    expect(driver.hasSchema).toHaveBeenCalledWith("public");
    expect(driver.createSchema).toHaveBeenCalledWith("public");
    expect(driver.createSchema).toHaveBeenCalledTimes(1);

    // Pinned table: hasTable / createTable on the "public" view only.
    expect(driver.withSchema).toHaveBeenCalledWith("public");
    const view = driver.views.get("public")!;
    expect(view.hasTable).toHaveBeenCalledWith("plan");
    expect(view.createTable).toHaveBeenCalledWith(
      "plan",
      expect.any(Array),
      undefined,
      expect.any(Array),
    );

    // Unpinned table: the connection's own driver.
    expect(driver.createTable).toHaveBeenCalledWith(
      "post",
      expect.any(Array),
      undefined,
      expect.any(Array),
    );
    expect(driver.createTable).not.toHaveBeenCalledWith(
      "plan",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(driver.hasTable).not.toHaveBeenCalledWith("plan");
  });

  it("does not create the schema again when it already exists", async () => {
    const driver = makeDriver(["app", "public"]);
    const { registrar } = makeRegistrar(driver);

    await registrar.registerEntities();

    expect(driver.hasSchema).toHaveBeenCalledWith("public");
    expect(driver.createSchema).not.toHaveBeenCalled();
    expect(driver.views.get("public")!.createTable).toHaveBeenCalledWith(
      "plan",
      expect.any(Array),
      undefined,
      expect.any(Array),
    );
  });

  it("dry-run pins the table but touches neither the schema nor the tables", async () => {
    const driver = makeDriver(["app"]);
    const { registrar, ctx } = makeRegistrar(driver, DRY_RUN);

    await registrar.registerEntities();

    expect(ctx.pinTableSchema).toHaveBeenCalledWith("plan", "public");
    expect(driver.createSchema).not.toHaveBeenCalled();
    expect(driver.views.get("public")!.createTable).not.toHaveBeenCalled();
    expect(driver.createTable).not.toHaveBeenCalled();
  });

  it("off PostgreSQL nothing is pinned and every table uses the base driver", async () => {
    const driver = makeDriver(["app"]);
    const { registrar, ctx } = makeRegistrar(driver, FULL, {
      isPostgres: () => false,
      isMySqlFamily: () => true,
      getDialect: () => "mysql",
    });

    await registrar.registerEntities();

    expect(ctx.pinTableSchema).not.toHaveBeenCalled();
    expect(driver.withSchema).not.toHaveBeenCalled();
    expect(driver.createTable).toHaveBeenCalledWith(
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

  it("a FK from a per-tenant table to the pinned one names the pinned schema", async () => {
    const driver = makeDriver(["app", "public"]);
    const { registrar } = makeRegistrar(driver, FULL, {}, {
      resolveManyToOneMetadata: (entity: any) =>
        entity === Post
          ? [{ joinColumn: "plan_id", getMappingEntity: () => Plan, option: {} }]
          : [],
    });

    await registrar.registerEntities();

    // The FK is added on "post" (default schema → base driver) and the
    // referenced table is spelled with its own schema.
    expect(driver.addForeignKey).toHaveBeenCalledTimes(1);
    const [table, column, refTable, refColumn, , refSchema] = driver
      .addForeignKey.mock.calls[0] as any[];
    expect([table, column, refTable, refColumn]).toEqual([
      "post",
      "plan_id",
      "plan",
      "id",
    ]);
    expect(refSchema).toBe("public");
    // Nothing FK-related ran on the pinned view.
    expect(driver.views.get("public")!.addForeignKey).not.toHaveBeenCalled();
  });

  it("reuses one view per schema and drops the cache when the driver changes", async () => {
    const driver = makeDriver(["app", "public"]);
    const { registrar } = makeRegistrar(driver);

    await registrar.registerEntities();
    await registrar.registerEntities();
    expect(driver.withSchema).toHaveBeenCalledTimes(1);

    const replacement = makeDriver(["app", "public"]);
    const { registrar: second } = makeRegistrar(replacement);
    await second.registerEntities();
    expect(replacement.withSchema).toHaveBeenCalledTimes(1);
  });

  it("adds a new column of an existing pinned table through the schema view", async () => {
    entityQueue.length = 0;
    entityQueue.push(planV2Meta);

    // "public"."plan_v2" already exists with only the PK column, so the diff
    // pass has to ADD COLUMN "code" — and it must do so in "public".
    const driver = makeDriver(["app", "public"], ["public.plan_v2"]);
    const queryRunner = {
      query: jest.fn(async (q: any) => {
        const sql = String(q?.sql ?? q);
        const values: unknown[] = q?.values ?? [];
        if (/information_schema\.columns/i.test(sql) && values.includes("plan_v2")) {
          // Introspection must target the pinned schema, not the default.
          expect(values).toEqual(["public", "plan_v2"]);
          return [
            {
              column_name: "id",
              data_type: "integer",
              is_nullable: "NO",
              character_maximum_length: null,
              numeric_precision: 32,
              numeric_scale: 0,
            },
          ];
        }
        return [];
      }),
    };
    const { registrar } = makeRegistrar(driver, FULL, {
      getConnection: () => queryRunner,
    });

    await registrar.registerEntities();

    const view = driver.views.get("public")!;
    expect(view.hasTable).toHaveBeenCalledWith("plan_v2");
    expect(view.createTable).not.toHaveBeenCalled();
    expect(view.addColumn).toHaveBeenCalledTimes(1);
    const [table, column, typeDef] = view.addColumn.mock.calls[0] as any[];
    expect([table, column]).toEqual(["plan_v2", "code"]);
    expect(typeDef).toMatch(/(CHARACTER VARYING|VARCHAR)\(50\)/i);
    expect(driver.addColumn).not.toHaveBeenCalled();
  });

  it("pins a ManyToMany join table to the owner's schema and creates it through the view", async () => {
    const driver = makeDriver(["app", "public"]);
    const { registrar, ctx } = makeRegistrar(driver);

    await registrar.registerManyToManyJoinTables([PlanM2M]);

    expect(ctx.pinTableSchema).toHaveBeenCalledWith("plan_feature", "public");

    const view = driver.views.get("public")!;
    expect(view.hasTable).toHaveBeenCalledWith("plan_feature");
    const ddls = view.executeRaw.mock.calls.map(([ddl]: any[]) => ddl as string);
    expect(ddls[0]).toMatch(/^CREATE TABLE IF NOT EXISTS "public"\."plan_feature" \(/);
    expect(ddls[1]).toContain(`ALTER TABLE "public"."plan_feature"`);
    expect(ddls[1]).toContain(`REFERENCES "public"."plan_m2m"("id")`);
    expect(ddls[2]).toContain(`REFERENCES "public"."feature_m2m"("id")`);
    expect(driver.executeRaw).not.toHaveBeenCalled();
    expect(planM2MMeta.schema).toBe("public");
  });
});
