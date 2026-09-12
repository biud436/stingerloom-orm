/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * `@Entity({ schema })` — second round of coverage.
 *
 * The first round pinned the main paths (metadata, strategies, synchronize,
 * cross-schema FKs, provisioning). This file covers what fell between them:
 *
 *   - an STI child cannot live in a different schema from the table it shares
 *     with its root, so its own `schema` is ignored (TPT children may pin
 *     their own table elsewhere);
 *   - identifier escaping of the pinned schema itself;
 *   - `migrate:generate`: the column-level DDL (ADD / ALTER / DROP / RENAME,
 *     computed columns, the `down()` DROP TABLE) has to name the pinned schema
 *     the way the CREATE TABLE already does;
 *   - the `withSchema()` driver view resolves every catalog lookup in its
 *     schema and keeps the enum schema when views are chained;
 *   - `syncTenantSchemas()` (not only `ensureSchema()`) leaves shared tables
 *     in the source schema.
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
import { Inheritance } from "../../src/decorators/Inheritance";
import { EntitySchema } from "../../src/schema";
import {
  SearchPathStrategy,
  SchemaQualifiedStrategy,
  TenantColumnStrategy,
} from "../../src/core/TenantQueryStrategy";
import { TenantScopeManager } from "../../src/core/entity-manager/TenantScopeManager";
import { MetadataContext } from "../../src/metadata/MetadataContext";
import {
  SchemaDiff,
  createSchemaDiffResult,
} from "../../src/core/generators/SchemaDiff";
import { SchemaDiffMigrationGenerator } from "../../src/core/generators/SchemaDiffMigrationGenerator";
import { PostgresDriver } from "../../src/dialects/postgres/PostgresDriver";
import { DbVersion } from "../../src/dialects/DbVersion";
import { PostgresTenantMigrationRunner } from "../../src/dialects/postgres/PostgresTenantMigrationRunner";
import { Logger } from "../../src/utils/Logger";

// ─────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────

/** TPT root pinned to "billing"; a child may move its own table elsewhere. */
@Entity({ schema: "billing" })
@Inheritance({ strategy: "JOINED" })
class Invoice {
  @PrimaryGeneratedColumn()
  id!: number;
}

@Entity({ schema: "archive" })
class ArchivedInvoice extends Invoice {
  @Column({ type: "int", nullable: true })
  reason?: number;
}

/** Three levels: the leaf inherits the root's schema through the middle class. */
@Entity({ schema: "hr" })
@Inheritance({ strategy: "JOINED" })
class Person {
  @PrimaryGeneratedColumn()
  id!: number;
}

@Entity()
class Employee extends Person {
  @Column({ type: "int", nullable: true })
  grade?: number;
}

@Entity()
class Manager extends Employee {
  @Column({ type: "int", nullable: true })
  reports?: number;
}

/** An empty schema string is "no pin", not a pin to the empty schema. */
@Entity({ schema: "" })
class Blank {
  @PrimaryGeneratedColumn()
  id!: number;
}

/** Pinned entities for the migrate:generate scenario. */
@Entity({ name: "pin_ledger", schema: "billing" })
class Ledger {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 50 })
  code!: string;

  @Column({ type: "int" })
  amount!: number;

  @Column({ type: "varchar", length: 20, nullable: true })
  note!: string | null;
}

@Entity({ name: "pin_rate", schema: "billing" })
class Rate {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "int" })
  bps!: number;
}

@Entity({ name: "pin_unpinned_ledger" })
class UnpinnedLedger {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 50 })
  code!: string;

  @Column({ type: "varchar", length: 20, nullable: true })
  note!: string | null;
}

/** Shared table for the tenant runner and scope tests. */
@Entity({ name: "pin_edge_plan", schema: "public" })
class Plan {
  @PrimaryGeneratedColumn()
  id!: number;
}

const pgWrap = (s: string) => `"${s.replace(/"/g, '""')}"`;

function captureLogs(): string[] {
  const lines: string[] = [];
  Logger.reset();
  Logger.setOutput((msg: string) => {
    lines.push(msg);
  });
  return lines;
}

function makeScope(opts: { isPostgres?: boolean; schema?: string } = {}) {
  const ctx = {
    isPostgres: () => opts.isPostgres ?? true,
    wrap: pgWrap,
    getSchema: () => opts.schema,
    getLogger: () => ({ warn: jest.fn() }),
  } as any;
  return new TenantScopeManager(ctx);
}

afterEach(() => {
  Logger.reset();
  MetadataContext.reset();
});

