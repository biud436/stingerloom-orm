/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * `@Entity({ schema })` — pinning an entity to a PostgreSQL schema.
 *
 * Schema-based multi-tenancy (`search_path` / `schema_qualified`) redirects
 * every table to the tenant schema, so a table shared by all tenants (plans,
 * countries, the tenants table itself) could not be reached from inside a
 * tenant context: `SET LOCAL search_path TO "acme"` has no public fallback and
 * `schema_qualified` rewrote it to `"acme"."plan"`. A pinned entity is always
 * addressed as `"schema"."table"`, across strategies, DDL and provisioning.
 */
import "reflect-metadata";
import {
  Entity,
  ENTITY_TOKEN,
  EntityMetadata,
  getEntitySchema,
} from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../src/decorators/ManyToOne";
import { Index } from "../../src/decorators/Indexer";
import { NonTenantEntity } from "../../src/decorators/TenantColumn";
import { Inheritance } from "../../src/decorators/Inheritance";
import { defineEntity, t, EntitySchema } from "../../src/schema";
import {
  SearchPathStrategy,
  SchemaQualifiedStrategy,
  TenantColumnStrategy,
  DatabaseStrategy,
} from "../../src/core/TenantQueryStrategy";
import { TenantScopeManager } from "../../src/core/entity-manager/TenantScopeManager";
import { MetadataContext } from "../../src/metadata/MetadataContext";
import { SchemaGenerator } from "../../src/core/generators/SchemaGenerator";
import { SchemaDiff } from "../../src/core/generators/SchemaDiff";
import { PostgresDriver } from "../../src/dialects/postgres/PostgresDriver";
import { DbVersion } from "../../src/dialects/DbVersion";
import { PostgresTenantMigrationRunner } from "../../src/dialects/postgres/PostgresTenantMigrationRunner";

// ─────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────

/** Shared reference table: stays in "public" whatever tenant is active. */
@Entity({ schema: "public" })
class Plan {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index()
  @Column({ type: "varchar", length: 50 })
  code!: string;
}

/** Per-tenant table referencing the shared one. */
@Entity()
class Subscription {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Plan, (e: any) => e.subscriptions, { joinColumn: "plan_id" })
  plan!: Plan;
}

/** Global under every strategy, without naming a schema. */
@Entity()
@NonTenantEntity()
class Country {
  @PrimaryGeneratedColumn()
  id!: number;
}

@Entity({ schema: "public" })
@Inheritance({ strategy: "SINGLE_TABLE" })
class Vehicle {
  @PrimaryGeneratedColumn()
  id!: number;
}

@Entity()
class Car extends Vehicle {
  @Column({ type: "int", nullable: true })
  doors?: number;
}

@Entity({ schema: "fleet" })
class Truck extends Vehicle {
  @Column({ type: "int", nullable: true })
  axles?: number;
}

@Entity({ schema: "billing" })
@Inheritance({ strategy: "JOINED" })
class Invoice {
  @PrimaryGeneratedColumn()
  id!: number;
}

@Entity()
class CreditInvoice extends Invoice {
  @Column({ type: "int", nullable: true })
  credit?: number;
}

const pgWrap = (s: string) => `"${s}"`;

function makeScope(opts: {
  isPostgres?: boolean;
  schema?: string;
  mysql?: boolean;
} = {}) {
  const ctx = {
    isPostgres: () => opts.isPostgres ?? true,
    wrap: (n: string) => (opts.mysql ? `\`${n}\`` : `"${n}"`),
    getSchema: () => opts.schema,
    getLogger: () => ({ warn: jest.fn() }),
  } as any;
  return new TenantScopeManager(ctx);
}

// ─────────────────────────────────────────────────
// Metadata
// ─────────────────────────────────────────────────

