/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * WriteBuffer identity map under the schema tenant strategies (PostgreSQL).
 *
 * Under `search_path` and `schema_qualified` one EntityManager, and so one
 * buffer, serves every tenant while each tenant reads its own schema. The
 * identity key named only the class and the primary key, so a
 * `buf.findOne(Note, { where: { id: 1 } })` under tenant B returned the
 * instance cached for tenant A's row 1 without going to the database. The
 * key now names the tenant there, as it already did under `tenant_column`.
 *
 * Run:
 *   INTEGRATION_TEST=true INTEGRATION_TEST_MYSQL=false PG_HOST=<host> \
 *     npx jest --testPathPattern "buffer-identity-map-schema-tenants-postgres"
 */

import "reflect-metadata";
import { MetadataContext } from "../../src/metadata/MetadataContext";
import { DatabaseClientOptions } from "../../src/core/DatabaseClientOptions";
import { PostgresDriver } from "../../src/dialects/postgres/PostgresDriver";
import { PostgresTenantMigrationRunner } from "../../src/dialects/postgres/PostgresTenantMigrationRunner";
import { bufferPlugin } from "../../src/core/plugin/buffer/bufferPlugin";
import { createTestConnection, rawQuery, TestConnectionResult } from "./helpers/test-connection";
import { createDynamicEntity, DynamicEntityResult } from "./helpers/create-test-entity";

const INTEGRATION =
  process.env.INTEGRATION_TEST === "true" &&
  process.env.INTEGRATION_TEST_POSTGRES !== "false";
const integrationDescribe = INTEGRATION ? describe : describe.skip;

const PG_BASE: Partial<DatabaseClientOptions> = {
  type: "postgres",
  host: process.env.PG_HOST || "localhost",
  port: parseInt(process.env.PG_PORT || "5432", 10),
  username: process.env.PG_USER || "postgres",
  password: process.env.PG_PASSWORD || "postgres",
  database: process.env.PG_DATABASE || "multi_tenancy_db",
};

function suffix(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

for (const strategy of ["search_path", "schema_qualified"] as const) {
  integrationDescribe(
    `[Integration][Postgres] buffer identity map keeps tenants apart (${strategy})`,
    () => {
      const tag = strategy === "search_path" ? "sp" : "sq";
      const tenantA = `test_bim_${tag}_a_${suffix()}`;
      const tenantB = `test_bim_${tag}_b_${suffix()}`;
      let conn: TestConnectionResult;
      let em: any;
      let note: DynamicEntityResult;
      let plan: DynamicEntityResult;

      beforeAll(async () => {
        conn = await createTestConnection(
          { ...PG_BASE, synchronize: true, logging: false, tenantStrategy: strategy, plugins: [bufferPlugin()] },
          () => {
            note = createDynamicEntity("bim_note", [
              { name: "id", designType: Number, primary: true },
              { name: "label", designType: String },
            ]);
            plan = createDynamicEntity(
              "bim_plan",
              [
                { name: "id", designType: Number, primary: true },
                { name: "label", designType: String },
              ],
              { schema: "public" },
            );
            return { entities: [note.EntityClass, plan.EntityClass] };
          },
        );
        em = conn.em;
        const runner = new PostgresTenantMigrationRunner(em.getDriver() as PostgresDriver);
        await runner.ensureSchema(tenantA);
        await runner.ensureSchema(tenantB);
        // The same primary key in both tenant schemas, and in the shared table.
        for (const [schema, label] of [[tenantA, "a-row"], [tenantB, "b-row"]]) {
          await rawQuery(`INSERT INTO "${schema}"."${note.tableName}" (id, label) VALUES (1, '${label}')`);
        }
        await rawQuery(`INSERT INTO "public"."${plan.tableName}" (id, label) VALUES (1, 'shared')`);
      }, 60000);

      afterAll(async () => {
        for (const schema of [tenantA, tenantB]) {
          await rawQuery(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
        }
        for (const table of [note.tableName, plan.tableName]) {
          await rawQuery(`DROP TABLE IF EXISTS "public"."${table}" CASCADE`).catch(() => undefined);
        }
        await conn.cleanup();
      }, 30000);

      it("reads each tenant's own row through one buffer", async () => {
        const buf = em.buffer();

        const a = await MetadataContext.run(tenantA, () => buf.findOne(note.EntityClass, { where: { id: 1 } }));
        const b = await MetadataContext.run(tenantB, () => buf.findOne(note.EntityClass, { where: { id: 1 } }));
        const aAgain = await MetadataContext.run(tenantA, () => buf.findOne(note.EntityClass, { where: { id: 1 } }));

        expect(a.label).toBe("a-row");
        expect(b.label).toBe("b-row");
        expect(b).not.toBe(a);
        expect(aAgain).toBe(a);
      });

      it("shares a pinned table's instance across tenants", async () => {
        const buf = em.buffer();

        const a = await MetadataContext.run(tenantA, () => buf.findOne(plan.EntityClass, { where: { id: 1 } }));
        const b = await MetadataContext.run(tenantB, () => buf.findOne(plan.EntityClass, { where: { id: 1 } }));

        expect(a.label).toBe("shared");
        expect(b).toBe(a);
      });
    },
  );
}