// ─────────────────────────────────────────────────
// Metadata
// ─────────────────────────────────────────────────

describe("@Entity({ schema }) and inheritance", () => {
  it("an STI child shares the root's table, so its own schema is ignored with a warning", () => {
    const logs = captureLogs();

    @Entity({ schema: "public" })
    @Inheritance({ strategy: "SINGLE_TABLE" })
    class Vehicle {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    @Entity({ schema: "fleet" })
    class Truck extends Vehicle {
      @Column({ type: "int", nullable: true })
      axles?: number;
    }

    // Same table as the root → same schema as the root, whatever the child said.
    const truckMeta = Reflect.getMetadata(ENTITY_TOKEN, Truck) as EntityMetadata;
    expect(truckMeta.name).toBe("vehicle");
    expect(truckMeta.schema).toBe("public");
    expect(getEntitySchema(Truck)).toBe("public");

    const warning = logs.find((l) => /fleet/.test(l) && /public/.test(l));
    expect(warning).toBeDefined();
    expect(warning).toMatch(/Truck/);
  });

  it("an STI child of an unpinned root stays unpinned even if it names a schema", () => {
    captureLogs();

    @Entity()
    @Inheritance({ strategy: "SINGLE_TABLE" })
    class Device {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    @Entity({ schema: "iot" })
    class Sensor extends Device {
      @Column({ type: "int", nullable: true })
      range?: number;
    }

    expect(getEntitySchema(Device)).toBeUndefined();
    expect(getEntitySchema(Sensor)).toBeUndefined();
  });

  it("an STI child that repeats the root's schema is accepted silently", () => {
    const logs = captureLogs();

    @Entity({ schema: "public" })
    @Inheritance({ strategy: "SINGLE_TABLE" })
    class Shape {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    @Entity({ schema: "public" })
    class Circle extends Shape {
      @Column({ type: "int", nullable: true })
      radius?: number;
    }

    expect(getEntitySchema(Circle)).toBe("public");
    expect(logs).toHaveLength(0);
  });

  it("a TPT child may pin its own table to another schema", () => {
    expect(getEntitySchema(Invoice)).toBe("billing");
    expect(getEntitySchema(ArchivedInvoice)).toBe("archive");
  });

  it("a leaf inherits the root's schema through an intermediate class", () => {
    expect(getEntitySchema(Employee)).toBe("hr");
    expect(getEntitySchema(Manager)).toBe("hr");
  });

  it("an empty schema string is not a pin", () => {
    const meta = Reflect.getMetadata(ENTITY_TOKEN, Blank) as EntityMetadata;
    expect(meta.schema).toBeUndefined();
    expect("schema" in meta).toBe(false);
    expect(getEntitySchema(Blank)).toBeUndefined();
  });

  it("EntitySchema: an STI child follows the root's schema too", () => {
    const logs = captureLogs();

    class EsVehicle {
      id!: number;
    }
    class EsTruck extends EsVehicle {
      axles!: number;
    }

    new EntitySchema<EsVehicle>({
      target: EsVehicle,
      tableName: "es_pin_vehicle",
      schema: "public",
      inheritance: { strategy: "SINGLE_TABLE" },
      columns: { id: { type: "int", primary: true, autoIncrement: true } },
    });
    new EntitySchema<EsTruck>({
      target: EsTruck,
      schema: "fleet",
      columns: { axles: { type: "int", nullable: true } },
    });

    const truckMeta = Reflect.getMetadata(ENTITY_TOKEN, EsTruck) as EntityMetadata;
    expect(truckMeta.name).toBe("es_pin_vehicle");
    expect(getEntitySchema(EsTruck)).toBe("public");
    expect(logs.some((l) => /fleet/.test(l) && /public/.test(l))).toBe(true);
  });

  it("EntitySchema: a TPT child keeps its own schema", () => {
    class EsInvoice {
      id!: number;
    }
    class EsArchivedInvoice extends EsInvoice {
      reason!: number;
    }

    new EntitySchema<EsInvoice>({
      target: EsInvoice,
      tableName: "es_pin_invoice",
      schema: "billing",
      inheritance: { strategy: "JOINED" },
      columns: { id: { type: "int", primary: true, autoIncrement: true } },
    });
    new EntitySchema<EsArchivedInvoice>({
      target: EsArchivedInvoice,
      tableName: "es_pin_archived_invoice",
      schema: "archive",
      columns: { reason: { type: "int", nullable: true } },
    });

    expect(getEntitySchema(EsArchivedInvoice)).toBe("archive");
  });
});

// ─────────────────────────────────────────────────
// Identifier escaping
// ─────────────────────────────────────────────────

describe("qualifyTable() escapes the pinned schema like any identifier", () => {
  it("a double quote in the schema name is doubled, under every strategy", () => {
    const schema = 'we"ird';
    expect(new SearchPathStrategy().qualifyTable("plan", "acme", pgWrap, schema)).toBe(
      `"we""ird"."plan"`,
    );
    expect(
      new SchemaQualifiedStrategy().qualifyTable("plan", "acme", pgWrap, schema),
    ).toBe(`"we""ird"."plan"`);
    expect(new TenantColumnStrategy().qualifyTable("plan", "acme", pgWrap, schema)).toBe(
      `"we""ird"."plan"`,
    );
  });

  it("a double quote in the table name is escaped as well", () => {
    expect(new SearchPathStrategy().qualifyTable('pl"an', "acme", pgWrap, "public")).toBe(
      `"public"."pl""an"`,
    );
  });
});

// ─────────────────────────────────────────────────
// TenantScopeManager
// ─────────────────────────────────────────────────

describe("TenantScopeManager with inheritance and other strategies", () => {
  it("resolveEntitySchema(): a TPT child reports its own pin, the root its own", () => {
    const scope = makeScope();
    expect(scope.resolveEntitySchema(Invoice)).toBe("billing");
    expect(scope.resolveEntitySchema(ArchivedInvoice)).toBe("archive");
    expect(scope.resolveEntitySchema(Manager)).toBe("hr");
  });

  it("tenant_column: a pinned table is qualified inside a tenant context, an unpinned one stays bare", async () => {
    const scope = makeScope();
    scope.strategy = new TenantColumnStrategy();
    scope.pinTableSchema("pin_edge_plan", "public");
    await MetadataContext.run("acme", async () => {
      expect(scope.wrapTable("pin_edge_plan")).toBe(`"public"."pin_edge_plan"`);
      expect(scope.wrapTable("subscription")).toBe(`"subscription"`);
    });
  });

  it("re-pinning a table replaces the earlier schema", () => {
    const scope = makeScope();
    scope.pinTableSchema("t", "one");
    scope.pinTableSchema("t", "two");
    expect(scope.getPinnedSchema("t")).toBe("two");
    expect(scope.wrapTable("t")).toBe(`"two"."t"`);
  });
});

// ─────────────────────────────────────────────────
// migrate:generate
// ─────────────────────────────────────────────────

type DbRow = {
  column_name: string;
  data_type: string;
  is_nullable: "YES" | "NO";
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
};

function row(
  name: string,
  type: string,
  opts: { nullable?: boolean; length?: number | null } = {},
): DbRow {
  return {
    column_name: name,
    data_type: type,
    is_nullable: opts.nullable ? "YES" : "NO",
    character_maximum_length: opts.length ?? null,
    numeric_precision: type === "integer" ? 32 : null,
    numeric_scale: type === "integer" ? 0 : null,
  };
}

/**
 * DB state per (schema, table). The runner asserts that a pinned table is
 * only ever looked up in its own schema.
 */
function makeRunner(state: Record<string, DbRow[]>) {
  const lookups: Array<[string, string]> = [];
  return {
    lookups,
    query: jest.fn(async (q: any) => {
      const sql = String(q?.sql ?? q);
      const values: unknown[] = q?.values ?? [];
      if (/information_schema\.columns/i.test(sql)) {
        const [schema, table] = values as [string, string];
        lookups.push([schema, table]);
        return state[`${schema}.${table}`] ?? [];
      }
      return [];
    }),
  };
}

describe("migrate:generate with pinned entities (PostgreSQL)", () => {
  const generator = new SchemaDiffMigrationGenerator();

  async function diffLedger() {
    const runner = makeRunner({
      "billing.pin_ledger": [
        row("id", "integer"),
        row("code", "character varying", { length: 50 }),
        // Declared int → ALTER COLUMN TYPE
        row("amount", "text"),
        // Not on the entity → DROP COLUMN (integer, so it is not mistaken
        // for a rename of the varchar "note" that is being added)
        row("legacy", "integer"),
      ],
      "app.pin_unpinned_ledger": [
        row("id", "integer"),
        row("code", "character varying", { length: 50 }),
      ],
    });
    const diff = await new SchemaDiff().diff(
      [Ledger, Rate, UnpinnedLedger],
      runner,
      "postgres",
      "app",
    );
    return { diff, runner };
  }

  it("SchemaDiff introspects each pinned table in its schema and tags every change with it", async () => {
    const { diff, runner } = await diffLedger();

    expect(runner.lookups).toEqual(
      expect.arrayContaining([
        ["billing", "pin_ledger"],
        ["billing", "pin_rate"],
        ["app", "pin_unpinned_ledger"],
      ]),
    );

    expect(diff.addTables).toEqual(["pin_rate"]);
    expect(diff.addTableEntityMap?.pin_rate).toBe(Rate);

    const add = diff.addColumns.find((c) => c.tableName === "pin_ledger");
    expect(add).toMatchObject({ columnName: "note", schema: "billing" });
    const alter = diff.alterColumns.find((c) => c.tableName === "pin_ledger");
    expect(alter).toMatchObject({ columnName: "amount", schema: "billing" });
    const drop = diff.dropColumns.find((c) => c.tableName === "pin_ledger");
    expect(drop).toMatchObject({ columnName: "legacy", schema: "billing" });

    // Unpinned: no schema on the change, so the generated DDL stays bare.
    const unpinnedAdd = diff.addColumns.find(
      (c) => c.tableName === "pin_unpinned_ledger",
    );
    expect(unpinnedAdd).toMatchObject({ columnName: "note" });
    expect(unpinnedAdd?.schema).toBeUndefined();
  });

  it("dryRun(): column DDL and the down() DROP TABLE name the pinned schema", async () => {
    const { diff } = await diffLedger();
    const { up, down } = generator.dryRun(diff, "postgres");

    expect(up).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^CREATE TABLE IF NOT EXISTS "billing"\."pin_rate" \(/),
        expect.stringMatching(
          /^ALTER TABLE "billing"\."pin_ledger" ADD COLUMN "note" (CHARACTER VARYING|VARCHAR)\(20\) NULL$/i,
        ),
        // The rendered type keeps the column's declared precision.
        expect.stringMatching(
          /^ALTER TABLE "billing"\."pin_ledger" ALTER COLUMN "amount" TYPE INTEGER/,
        ),
        expect.stringMatching(
          /^ALTER TABLE "pin_unpinned_ledger" ADD COLUMN "note" /,
        ),
      ]),
    );
    expect(up.join("\n")).not.toMatch(/ALTER TABLE "pin_ledger"/);

    expect(down).toEqual(
      expect.arrayContaining([
        `ALTER TABLE "billing"."pin_ledger" DROP COLUMN "note"`,
        `ALTER TABLE "billing"."pin_ledger" ALTER COLUMN "amount" TYPE text`,
        `DROP TABLE IF EXISTS "billing"."pin_rate"`,
        `ALTER TABLE "pin_unpinned_ledger" DROP COLUMN "note"`,
      ]),
    );
    expect(down.join("\n")).not.toMatch(/DROP TABLE IF EXISTS "pin_rate"/);
  });

  it("generate(): the commented-out DROP COLUMN names the pinned schema as well", async () => {
    const { diff } = await diffLedger();
    const source = generator.generate(diff, "postgres");

    expect(source).toContain(
      `ALTER TABLE "billing"."pin_ledger" ADD COLUMN "note"`,
    );
    expect(source).toMatch(
      /\/\/ await query\(`ALTER TABLE "billing"\."pin_ledger" DROP COLUMN "legacy"`\); \/\/ DANGEROUS/,
    );
    expect(source).toContain(`DROP TABLE IF EXISTS "billing"."pin_rate"`);
    expect(source).not.toMatch(/ALTER TABLE "pin_ledger"/);
  });

  it("a rename and a computed column on a pinned table are qualified too", () => {
    const diff = createSchemaDiffResult({
      renamedColumns: [
        {
          tableName: "pin_ledger",
          oldColumnName: "code",
          newColumnName: "sku",
          columnType: "VARCHAR(50)",
          schema: "billing",
        },
      ],
      addComputedColumns: [
        {
          tableName: "pin_ledger",
          schema: "billing",
          column: {
            propertyKey: "double",
            name: "double",
            options: { expression: "amount * 2" },
          },
        },
      ],
    });
    const { up, down } = generator.dryRun(diff, "postgres");

    expect(up).toContain(
      `ALTER TABLE "billing"."pin_ledger" RENAME COLUMN "code" TO "sku"`,
    );
    expect(up.some((s) => s.startsWith(`ALTER TABLE "billing"."pin_ledger" ADD COLUMN "double"`))).toBe(true);
    expect(down).toContain(
      `ALTER TABLE "billing"."pin_ledger" RENAME COLUMN "sku" TO "code"`,
    );
    expect(down).toContain(
      `ALTER TABLE "billing"."pin_ledger" DROP COLUMN "double"`,
    );
  });

  it("a hand-built diff without a schema keeps the bare table name (backward compatible)", () => {
    const diff = createSchemaDiffResult({
      addColumns: [
        { tableName: "pin_ledger", columnName: "note", columnType: "VARCHAR(20)", nullable: true },
      ],
      renamedColumns: [
        { tableName: "pin_ledger", oldColumnName: "code", newColumnName: "sku", columnType: "VARCHAR(50)" },
      ],
    });
    const { up } = generator.dryRun(diff, "postgres");
    expect(up).toEqual([
      `ALTER TABLE "pin_ledger" ADD COLUMN "note" VARCHAR(20) NULL`,
      `ALTER TABLE "pin_ledger" RENAME COLUMN "code" TO "sku"`,
    ]);
  });

  it("MySQL ignores the schema on a change", () => {
    const diff = createSchemaDiffResult({
      addColumns: [
        {
          tableName: "pin_ledger",
          columnName: "note",
          columnType: "VARCHAR(20)",
          nullable: true,
          schema: "billing",
        },
      ],
    });
    const { up } = generator.dryRun(diff, "mysql");
    expect(up).toEqual(["ALTER TABLE `pin_ledger` ADD COLUMN `note` VARCHAR(20) NULL"]);
  });

  it("SchemaDiff on MySQL never tags a change with a schema", async () => {
    const runner = {
      query: jest.fn(async (q: any) => {
        const sql = String(q?.sql ?? q);
        if (/information_schema\.columns/i.test(sql)) {
          return [row("id", "int")];
        }
        return [];
      }),
    };
    const diff = await new SchemaDiff().diff([Ledger], runner, "mysql");
    expect(diff.addColumns.length).toBeGreaterThan(0);
    for (const change of diff.addColumns) {
      expect(change.schema).toBeUndefined();
    }
  });
});