describe("@Entity({ schema }) metadata", () => {
  it("stores the schema on the entity metadata and exposes it via getEntitySchema()", () => {
    const meta = Reflect.getMetadata(ENTITY_TOKEN, Plan) as EntityMetadata;
    expect(meta.schema).toBe("public");
    expect(meta.name).toBe("plan");
    expect(getEntitySchema(Plan)).toBe("public");
  });

  it("leaves unpinned entities without a schema", () => {
    const meta = Reflect.getMetadata(ENTITY_TOKEN, Subscription) as EntityMetadata;
    expect(meta.schema).toBeUndefined();
    expect(getEntitySchema(Subscription)).toBeUndefined();
    expect(getEntitySchema(Country)).toBeUndefined();
  });

  it("STI children inherit the root's schema unless they pin their own", () => {
    expect(getEntitySchema(Car)).toBe("public");
    expect(getEntitySchema(Truck)).toBe("fleet");
  });

  it("TPT children inherit the root's schema", () => {
    expect(getEntitySchema(CreditInvoice)).toBe("billing");
  });

  it("defineEntity({ schema }) pins the code-first entity", () => {
    const Region = defineEntity(
      "pin_region",
      {
        id: t.int().primary().generated(),
        code: t.varchar(10),
      },
      { schema: "public" },
    );
    expect(getEntitySchema(Region)).toBe("public");
    const meta = Reflect.getMetadata(ENTITY_TOKEN, Region) as EntityMetadata;
    expect(meta.name).toBe("pin_region");
    expect(meta.options).toEqual({ name: "pin_region", schema: "public" });
  });

  it("EntitySchema({ schema }) pins the decorator-free entity", () => {
    class Currency {
      id!: number;
      code!: string;
    }
    new EntitySchema<Currency>({
      target: Currency,
      tableName: "pin_currency",
      schema: "public",
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        code: { type: "varchar" },
      },
    });
    expect(getEntitySchema(Currency)).toBe("public");
  });
});

// ─────────────────────────────────────────────────
// Query strategies
// ─────────────────────────────────────────────────

describe("TenantQueryStrategy.qualifyTable() with a pinned schema", () => {
  it("search_path: a pinned table is spelled out, an unpinned one stays bare", () => {
    const s = new SearchPathStrategy();
    expect(s.qualifyTable("plan", "acme", pgWrap, "public")).toBe(`"public"."plan"`);
    expect(s.qualifyTable("post", "acme", pgWrap)).toBe(`"post"`);
  });

  it("schema_qualified: the pinned schema replaces the tenant", () => {
    const s = new SchemaQualifiedStrategy();
    expect(s.qualifyTable("plan", "acme", pgWrap, "public")).toBe(`"public"."plan"`);
    expect(s.qualifyTable("post", "acme", pgWrap)).toBe(`"acme"."post"`);
    expect(s.qualifyTable("plan", "public", pgWrap, "public")).toBe(`"public"."plan"`);
  });

  it("tenant_column and database strategies honor the pin too", () => {
    expect(new TenantColumnStrategy().qualifyTable("plan", "acme", pgWrap, "audit")).toBe(
      `"audit"."plan"`,
    );
    expect(new DatabaseStrategy().qualifyTable("plan", "acme", pgWrap, "audit")).toBe(
      `"audit"."plan"`,
    );
    expect(new TenantColumnStrategy().qualifyTable("plan", "acme", pgWrap)).toBe(`"plan"`);
  });
});

// ─────────────────────────────────────────────────
// TenantScopeManager
// ─────────────────────────────────────────────────

describe("TenantScopeManager pinned tables", () => {
  beforeEach(() => {
    MetadataContext.reset();
  });

  it("wrapTable() emits the pinned schema inside a tenant context (search_path)", async () => {
    const scope = makeScope();
    scope.pinTableSchema("plan", "public");
    await MetadataContext.run("acme", async () => {
      expect(scope.wrapTable("plan")).toBe(`"public"."plan"`);
      expect(scope.wrapTable("post")).toBe(`"post"`);
    });
    expect(scope.wrapTable("plan")).toBe(`"public"."plan"`);
  });

  it("wrapTable() emits the pinned schema inside a tenant context (schema_qualified)", async () => {
    const scope = makeScope();
    scope.strategy = new SchemaQualifiedStrategy();
    scope.pinTableSchema("plan", "public");
    await MetadataContext.run("acme", async () => {
      expect(scope.wrapTable("plan")).toBe(`"public"."plan"`);
      expect(scope.wrapTable("post")).toBe(`"acme"."post"`);
    });
  });

  it("ignores pins on dialects without schemas", async () => {
    const scope = makeScope({ isPostgres: false, mysql: true });
    scope.pinTableSchema("plan", "public");
    await MetadataContext.run("acme", async () => {
      expect(scope.wrapTable("plan")).toBe("`plan`");
    });
  });

  it("resolveEntitySchema(): explicit pin wins", () => {
    const scope = makeScope({ schema: "app" });
    expect(scope.resolveEntitySchema(Plan)).toBe("public");
    expect(scope.resolveEntitySchema(Subscription)).toBeUndefined();
  });

  it("resolveEntitySchema(): @NonTenantEntity pins to the default schema under schema strategies", () => {
    const searchPath = makeScope({ schema: "app" });
    expect(searchPath.resolveEntitySchema(Country)).toBe("app");

    const qualified = makeScope();
    qualified.strategy = new SchemaQualifiedStrategy();
    expect(qualified.resolveEntitySchema(Country)).toBe("public");
  });

  it("resolveEntitySchema(): @NonTenantEntity is not pinned under tenant_column / database", () => {
    const column = makeScope({ schema: "app" });
    column.strategy = new TenantColumnStrategy();
    expect(column.resolveEntitySchema(Country)).toBeUndefined();

    const database = makeScope({ schema: "app" });
    database.strategy = new DatabaseStrategy();
    expect(database.resolveEntitySchema(Country)).toBeUndefined();
  });

  it("resolveEntitySchema(): always undefined off PostgreSQL", () => {
    const scope = makeScope({ isPostgres: false, mysql: true, schema: "app" });
    expect(scope.resolveEntitySchema(Plan)).toBeUndefined();
    expect(scope.resolveEntitySchema(Country)).toBeUndefined();
  });

  it("reset() forgets the pins", () => {
    const scope = makeScope();
    scope.pinTableSchema("plan", "public");
    expect(scope.getPinnedSchema("plan")).toBe("public");
    scope.reset();
    expect(scope.getPinnedSchema("plan")).toBeUndefined();
    expect(scope.wrapTable("plan")).toBe(`"plan"`);
  });
});

