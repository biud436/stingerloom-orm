/**
 * `@Entity({ schema })` 통합 테스트 (PostgreSQL)
 *
 * 스키마 기반 멀티테넌시에서 모든 테넌트가 공유하는 테이블을 public에 고정하고,
 * 테넌트 컨텍스트 안에서도 그 테이블이 그대로 읽히고 쓰이는지 실제 DB로 검증합니다.
 *
 * 검증 항목:
 * 1. 고정 테이블은 public에 생성되고, 테넌트 프로비저닝 시 복제되지 않는다
 * 2. schema_qualified: 테넌트 컨텍스트 안에서 고정 테이블은 "public"."t"로 조회/저장된다
 * 3. search_path: SET LOCAL search_path TO tenant 이후에도 고정 테이블에 닿는다
 * 4. 고정되지 않은 테이블은 여전히 테넌트 스키마로 라우팅된다
 *
 * 실행 방법:
 *   INTEGRATION_TEST=true INTEGRATION_TEST_MYSQL=false PG_HOST=<host> \
 *     npx jest --testPathPattern "multi-tenancy-pinned-schema-postgres"
 *
 * PostgreSQL 전용: INTEGRATION_TEST_POSTGRES=false (MySQL 전용 실행)에서는 skip 됩니다.
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { MetadataContext } from "../../src/metadata/MetadataContext";
import { DatabaseClientOptions } from "../../src/core/DatabaseClientOptions";
import { PostgresDriver } from "../../src/dialects/postgres/PostgresDriver";
import { PostgresTenantMigrationRunner } from "../../src/dialects/postgres/PostgresTenantMigrationRunner";
import {
  createTestConnection,
  rawQuery,
  TestConnectionResult,
} from "./helpers/test-connection";
import {
  createDynamicEntity,
  DynamicEntityResult,
} from "./helpers/create-test-entity";

// PostgreSQL only: the MySQL-only CI job sets INTEGRATION_TEST_POSTGRES=false
// (see helpers/driver-config.ts), and there is no PostgreSQL to reach there.
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

async function dropSchema(name: string): Promise<void> {
  try {
    await rawQuery(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
  } catch {
    // ignore
  }
}

async function dropPublicTable(name: string): Promise<void> {
  try {
    await rawQuery(`DROP TABLE IF EXISTS "public"."${name}" CASCADE`);
  } catch {
    // ignore
  }
}

function uniqueSchemaName(base: string): string {
  return `${base}_${Date.now()}`;
}

async function countRows(schema: string, table: string): Promise<number> {
  const rows = await rawQuery(
    `SELECT count(*)::int AS c FROM "${schema}"."${table}"`,
  );
  return rows[0].c;
}

async function tableExists(schema: string, table: string): Promise<boolean> {
  const rows = await rawQuery(
    `SELECT 1 FROM pg_tables WHERE schemaname = '${schema}' AND tablename = '${table}'`,
  );
  return rows.length === 1;
}

function makeEntities() {
  const plan = createDynamicEntity(
    "pin_plan",
    [
      { name: "id", designType: Number, primary: true },
      { name: "code", designType: String },
    ],
    { schema: "public" },
  );
  const sub = createDynamicEntity("pin_sub", [
    { name: "id", designType: Number, primary: true },
    { name: "label", designType: String },
  ]);
  return { plan, sub };
}

for (const strategy of ["schema_qualified", "search_path"] as const) {
  integrationDescribe(
    `[Integration][Postgres] @Entity({ schema }) shared table under ${strategy}`,
    () => {
      const tenant = uniqueSchemaName(`test_pin_${strategy === "search_path" ? "sp" : "sq"}`);
      let conn: TestConnectionResult;
      let em: EntityManager;
      let plan: DynamicEntityResult;
      let sub: DynamicEntityResult;

      beforeAll(async () => {
        conn = await createTestConnection(
          {
            ...PG_BASE,
            synchronize: true,
            logging: false,
            tenantStrategy: strategy,
          },
          () => {
            const created = makeEntities();
            plan = created.plan;
            sub = created.sub;
            return { entities: [plan.EntityClass, sub.EntityClass] };
          },
        );
        em = conn.em;

        const runner = new PostgresTenantMigrationRunner(
          em.getDriver() as PostgresDriver,
        );
        await runner.ensureSchema(tenant);
      }, 30000);

      afterAll(async () => {
        await dropSchema(tenant);
        await dropPublicTable(plan.tableName);
        await dropPublicTable(sub.tableName);
        await conn.cleanup();
      }, 15000);

      it("creates the pinned table in public and does not clone it into the tenant", async () => {
        expect(await tableExists("public", plan.tableName)).toBe(true);
        expect(await tableExists(tenant, plan.tableName)).toBe(false);
        // The per-tenant table is cloned as usual.
        expect(await tableExists(tenant, sub.tableName)).toBe(true);
      });

      it("reads and writes the shared table from inside a tenant context", async () => {
        await em.save(plan.EntityClass, { code: "pro" });

        await MetadataContext.run(tenant, async () => {
          const before = await em.find(plan.EntityClass);
          expect(before).toHaveLength(1);
          expect((before[0] as { code: string }).code).toBe("pro");

          await em.save(plan.EntityClass, { code: "team" });
          const after = await em.find(plan.EntityClass);
          expect(after).toHaveLength(2);
        });

        expect(await countRows("public", plan.tableName)).toBe(2);
      });

      it("keeps routing unpinned tables to the tenant schema", async () => {
        await MetadataContext.run(tenant, async () => {
          await em.save(sub.EntityClass, { label: "tenant-only" });
          const rows = await em.find(sub.EntityClass);
          expect(rows).toHaveLength(1);
        });

        expect(await countRows(tenant, sub.tableName)).toBe(1);
        expect(await countRows("public", sub.tableName)).toBe(0);
      });

      it("resolveEntitySchema() reports the pin", () => {
        expect(em.resolveEntitySchema(plan.EntityClass)).toBe("public");
        expect(em.resolveEntitySchema(sub.EntityClass)).toBeUndefined();
      });
    },
  );
}