// ─────────────────────────────────────────────────
// PostgresDriver.withSchema() — every catalog lookup follows the view
// ─────────────────────────────────────────────────

describe("PostgresDriver.withSchema() view resolves catalog lookups in its schema", () => {
  function makeDriver(schema: string, rows: any[] = []) {
    const connector = {
      query: jest.fn(async () => rows),
      getVersion: () => DbVersion.UNKNOWN,
    } as any;
    return { connector, driver: new PostgresDriver(connector, "postgres", schema) };
  }

  function lastCall(connector: any): { sql: string; values: unknown[] } {
    const [arg] = connector.query.mock.calls[connector.query.mock.calls.length - 1];
    return typeof arg === "string"
      ? { sql: arg, values: [] }
      : { sql: String(arg.sql ?? arg.text ?? ""), values: arg.values ?? [] };
  }

  it("column DDL is qualified with the view's schema", async () => {
    const { connector, driver } = makeDriver("app");
    const view = driver.withSchema("audit");

    await view.addColumn("audit_log", "note", "TEXT");
    expect(lastCall(connector).sql).toBe(
      `ALTER TABLE "audit"."audit_log" ADD COLUMN "note" TEXT`,
    );

    await view.dropColumn("audit_log", "note");
    expect(lastCall(connector).sql).toBe(
      `ALTER TABLE "audit"."audit_log" DROP COLUMN "note"`,
    );
  });

  it("hasColumn / hasForeignKey / getIndexes / getSchemas look in the view's schema", async () => {
    const { connector, driver } = makeDriver("app");
    const view = driver.withSchema("audit");

    await view.hasColumn("audit_log", "note");
    expect(lastCall(connector).values).toEqual(["audit", "audit_log", "note"]);

    await view.hasForeignKey("audit_log", "fk_audit_log_actor");
    expect(lastCall(connector).values).toEqual(["audit", "audit_log", "fk_audit_log_actor"]);

    await view.getIndexes("audit_log");
    expect(lastCall(connector).values).toEqual(["audit", "audit_log"]);

    await view.getSchemas("audit_log");
    expect(lastCall(connector).values).toContain("audit");
    expect(lastCall(connector).values).not.toContain("app");
  });

  it("dropPrimaryKey finds the constraint in the view's schema and drops it there", async () => {
    const { connector, driver } = makeDriver("app", [{ conname: "audit_log_pkey" }]);
    const view = driver.withSchema("audit");

    await view.dropPrimaryKey("audit_log");
    const [lookup, drop] = connector.query.mock.calls.map(([q]: any[]) => q);
    expect(lookup.values).toEqual(["audit_log", "audit"]);
    expect(drop).toBe(`ALTER TABLE "audit"."audit_log" DROP CONSTRAINT "audit_log_pkey"`);
  });

  it("hasSchema() / createSchema() without an argument use the view's schema", async () => {
    const { connector, driver } = makeDriver("app");
    const view = driver.withSchema("audit");

    await view.hasSchema();
    expect(lastCall(connector).values).toEqual(["audit"]);

    await view.createSchema();
    expect(lastCall(connector).sql).toBe(`CREATE SCHEMA IF NOT EXISTS "audit"`);
  });

  it("chained views keep the connection's enum schema and return themselves for their own schema", async () => {
    const { connector, driver } = makeDriver("app");
    const audit = driver.withSchema("audit");
    expect(audit.withSchema("audit")).toBe(audit);

    const archive = audit.withSchema("archive");
    expect(archive.getSchema()).toBe("archive");

    await archive.createTable("archived", [
      { name: "id", options: { primary: true, type: "int" } },
      {
        name: "status",
        options: { type: "enum", enumValues: ["open", "closed"], enumName: "archived_status" },
      },
    ] as any);
    const ddl = lastCall(connector).sql;
    expect(ddl).toContain(`CREATE TABLE IF NOT EXISTS "archive"."archived"`);
    expect(ddl).toContain(`"app"."archived_status"`);
    expect(ddl).not.toContain(`"audit"."archived_status"`);
    expect(ddl).not.toContain(`"archive"."archived_status"`);
  });

  it("the base driver is unaffected by the views it hands out", async () => {
    const { connector, driver } = makeDriver("app");
    driver.withSchema("audit");
    driver.withSchema("archive");

    await driver.hasTable("plan");
    expect(lastCall(connector).values).toEqual(["app", "plan"]);
    expect(driver.wrapQualified("plan")).toBe(`"app"."plan"`);
  });
});

