/**
 * `em.pipe()` under multi-tenancy (PostgreSQL).
 *
 * The pipeline's batches run on a pooled connection outside the ORM's
 * transaction, so under `search_path` they never see the `SET LOCAL
 * search_path` a `find()` reads under. They must still read the active
 * tenant's schema — the same rows `find()` and `count()` see. Under
 * `tenant_column` they carry the tenant predicate, numbered among the
 * statement's other parameters.
 *
 * Run:
 *   INTEGRATION_TEST=true INTEGRATION_TEST_MYSQL=false PG_HOST=<host> \
 *     npx jest --testPathPattern "raw-pipeline-tenant-postgres"
 *
 * PostgreSQL only: skipped under INTEGRATION_TEST_POSTGRES=false.
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { MetadataContext } from "../../src/metadata/MetadataContext";
import { DatabaseClientOptions } from "../../src/core/DatabaseClientOptions";
import { PostgresDriver } from "../../src/dialects/postgres/PostgresDriver";
import { PostgresTenantMigrationRunner } from "../../src/dialects/postgres/PostgresTenantMigrationRunner";
import { rawPipelinePlugin } from "../../src/core/plugin/raw-pipeline";
import {
  createTestConnection,
  rawQuery,
  TestConnectionResult,
} from "./helpers/test-connection";
import {
  createDynamicEntity,
  DynamicEntityResult,
} from "./helpers/create-test-entity";

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

const STRATEGIES = ["search_path", "schema_qualified"] as const;

async function dropSchema(name: string): Promise<void> {
  try {
    await rawQuery(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
  } catch {
    // ignore
  }
}

async function dropTable(name: string): Promise<void> {
  try {
    await rawQuery(`DROP TABLE IF EXISTS "public"."${name}" CASCADE`);
  } catch {
    // ignore
  }
}

function suffix(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

async function drain(gen: AsyncGenerator<any[]>): Promise<any[]> {
  const rows: any[] = [];
  for await (const batch of gen) rows.push(...batch);
  return rows;
}

for (const strategy of STRATEGIES) {
  integrationDescribe(
    `[Integration][Postgres] em.pipe() reads the tenant's schema (${strategy})`,
    () => {
      const tag = strategy === "search_path" ? "sp" : "sq";
      const tenantA = `test_rps_${tag}_a_${suffix()}`;
      const tenantB = `test_rps_${tag}_b_${suffix()}`;
      let conn: TestConnectionResult;
      let em: EntityManager;
      let pem: any;
      let note: DynamicEntityResult;
      let plan: DynamicEntityResult;

      const names = (rows: any[]) => rows.map((r) => r.label).sort();

      beforeAll(async () => {
        conn = await createTestConnection(
          { ...PG_BASE, synchronize: true, logging: false, tenantStrategy: strategy },
          () => {
            note = createDynamicEntity("rps_note", [
              { name: "id", designType: Number, primary: true },
              { name: "label", designType: String },
            ]);
            plan = createDynamicEntity(
              "rps_plan",
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
        pem = em.extend(rawPipelinePlugin());

        const runner = new PostgresTenantMigrationRunner(em.getDriver() as PostgresDriver);
        await runner.ensureSchema(tenantA);
        await runner.ensureSchema(tenantB);

        await em.save(note.EntityClass, { label: "p1" });
        await em.save(plan.EntityClass, { label: "pro" });
        await MetadataContext.run(tenantA, async () => {
          await em.save(note.EntityClass, { label: "a1" });
          await em.save(note.EntityClass, { label: "a2" });
        });
        await MetadataContext.run(tenantB, async () => {
          await em.save(note.EntityClass, { label: "b1" });
        });
      }, 60000);

      afterAll(async () => {
        await dropSchema(tenantA);
        await dropSchema(tenantB);
        await dropTable(note.tableName);
        await dropTable(plan.tableName);
        await conn.cleanup();
      }, 30000);

      it("reads the active tenant's rows in offset, keyset and binary batches", async () => {
        await MetadataContext.run(tenantA, async () => {
          expect(names(await drain(pem.pipe(note.EntityClass, { batchSize: 1 }).raw()))).toEqual([
            "a1",
            "a2",
          ]);
          expect(
            names(
              await drain(
                pem.pipe(note.EntityClass, { orderBy: { id: "ASC" }, keyset: true, batchSize: 1 }).raw(),
              ),
            ),
          ).toEqual(["a1", "a2"]);
          expect(names(await drain(pem.pipe(note.EntityClass).binary()))).toEqual(["a1", "a2"]);
        });
        await MetadataContext.run(tenantB, async () => {
          expect(names(await pem.pipe(note.EntityClass).collect())).toEqual(["b1"]);
        });
      });

      it("agrees with find() and count()", async () => {
        await MetadataContext.run(tenantA, async () => {
          const found = await em.find(note.EntityClass);
          const piped = await pem.pipe(note.EntityClass).collect();
          expect(names(piped)).toEqual(names(found as any[]));
          expect(await pem.pipe(note.EntityClass).count()).toBe(piped.length);
        });
        expect(names(await pem.pipe(note.EntityClass).collect())).toEqual(["p1"]);
      });

      it("keeps a table pinned to a schema", async () => {
        await MetadataContext.run(tenantA, async () => {
          expect(names(await pem.pipe(plan.EntityClass).collect())).toEqual(["pro"]);
          expect(await pem.pipe(plan.EntityClass).count()).toBe(1);
        });
      });

      if (strategy === "search_path") {
        it("reads the default schema for a tenant id that is not an identifier, as find() does", async () => {
          await MetadataContext.run("12345", async () => {
            const found = await em.find(note.EntityClass);
            const piped = await pem.pipe(note.EntityClass).collect();
            expect(names(piped)).toEqual(["p1"]);
            expect(names(piped)).toEqual(names(found as any[]));
          });
        });
      }
    },
  );
}

integrationDescribe("[Integration][Postgres] em.pipe() under tenant_column", () => {
  let conn: TestConnectionResult;
  let em: EntityManager;
  let pem: any;
  let note: DynamicEntityResult;

  const names = (rows: any[]) => rows.map((r) => r.label).sort();

  beforeAll(async () => {
    conn = await createTestConnection(
      { ...PG_BASE, synchronize: true, logging: false, tenantStrategy: "tenant_column" },
      () => {
        note = createDynamicEntity("rpt_note", [
          { name: "id", designType: Number, primary: true },
          { name: "label", designType: String },
        ]);
        return { entities: [note.EntityClass] };
      },
    );
    em = conn.em;
    pem = em.extend(rawPipelinePlugin());

    await MetadataContext.run("acme", async () => {
      for (const label of ["a1", "a2", "a3"]) await em.save(note.EntityClass, { label });
    });
    await MetadataContext.run("beta", async () => {
      for (const label of ["b1", "b2"]) await em.save(note.EntityClass, { label });
    });
  }, 60000);

  afterAll(async () => {
    await dropTable(note.tableName);
    await conn.cleanup();
  }, 30000);

  it("binds the tenant alongside the where and the keyset cursor", async () => {
    await MetadataContext.run("acme", async () => {
      const where = { label: { in: ["a1", "a3", "b1"] } };
      expect(
        names(
          await drain(
            pem.pipe(note.EntityClass, { where, orderBy: { id: "ASC" }, keyset: true, batchSize: 1 }).raw(),
          ),
        ),
      ).toEqual(["a1", "a3"]);
      expect(
        names(
          await drain(
            pem
              .pipe(note.EntityClass, { where, orderBy: { id: "ASC" }, keyset: true, batchSize: 1 })
              .binary(),
          ),
        ),
      ).toEqual(["a1", "a3"]);
      expect(await pem.pipe(note.EntityClass, { where }).count()).toBe(2);
    });
  });

  it("agrees with find() for each tenant", async () => {
    for (const tenant of ["acme", "beta"]) {
      await MetadataContext.run(tenant, async () => {
        const found = await em.find(note.EntityClass);
        expect(names(await pem.pipe(note.EntityClass).collect())).toEqual(names(found as any[]));
        expect(await pem.pipe(note.EntityClass).count()).toBe((found as any[]).length);
      });
    }
  });
});