// ─────────────────────────────────────────────────
// DDL generation
// ─────────────────────────────────────────────────

describe("SchemaGenerator with pinned entities (PostgreSQL)", () => {
  const generator = new SchemaGenerator({ dialect: "postgres", schema: "app" });

  it("CREATE TABLE lands in the pinned schema, others in the generator default", () => {
    expect(generator.generateCreateTableDDL(Plan)).toMatch(
      /^CREATE TABLE IF NOT EXISTS "public"\."plan" \(/,
    );
    expect(generator.generateCreateTableDDL(Subscription)).toMatch(
      /^CREATE TABLE IF NOT EXISTS "app"\."subscription" \(/,
    );
  });

  it("indexes and DROP TABLE follow the pinned schema", () => {
    const [indexDdl] = generator.generateCreateIndexDDL(Plan);
    expect(indexDdl).toContain(`ON "public"."plan" ("code")`);
    expect(generator.generateDropTableDDL(Plan)).toBe(
      `DROP TABLE IF EXISTS "public"."plan"`,
    );
  });

  it("a cross-schema FK references the pinned table with its schema", () => {
    const [fkDdl] = generator.generateForeignKeyDDL(Subscription);
    expect(fkDdl).toContain(`ALTER TABLE "app"."subscription"`);
    expect(fkDdl).toContain(`REFERENCES "public"."plan"("id")`);
  });

  it("STI children render in the inherited schema", () => {
    expect(generator.generateCreateTableDDL(Car)).toMatch(
      /^CREATE TABLE IF NOT EXISTS "public"\."vehicle" \(/,
    );
  });

  it("MySQL ignores the pin", () => {
    const mysql = new SchemaGenerator({ dialect: "mysql" });
    expect(mysql.generateCreateTableDDL(Plan)).toMatch(
      /^CREATE TABLE IF NOT EXISTS `plan` \(/,
    );
  });
});

describe("SchemaDiff introspects a pinned entity in its own schema", () => {
  it("queries information_schema with the pinned schema, not the default", async () => {
    const captured: any[] = [];
    const runner = {
      query: jest.fn(async (q: any) => {
        captured.push(q);
        return [];
      }),
    };
    const diff = await new SchemaDiff().diff(
      [Plan, Subscription],
      runner,
      "postgres",
      "app",
    );
    expect(diff.addTables).toEqual(expect.arrayContaining(["plan", "subscription"]));

    const columnQueries = captured.filter(
      (q) => Array.isArray(q?.values) && /information_schema\.columns/i.test(q.sql ?? ""),
    );
    const forPlan = columnQueries.find((q) => q.values.includes("plan"));
    const forSubscription = columnQueries.find((q) =>
      q.values.includes("subscription"),
    );
    expect(forPlan?.values).toEqual(["public", "plan"]);
    expect(forSubscription?.values).toEqual(["app", "subscription"]);
  });
});

// ─────────────────────────────────────────────────
// PostgresDriver
// ─────────────────────────────────────────────────

describe("PostgresDriver.withSchema()", () => {
  function makeDriver(schema: string) {
    const connector = {
      query: jest.fn(async () => []),
      getVersion: () => DbVersion.UNKNOWN,
    } as any;
    return { connector, driver: new PostgresDriver(connector, "postgres", schema) };
  }

  it("returns a view bound to the other schema and itself for its own", () => {
    const { driver } = makeDriver("app");
    expect(driver.withSchema("app")).toBe(driver);
    const view = driver.withSchema("public");
    expect(view).not.toBe(driver);
    expect(view.getSchema()).toBe("public");
    expect(view.wrapQualified("plan")).toBe(`"public"."plan"`);
    expect(driver.wrapQualified("plan")).toBe(`"app"."plan"`);
  });

  it("the view runs DDL against its schema through the shared connector", async () => {
    const { connector, driver } = makeDriver("app");
    const view = driver.withSchema("public");
    await view.hasTable("plan");
    const [[hasTableSql]] = connector.query.mock.calls as any[];
    expect(hasTableSql.values).toEqual(["public", "plan"]);
  });

  it("addForeignKey() spells out the referenced table's schema when given", async () => {
    const { connector, driver } = makeDriver("app");
    await driver.addForeignKey("subscription", "plan_id", "plan", "id", "fk_sub_plan", "public");
    const ddl = connector.query.mock.calls[0][0] as string;
    expect(ddl).toContain(`ALTER TABLE "app"."subscription"`);
    expect(ddl).toContain(`REFERENCES "public"."plan"("id")`);

    connector.query.mockClear();
    await driver.addForeignKey("subscription", "plan_id", "plan", "id", "fk_sub_plan");
    expect(connector.query.mock.calls[0][0]).toContain(`REFERENCES "app"."plan"("id")`);
  });

  it("the view keeps enum types in the connection's default schema", async () => {
    const { connector, driver } = makeDriver("app");
    const view = driver.withSchema("audit");
    await view.createTable("audit_log", [
      { name: "id", options: { primary: true, type: "int" } },
      {
        name: "status",
        options: { type: "enum", enumValues: ["open", "closed"], enumName: "status_enum" },
      },
    ] as any);
    const ddl = String((connector.query.mock.calls[0][0] as any).sql);
    expect(ddl).toContain(`CREATE TABLE IF NOT EXISTS "audit"."audit_log"`);
    expect(ddl).toContain(`"app"."status_enum"`);
  });
});

// ─────────────────────────────────────────────────
// Tenant provisioning
// ─────────────────────────────────────────────────

describe("PostgresTenantMigrationRunner leaves shared tables in the source schema", () => {
  function createMockDriver(tables: string[]) {
    const existingSchemas = new Set(["public"]);
    return {
      listSchemas: jest.fn(async () =>
        Array.from(existingSchemas).map((s) => ({ schema_name: s })),
      ),
      listTables: jest.fn(async () => tables.map((t) => ({ tablename: t }))),
      createSchema: jest.fn(async (name: string) => {
        existingSchemas.add(name);
        return [];
      }),
      executeRaw: jest.fn(async () => []),
      wrap: (name: string) => `"${name.replace(/"/g, '""')}"`,
    } as unknown as jest.Mocked<PostgresDriver>;
  }

  it("clones per-tenant tables only: pinned and @NonTenantEntity tables are skipped", async () => {
    const driver = createMockDriver(["users", "plan", "country", "subscription"]);
    const runner = new PostgresTenantMigrationRunner(driver);

    await runner.ensureSchema("acme");

    const cloned = driver.executeRaw.mock.calls.map(([ddl]) => ddl as string);
    expect(cloned).toHaveLength(2);
    expect(cloned[0]).toContain(`"acme"."users" (LIKE "public"."users" INCLUDING ALL)`);
    expect(cloned[1]).toContain(`"acme"."subscription"`);
    expect(cloned.join("\n")).not.toContain(`"plan"`);
    expect(cloned.join("\n")).not.toContain(`"country"`);
  });

  it("an explicit include list cannot pull a pinned table into the tenant", async () => {
    const driver = createMockDriver(["users", "plan"]);
    const runner = new PostgresTenantMigrationRunner(driver, {
      tables: { include: [Plan, "users"] },
    });

    await runner.ensureSchema("globex");

    const cloned = driver.executeRaw.mock.calls.map(([ddl]) => ddl as string);
    expect(cloned).toHaveLength(1);
    expect(cloned[0]).toContain(`"globex"."users"`);
  });
});
