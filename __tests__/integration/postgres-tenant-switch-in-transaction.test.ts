/**
 * Switching tenants inside a transaction (PostgreSQL schema strategies).
 *
 * Every tenant schema lives in the one database, so a transaction can hold
 * work for several of them. Each statement must run in the schema of the
 * tenant active when it is issued — not the one the transaction began
 * under — and the work for all of them commits or rolls back together.
 *
 * Run:
 *   INTEGRATION_TEST=true INTEGRATION_TEST_MYSQL=false PG_HOST=<host> \
 *     npx jest --testPathPattern "postgres-tenant-switch-in-transaction"
 *
 * PostgreSQL only: skipped under INTEGRATION_TEST_POSTGRES=false.
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { MetadataContext } from "../../src/metadata/MetadataContext";
import { DatabaseClientOptions } from "../../src/core/DatabaseClientOptions";
import { PostgresDriver } from "../../src/dialects/postgres/PostgresDriver";
import { PostgresTenantMigrationRunner } from "../../src/dialects/postgres/PostgresTenantMigrationRunner";
import { TransactionPropagation } from "../../src/decorators/Transactional";
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

for (const strategy of STRATEGIES) {
  integrationDescribe(
    `[Integration][Postgres] tenant switch inside a transaction (${strategy})`,
    () => {
      const tag = strategy === "search_path" ? "sp" : "sq";
      const tenantA = `test_tsw_${tag}_a_${suffix()}`;
      const tenantB = `test_tsw_${tag}_b_${suffix()}`;
      let conn: TestConnectionResult;
      let em: EntityManager;
      let note: DynamicEntityResult;

      const inTenant = <T>(tenant: string, fn: () => Promise<T>): Promise<T> =>
        MetadataContext.run(tenant, fn) as Promise<T>;

      /** Labels per schema, read with qualified SQL outside any transaction. */
      async function placement(): Promise<Record<string, string[]>> {
        const out: Record<string, string[]> = {};
        for (const schema of ["public", tenantA, tenantB]) {
          const rows = await rawQuery(
            `SELECT label FROM "${schema}"."${note.tableName}" ORDER BY label`,
          );
          out[schema] = rows.map((r: any) => r.label);
        }
        return out;
      }

      function expected(rows: { public?: string[]; a?: string[]; b?: string[] }) {
        return {
          public: rows.public ?? [],
          [tenantA]: rows.a ?? [],
          [tenantB]: rows.b ?? [],
        };
      }

      beforeAll(async () => {
        conn = await createTestConnection(
          { ...PG_BASE, synchronize: true, logging: false, tenantStrategy: strategy },
          () => {
            note = createDynamicEntity("tsw_note", [
              { name: "id", designType: Number, primary: true },
              { name: "label", designType: String },
            ]);
            return { entities: [note.EntityClass] };
          },
        );
        em = conn.em;

        const runner = new PostgresTenantMigrationRunner(em.getDriver() as PostgresDriver);
        await runner.ensureSchema(tenantA);
        await runner.ensureSchema(tenantB);
      }, 60000);

      beforeEach(async () => {
        for (const schema of ["public", tenantA, tenantB]) {
          await rawQuery(`DELETE FROM "${schema}"."${note.tableName}"`);
        }
      });

      afterAll(async () => {
        await dropSchema(tenantA);
        await dropSchema(tenantB);
        await dropTable(note.tableName);
        await conn.cleanup();
      }, 30000);

      it("writes in the schema of the tenant each save runs under", async () => {
        await inTenant(tenantA, () =>
          em.transaction(async () => {
            await em.save(note.EntityClass, { label: "a1" });
            await inTenant(tenantB, () => em.save(note.EntityClass, { label: "b1" }));
            await em.save(note.EntityClass, { label: "a2" });
          }),
        );

        expect(await placement()).toEqual(expected({ a: ["a1", "a2"], b: ["b1"] }));
      });

      it("writes in the tenant's schema inside a transaction begun outside any tenant", async () => {
        await em.transaction(async () => {
          await inTenant(tenantA, () => em.save(note.EntityClass, { label: "a1" }));
          await em.save(note.EntityClass, { label: "p1" });
        });

        expect(await placement()).toEqual(expected({ public: ["p1"], a: ["a1"] }));
      });

      it("writes public work in the public schema inside a tenant's transaction", async () => {
        await inTenant(tenantA, () =>
          em.transaction(async () => {
            await em.save(note.EntityClass, { label: "a1" });
            await inTenant("public", () => em.save(note.EntityClass, { label: "p1" }));
          }),
        );

        expect(await placement()).toEqual(expected({ public: ["p1"], a: ["a1"] }));
      });

      it("reads the tenant's own rows inside another tenant's transaction", async () => {
        await inTenant(tenantB, () => em.save(note.EntityClass, { label: "b1" }));

        const seen = await inTenant(tenantA, () =>
          em.transaction(async () => {
            await em.save(note.EntityClass, { label: "a1" });
            const rows = await inTenant(tenantB, () => em.find(note.EntityClass));
            return rows.map((r: any) => r.label);
          }),
        );

        expect(seen).toEqual(["b1"]);
      });

      it("rolls back the work for every tenant together", async () => {
        await expect(
          inTenant(tenantA, () =>
            em.transaction(async () => {
              await em.save(note.EntityClass, { label: "a1" });
              await inTenant(tenantB, () => em.save(note.EntityClass, { label: "b1" }));
              throw new Error("boom");
            }),
          ),
        ).rejects.toThrow("boom");

        expect(await placement()).toEqual(expected({}));
      });

      it("writes in the right schema after a NESTED savepoint is rolled back", async () => {
        await inTenant(tenantA, () =>
          em.transaction(async () => {
            await em
              .transaction(
                async () => {
                  await inTenant(tenantB, () => em.save(note.EntityClass, { label: "undone" }));
                  throw new Error("inner");
                },
                { propagation: TransactionPropagation.NESTED },
              )
              .catch(() => undefined);
            await inTenant(tenantB, () => em.save(note.EntityClass, { label: "b1" }));
            await em.save(note.EntityClass, { label: "a1" });
          }),
        );

        expect(await placement()).toEqual(expected({ a: ["a1"], b: ["b1"] }));
      });

      it("writes concurrent saves for different tenants each in its own schema", async () => {
        await em.transaction(async () => {
          await Promise.all([
            inTenant(tenantA, () => em.save(note.EntityClass, { label: "a1" })),
            inTenant(tenantB, () => em.save(note.EntityClass, { label: "b1" })),
            inTenant(tenantA, () => em.save(note.EntityClass, { label: "a2" })),
            inTenant(tenantB, () => em.save(note.EntityClass, { label: "b2" })),
          ]);
        });

        expect(await placement()).toEqual(expected({ a: ["a1", "a2"], b: ["b1", "b2"] }));
      });
    },
  );
}