// ─────────────────────────────────────────────────
// PostgresTenantMigrationRunner
// ─────────────────────────────────────────────────

describe("PostgresTenantMigrationRunner.syncTenantSchemas() leaves shared tables in the source schema", () => {
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
      wrap: pgWrap,
    } as unknown as jest.Mocked<PostgresDriver>;
  }

  it("bulk provisioning skips the pinned table for every new tenant", async () => {
    const driver = createMockDriver(["users", "pin_edge_plan"]);
    const runner = new PostgresTenantMigrationRunner(driver);

    const result = await runner.syncTenantSchemas(["acme", "globex"]);

    expect(result).toEqual({ created: ["acme", "globex"], skipped: [] });
    const cloned = driver.executeRaw.mock.calls.map(([ddl]) => ddl as string);
    expect(cloned).toEqual([
      `CREATE TABLE IF NOT EXISTS "acme"."users" (LIKE "public"."users" INCLUDING ALL)`,
      `CREATE TABLE IF NOT EXISTS "globex"."users" (LIKE "public"."users" INCLUDING ALL)`,
    ]);
    expect(runner.isProvisioned("acme")).toBe(true);
    expect(runner.isProvisioned("globex")).toBe(true);
  });

  it("reports which shared tables it left behind", async () => {
    const logs = captureLogs();
    const driver = createMockDriver(["users", "pin_edge_plan"]);
    const runner = new PostgresTenantMigrationRunner(driver);

    await runner.ensureSchema("initech");

    const line = logs.find((l) => /shared table/.test(l));
    expect(line).toBeDefined();
    expect(line).toContain("pin_edge_plan");
    expect(line).not.toContain("users");
  });

  it("a shared table that is not in the source schema is simply not cloned", async () => {
    // Ledger is pinned to "billing": it never shows up in the "public"
    // listing, so there is nothing to skip and nothing to break.
    const driver = createMockDriver(["users"]);
    const runner = new PostgresTenantMigrationRunner(driver);

    await runner.ensureSchema("umbrella");

    const cloned = driver.executeRaw.mock.calls.map(([ddl]) => ddl as string);
    expect(cloned).toEqual([
      `CREATE TABLE IF NOT EXISTS "umbrella"."users" (LIKE "public"."users" INCLUDING ALL)`,
    ]);
  });
});
