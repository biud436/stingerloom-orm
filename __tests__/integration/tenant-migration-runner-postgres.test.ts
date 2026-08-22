/**
 * PostgresTenantMigrationRunner on a real server (V4-T1-2, optional item).
 *
 * The runner — the piece that actually provisions tenant schemas for the
 * multitenancy strategy — was covered only by unit tests whose driver is a
 * hand-written mock replaying canned listSchemas/listTables answers. Nothing
 * proved that the emitted `CREATE TABLE ... (LIKE source INCLUDING ALL)` is
 * accepted by PostgreSQL, that indexes/constraints really come along, that
 * data does NOT, or that discovery reads the right catalog. This suite runs
 * the real provisioning path against PostgreSQL.
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { PostgresDriver } from "../../src/dialects/postgres/PostgresDriver";
import { PostgresTenantMigrationRunner } from "../../src/dialects/postgres/PostgresTenantMigrationRunner";
import {
  createTestConnection,
  dropTestTable,
  rawQuery,
  type TestConnectionResult,
} from "./helpers/test-connection";
import { getPostgresConfig } from "./helpers/driver-config";
import {
  createCrudTestEntity,
  type DynamicEntityResult,
} from "./helpers/create-test-entity";

const shouldRun =
  process.env.INTEGRATION_TEST === "true" &&
  process.env.INTEGRATION_TEST_POSTGRES !== "false";
const describeIf = shouldRun ? describe : describe.skip;

describeIf("[Integration][Postgres] TenantMigrationRunner", () => {
  let conn: TestConnectionResult;
  let em: EntityManager;
  let entity: DynamicEntityResult;
  let runner: PostgresTenantMigrationRunner;
  const stamp = String(Date.now()).slice(-8);
  const tenantA = `tmr_a_${stamp}`;
  const tenantB = `tmr_b_${stamp}`;
  const createdSchemas = [tenantA, tenantB];

  beforeAll(async () => {
    conn = await createTestConnection(
      { ...getPostgresConfig(), synchronize: true, logging: false },
      () => {
        entity = createCrudTestEntity("tmr_src");
        return { entities: [entity.EntityClass] };
      },
    );
    em = conn.em;

    // A row in the source table — structure must be cloned, data must not.
    await em.save(entity.EntityClass, { name: "public-only", age: 1 });

    // The shared test database accumulates tables from other suites, so the
    // include filter pins provisioning to this suite's table (and exercises
    // the tableFilter path against a real catalog at the same time).
    runner = new PostgresTenantMigrationRunner(
      em.getDriver() as PostgresDriver,
      { tables: { include: [entity.tableName] } },
    );
  }, 30000);

  afterAll(async () => {
    for (const schema of createdSchemas) {
      try {
        await rawQuery(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } catch {
        // ignore
      }
    }
    try {
      await dropTestTable(entity.tableName);
    } catch {
      // ignore
    }
    if (conn) await conn.cleanup();
  }, 20000);

  it("ensureSchema provisions the schema with the cloned table, empty", async () => {
    await runner.ensureSchema(tenantA);

    const schemas = await rawQuery(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name = '${tenantA}'`,
    );
    expect(schemas).toHaveLength(1);

    const tables = await rawQuery(
      `SELECT tablename FROM pg_tables WHERE schemaname = '${tenantA}'`,
    );
    expect(tables.map((t: any) => t.tablename)).toEqual([entity.tableName]);

    // Structure only — the source row must not have been copied.
    const rows = await rawQuery(
      `SELECT count(*)::int AS n FROM "${tenantA}"."${entity.tableName}"`,
    );
    expect(rows[0].n).toBe(0);
  }, 30000);

  it("LIKE ... INCLUDING ALL brings the primary key and indexes along", async () => {
    // The PK index of the source table must exist in the tenant clone.
    const idx = await rawQuery(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = '${tenantA}' AND tablename = '${entity.tableName}'`,
    );
    expect(idx.length).toBeGreaterThanOrEqual(1);
    expect(idx.some((r: any) => /UNIQUE INDEX/.test(r.indexdef))).toBe(true);

    // And the clone is genuinely writable with the same shape.
    await rawQuery(
      `INSERT INTO "${tenantA}"."${entity.tableName}" ("name", "age") VALUES ('tenant-row', 7)`,
    );
    const rows = await rawQuery(
      `SELECT "name" FROM "${tenantA}"."${entity.tableName}"`,
    );
    expect(rows.map((r: any) => r.name)).toEqual(["tenant-row"]);
  }, 30000);

  it("ensureSchema is idempotent and marks the tenant provisioned", async () => {
    expect(runner.isProvisioned(tenantA)).toBe(true);
    await runner.ensureSchema(tenantA); // must not throw or re-create
    expect(runner.getProvisionedSchemas()).toContain(tenantA);
  });

  it("concurrent ensureSchema calls share one provisioning run", async () => {
    // reset() drops the in-memory bookkeeping — the schema itself survives,
    // so this re-provisions over an existing schema (CREATE SCHEMA must
    // tolerate it) while five callers race on one lock entry.
    runner.reset();
    await Promise.all(
      Array.from({ length: 5 }, () => runner.ensureSchema(tenantA)),
    );
    expect(runner.isProvisioned(tenantA)).toBe(true);
  }, 30000);

  it("syncTenantSchemas creates missing schemas, skips existing and the source", async () => {
    const result = await runner.syncTenantSchemas([
      tenantA,
      tenantB,
      "public",
    ]);

    expect(result.created).toEqual([tenantB]);
    expect(result.skipped).toEqual(expect.arrayContaining([tenantA, "public"]));

    const tables = await rawQuery(
      `SELECT tablename FROM pg_tables WHERE schemaname = '${tenantB}'`,
    );
    expect(tables.map((t: any) => t.tablename)).toEqual([entity.tableName]);
  }, 30000);

  it("discoverSchemas sees the provisioned schemas in the real catalog", async () => {
    const discovered = await runner.discoverSchemas();
    expect(discovered).toEqual(expect.arrayContaining([tenantA, tenantB]));
  });
});
