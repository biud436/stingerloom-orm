/**
 * `@Entity({ schema })` 통합 테스트 (PostgreSQL)
 *
 * 스키마 기반 멀티테넌시에서 모든 테넌트가 공유하는 테이블을 한 스키마에 고정하고,
 * 테넌트 컨텍스트 안에서도 그 테이블이 그대로 읽히고 쓰이는지 실제 DB로 검증합니다.
 *
 * 검증 항목:
 * 1. 기본 라우팅 — 고정 테이블은 public에 생성되고 복제되지 않으며, 테넌트 안에서
 *    "public"."t"로 조회/저장된다 (schema_qualified / search_path 양쪽)
 * 2. 관계 — 기본 스키마가 public이 아닌 연결에서 테넌트 테이블이 고정 테이블을
 *    FK로 참조: 교차 스키마 FK가 실제로 생성되고, 테넌트 안에서 eager 로딩·
 *    relations 로딩·SelectQueryBuilder JOIN이 고정 테이블에 닿는다.
 *    `@NonTenantEntity()`는 기본 스키마에 고정되고 복제되지 않는다.
 *    `tables.include`에 적혀 있어도 고정/전역 테이블은 복제되지 않는다.
 * 3. 비-public 고정 스키마 — 없는 스키마가 자동 생성되고, enum 컬럼의 타입은
 *    기본 스키마에 남으며, 두 번째 부팅의 ADD COLUMN이 고정 스키마로 간다.
 * 4. ManyToMany — 고정 소유자의 조인 테이블이 고정 스키마에 만들어지고 복제되지
 *    않으며, 테넌트 안에서 relations 로딩이 조인 테이블에 닿는다.
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
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  OneToMany,
  ManyToMany,
} from "../../src/decorators";
import { NonTenantEntity } from "../../src/decorators/TenantColumn";
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

const STRATEGIES = ["schema_qualified", "search_path"] as const;
type Strategy = (typeof STRATEGIES)[number];

// ─────────────────────────────────────────────────────────────────
// Helpers (raw SQL against the catalog — the ORM never verifies itself)
// ─────────────────────────────────────────────────────────────────

async function dropSchema(name: string): Promise<void> {
  try {
    await rawQuery(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
  } catch {
    // ignore
  }
}

async function dropTable(schema: string, name: string): Promise<void> {
  try {
    await rawQuery(`DROP TABLE IF EXISTS "${schema}"."${name}" CASCADE`);
  } catch {
    // ignore
  }
}

async function dropType(schema: string, name: string): Promise<void> {
  try {
    await rawQuery(`DROP TYPE IF EXISTS "${schema}"."${name}"`);
  } catch {
    // ignore
  }
}

/** Short unique suffix: FK/index names must stay under PG's 63-char limit. */
function suffix(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
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

async function schemaExists(schema: string): Promise<boolean> {
  const rows = await rawQuery(
    `SELECT 1 FROM information_schema.schemata WHERE schema_name = '${schema}'`,
  );
  return rows.length === 1;
}

async function columnNames(schema: string, table: string): Promise<string[]> {
  const rows = await rawQuery(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = '${table}' ORDER BY ordinal_position`,
  );
  return rows.map((r: { column_name: string }) => r.column_name);
}

/** Referenced (schema, table) of every FK declared on `schema.table`. */
async function foreignKeyTargets(
  schema: string,
  table: string,
): Promise<Array<{ column: string; refSchema: string; refTable: string }>> {
  const rows = await rawQuery(
    `SELECT kcu.column_name AS col, ccu.table_schema AS ref_schema, ccu.table_name AS ref_table
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = '${schema}' AND tc.table_name = '${table}'`,
  );
  return rows.map((r: any) => ({
    column: r.col,
    refSchema: r.ref_schema,
    refTable: r.ref_table,
  }));
}

async function enumTypeSchema(typeName: string): Promise<string | null> {
  const rows = await rawQuery(
    `SELECT n.nspname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE t.typname = '${typeName}' AND t.typtype = 'e'`,
  );
  return rows.length === 1 ? rows[0].nspname : null;
}

async function provision(
  em: EntityManager,
  tenant: string,
  options?: ConstructorParameters<typeof PostgresTenantMigrationRunner>[1],
): Promise<void> {
  const runner = new PostgresTenantMigrationRunner(
    em.getDriver() as PostgresDriver,
    options,
  );
  await runner.ensureSchema(tenant);
}

// ─────────────────────────────────────────────────────────────────
// Suite 1: 기본 라우팅
// ─────────────────────────────────────────────────────────────────

function makeBasicEntities() {
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

for (const strategy of STRATEGIES) {
  integrationDescribe(
    `[Integration][Postgres] pinned schema: basic routing (${strategy})`,
    () => {
      const tenant = `test_pin_basic_${strategy === "search_path" ? "sp" : "sq"}_${suffix()}`;
      let conn: TestConnectionResult;
      let em: EntityManager;
      let plan: DynamicEntityResult;
      let sub: DynamicEntityResult;

      beforeAll(async () => {
        conn = await createTestConnection(
          { ...PG_BASE, synchronize: true, logging: false, tenantStrategy: strategy },
          () => {
            const created = makeBasicEntities();
            plan = created.plan;
            sub = created.sub;
            return { entities: [plan.EntityClass, sub.EntityClass] };
          },
        );
        em = conn.em;
        await provision(em, tenant);
      }, 30000);

      afterAll(async () => {
        await dropSchema(tenant);
        await dropTable("public", plan.tableName);
        await dropTable("public", sub.tableName);
        await conn.cleanup();
      }, 15000);

      it("creates the pinned table in public and does not clone it into the tenant", async () => {
        expect(await tableExists("public", plan.tableName)).toBe(true);
        expect(await tableExists(tenant, plan.tableName)).toBe(false);
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

      it("updates and deletes the shared table from inside a tenant context", async () => {
        const saved = (await em.save(plan.EntityClass, { code: "trial" })) as {
          id: number;
        };

        await MetadataContext.run(tenant, async () => {
          await em.update(plan.EntityClass, { id: saved.id }, { code: "trial2" });
          const row = (await em.findOne(plan.EntityClass, {
            where: { id: saved.id },
          })) as { code: string } | null;
          expect(row?.code).toBe("trial2");

          await em.delete(plan.EntityClass, { id: saved.id });
        });

        const rows = await rawQuery(
          `SELECT code FROM "public"."${plan.tableName}" ORDER BY id`,
        );
        expect(rows.map((r: { code: string }) => r.code)).toEqual(["pro", "team"]);
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

      it("count / exists / cursor pagination on the shared table stay in public", async () => {
        await MetadataContext.run(tenant, async () => {
          expect(await em.count(plan.EntityClass)).toBe(2);
          expect(await em.exists(plan.EntityClass, { code: "pro" })).toBe(true);

          const page = await em.findWithCursor(plan.EntityClass, {
            take: 1,
            orderBy: "id",
            direction: "ASC",
          });
          expect(page.data).toHaveLength(1);
          expect(page.hasNextPage).toBe(true);
        });
      });

      it("resolveEntitySchema() reports the pin", () => {
        expect(em.resolveEntitySchema(plan.EntityClass)).toBe("public");
        expect(em.resolveEntitySchema(sub.EntityClass)).toBeUndefined();
      });
    },
  );
}

// ─────────────────────────────────────────────────────────────────
// Suite 2: 관계 — 기본 스키마 ≠ public, 교차 스키마 FK, JOIN, @NonTenantEntity
// ─────────────────────────────────────────────────────────────────

for (const strategy of STRATEGIES) {
  integrationDescribe(
    `[Integration][Postgres] pinned schema: relations across schemas (${strategy})`,
    () => {
      const id = suffix();
      const appSchema = `test_pin_app_${id}`;
      const tenant = `test_pin_rel_${strategy === "search_path" ? "sp" : "sq"}_${id}`;
      const planTable = `pr_plan_${id}`;
      const subTable = `pr_sub_${id}`;
      const countryTable = `pr_country_${id}`;

      let conn: TestConnectionResult;
      let em: EntityManager;
      let Plan: any;
      let Subscription: any;
      let Country: any;

      beforeAll(async () => {
        conn = await createTestConnection(
          {
            ...PG_BASE,
            schema: appSchema,
            synchronize: true,
            logging: false,
            tenantStrategy: strategy,
          },
          () => {
            @Entity({ name: planTable, schema: "public" })
            class PinPlan {
              @PrimaryGeneratedColumn()
              id!: number;

              @Column({ type: "varchar", length: 50 })
              code!: string;

              @OneToMany(() => PinSubscription, { mappedBy: "plan" })
              subscriptions!: any[];
            }

            @Entity({ name: subTable })
            class PinSubscription {
              @PrimaryGeneratedColumn()
              id!: number;

              @Column({ type: "varchar", length: 50 })
              label!: string;

              @Column({ type: "int", nullable: true })
              planFk!: number;

              @ManyToOne(() => PinPlan, (e: any) => e.plan, {
                joinColumn: "planFk",
                eager: true,
              })
              plan!: PinPlan;
            }

            @Entity({ name: countryTable })
            @NonTenantEntity()
            class PinCountry {
              @PrimaryGeneratedColumn()
              id!: number;

              @Column({ type: "varchar", length: 10 })
              code!: string;
            }

            Plan = PinPlan;
            Subscription = PinSubscription;
            Country = PinCountry;
            return { entities: [PinPlan, PinSubscription, PinCountry] };
          },
        );
        em = conn.em;
        // `include` lists every entity on purpose: pinned / global tables
        // must still be left out of the clone.
        await provision(em, tenant, {
          sourceSchema: appSchema,
          tables: { include: [Plan, Subscription, Country] },
        });
      }, 30000);

      afterAll(async () => {
        await dropSchema(tenant);
        await dropSchema(appSchema);
        await dropTable("public", planTable);
        await conn.cleanup();
      }, 15000);

      it("places each table in its schema and clones only the per-tenant one", async () => {
        expect(await tableExists("public", planTable)).toBe(true);
        expect(await tableExists(appSchema, planTable)).toBe(false);
        expect(await tableExists(tenant, planTable)).toBe(false);

        expect(await tableExists(appSchema, subTable)).toBe(true);
        expect(await tableExists(tenant, subTable)).toBe(true);

        // @NonTenantEntity: pinned to the connection's default schema.
        expect(await tableExists(appSchema, countryTable)).toBe(true);
        expect(await tableExists(tenant, countryTable)).toBe(false);
        expect(await tableExists("public", countryTable)).toBe(false);
      });

      it("creates the FK from the default-schema table to the pinned table across schemas", async () => {
        const fks = await foreignKeyTargets(appSchema, subTable);
        expect(fks).toEqual([
          { column: "planFk", refSchema: "public", refTable: planTable },
        ]);
      });

      it("eager-loads the pinned relation from inside a tenant context", async () => {
        const plan = (await em.save(Plan, { code: "pro" })) as unknown as { id: number };

        await MetadataContext.run(tenant, async () => {
          const saved = (await em.save(Subscription, {
            label: "acme-sub",
            planFk: plan.id,
          })) as unknown as { id: number };

          const found = (await em.findOne(Subscription, {
            where: { id: saved.id },
          })) as any;
          expect(found).not.toBeNull();
          expect(found.plan).toBeDefined();
          expect(found.plan.code).toBe("pro");

          const listed = (await em.find(Subscription, {
            relations: ["plan"],
          })) as any[];
          expect(listed).toHaveLength(1);
          expect(listed[0].plan.code).toBe("pro");
        });

        // The subscription row lives in the tenant schema only.
        expect(await countRows(tenant, subTable)).toBe(1);
        expect(await countRows(appSchema, subTable)).toBe(0);
        expect(await countRows("public", planTable)).toBe(1);
      });

      it("SelectQueryBuilder joins the pinned table with its schema inside a tenant context", async () => {
        await MetadataContext.run(tenant, async () => {
          const qb = em
            .createQueryBuilder(Subscription, "s")
            .innerJoin(Plan, "p", (j: any) => j.on("s.planFk", "=", "p.id"));

          const { text } = qb.getSql();
          expect(text).toContain(`"public"."${planTable}"`);
          if (strategy === "schema_qualified") {
            expect(text).toContain(`"${tenant}"."${subTable}"`);
          } else {
            expect(text).not.toContain(`"${tenant}"."${subTable}"`);
          }

          const rows = (await qb.getMany()) as any[];
          expect(rows).toHaveLength(1);
          expect(rows[0].label).toBe("acme-sub");
        });
      });

      it("@NonTenantEntity stays reachable inside a tenant context", async () => {
        await em.save(Country, { code: "KR" });

        await MetadataContext.run(tenant, async () => {
          const rows = (await em.find(Country)) as any[];
          expect(rows).toHaveLength(1);
          expect(rows[0].code).toBe("KR");
          await em.save(Country, { code: "US" });
        });

        expect(await countRows(appSchema, countryTable)).toBe(2);
        expect(em.resolveEntitySchema(Country)).toBe(appSchema);
        expect(em.resolveEntitySchema(Plan)).toBe("public");
        expect(em.resolveEntitySchema(Subscription)).toBeUndefined();
      });
    },
  );
}

// ─────────────────────────────────────────────────────────────────
// Suite 3: 비-public 고정 스키마, enum, 두 번째 부팅의 ADD COLUMN
// ─────────────────────────────────────────────────────────────────

integrationDescribe(
  "[Integration][Postgres] pinned schema: non-default schema, enum types, ALTER",
  () => {
    const id = suffix();
    const auditSchema = `test_pin_audit_${id}`;
    const auditTable = `pa_log_${id}`;
    const enumType = `${auditTable}_status_enum`;
    const tenant = `test_pin_alter_${id}`;

    let conn: TestConnectionResult | undefined;
    let V1: any;
    let V2: any;

    afterAll(async () => {
      if (conn) await conn.cleanup();
      await dropSchema(tenant);
      await dropSchema(auditSchema);
      await dropType("public", enumType);
    }, 15000);

    it("creates the pinned schema and the table; the enum type stays in the default schema", async () => {
      conn = await createTestConnection(
        { ...PG_BASE, synchronize: true, logging: false, tenantStrategy: "schema_qualified" },
        () => {
          @Entity({ name: auditTable, schema: auditSchema })
          class PinAuditV1 {
            @PrimaryGeneratedColumn()
            id!: number;

            @Column({ type: "enum", enumValues: ["open", "closed"] })
            status!: string;

            @Column({ type: "varchar", length: 100 })
            note!: string;
          }
          V1 = PinAuditV1;
          return { entities: [PinAuditV1] };
        },
      );

      expect(await schemaExists(auditSchema)).toBe(true);
      expect(await tableExists(auditSchema, auditTable)).toBe(true);
      expect(await tableExists("public", auditTable)).toBe(false);
      expect(await enumTypeSchema(enumType)).toBe("public");
    }, 30000);

    it("writes and reads the pinned table with its enum column inside a tenant context", async () => {
      await provision(conn!.em, tenant);
      expect(await tableExists(tenant, auditTable)).toBe(false);

      await MetadataContext.run(tenant, async () => {
        await conn!.em.save(V1, { status: "open", note: "first" });
        const rows = (await conn!.em.find(V1)) as any[];
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe("open");
      });

      expect(await countRows(auditSchema, auditTable)).toBe(1);
    }, 30000);

    it("a second boot adds a new column in the pinned schema, not in the default one", async () => {
      await conn!.cleanup();
      conn = undefined;

      conn = await createTestConnection(
        { ...PG_BASE, synchronize: true, logging: false, tenantStrategy: "schema_qualified" },
        () => {
          @Entity({ name: auditTable, schema: auditSchema })
          class PinAuditV2 {
            @PrimaryGeneratedColumn()
            id!: number;

            @Column({ type: "enum", enumValues: ["open", "closed"] })
            status!: string;

            @Column({ type: "varchar", length: 100 })
            note!: string;

            @Column({ type: "varchar", length: 50, nullable: true })
            extra!: string | null;
          }
          V2 = PinAuditV2;
          return { entities: [PinAuditV2] };
        },
      );

      expect(await columnNames(auditSchema, auditTable)).toEqual([
        "id",
        "status",
        "note",
        "extra",
      ]);
      expect(await tableExists("public", auditTable)).toBe(false);

      // The pre-existing row survives the ALTER and hydrates the new column.
      const rows = (await conn.em.find(V2)) as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].note).toBe("first");
      expect(rows[0].extra).toBeNull();
    }, 30000);
  },
);

// ─────────────────────────────────────────────────────────────────
// Suite 4: ManyToMany — 고정 소유자의 조인 테이블
// ─────────────────────────────────────────────────────────────────

integrationDescribe(
  "[Integration][Postgres] pinned schema: ManyToMany join table of a pinned owner",
  () => {
    const id = suffix();
    const tenant = `test_pin_m2m_${id}`;
    const planTable = `pm_plan_${id}`;
    const featureTable = `pm_feat_${id}`;
    const joinTable = `pm_pf_${id}`;

    let conn: TestConnectionResult;
    let em: EntityManager;
    let Plan: any;
    let Feature: any;

    beforeAll(async () => {
      conn = await createTestConnection(
        { ...PG_BASE, synchronize: true, logging: false, tenantStrategy: "schema_qualified" },
        () => {
          @Entity({ name: featureTable, schema: "public" })
          class PinFeature {
            @PrimaryGeneratedColumn()
            id!: number;

            @Column({ type: "varchar", length: 50 })
            name!: string;
          }

          @Entity({ name: planTable, schema: "public" })
          class PinPlanM2M {
            @PrimaryGeneratedColumn()
            id!: number;

            @Column({ type: "varchar", length: 50 })
            code!: string;

            @ManyToMany(() => PinFeature, {
              joinTable: {
                name: joinTable,
                joinColumn: "plan_id",
                inverseJoinColumn: "feature_id",
              },
            })
            features!: any[];
          }

          Plan = PinPlanM2M;
          Feature = PinFeature;
          return { entities: [PinFeature, PinPlanM2M] };
        },
      );
      em = conn.em;
      await provision(em, tenant);
    }, 30000);

    afterAll(async () => {
      await dropSchema(tenant);
      await dropTable("public", joinTable);
      await dropTable("public", planTable);
      await dropTable("public", featureTable);
      await conn.cleanup();
    }, 15000);

    it("creates the join table in the owner's schema with FKs to both pinned tables", async () => {
      expect(await tableExists("public", joinTable)).toBe(true);
      const fks = await foreignKeyTargets("public", joinTable);
      expect(fks).toEqual(
        expect.arrayContaining([
          { column: "plan_id", refSchema: "public", refTable: planTable },
          { column: "feature_id", refSchema: "public", refTable: featureTable },
        ]),
      );
    });

    it("does not clone the join table into the tenant schema", async () => {
      expect(await tableExists(tenant, joinTable)).toBe(false);
      expect(await tableExists(tenant, planTable)).toBe(false);
      expect(await tableExists(tenant, featureTable)).toBe(false);
    });

    it("loads the ManyToMany relation through the pinned join table inside a tenant context", async () => {
      const plan = (await em.save(Plan, { code: "pro" })) as unknown as { id: number };
      const feature = (await em.save(Feature, { name: "sso" })) as unknown as { id: number };
      await rawQuery(
        `INSERT INTO "public"."${joinTable}" ("plan_id", "feature_id") VALUES (${plan.id}, ${feature.id})`,
      );

      await MetadataContext.run(tenant, async () => {
        const rows = (await em.find(Plan, { relations: ["features"] })) as any[];
        expect(rows).toHaveLength(1);
        expect(rows[0].features).toHaveLength(1);
        expect(rows[0].features[0].name).toBe("sso");
      });
    });
  },
);
