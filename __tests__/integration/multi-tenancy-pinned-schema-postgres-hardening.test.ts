/**
 * `@Entity({ schema })` 통합 테스트 2차 (PostgreSQL)
 *
 * 1차(multi-tenancy-pinned-schema-postgres.test.ts)가 다루지 않은 경로를 실제 DB로 검증합니다.
 *
 * 검증 항목:
 * 1. `synchronize: false` 재부팅 — 마이그레이션으로 스키마를 관리하는 운영 경로. DDL 없이도
 *    고정 테이블과 고정 소유자의 ManyToMany 조인 테이블이 테넌트 안에서 그대로 닿아야 한다
 *    (schema_qualified / search_path 양쪽)
 * 2. 상속 — STI 루트를 public에 고정하면 자식(자기 schema를 적은 자식 포함)도 같은 테이블을
 *    쓰고, TPT 자식은 루트 스키마를 물려받거나 다른 스키마에 자기 테이블을 두며 교차 스키마
 *    FK와 다형 조회가 테넌트 안에서 동작한다
 * 3. 쓰기 경로 — insertMany / upsert / updateMany / softDelete / restore / deleteMany / sum /
 *    SelectQueryBuilder 가 search_path 테넌트 안에서 고정 테이블에 닿는다
 * 4. migrate:generate — 기본 스키마가 아닌 곳에 고정된 테이블의 컬럼 변경이 스키마를 명시한
 *    DDL로 생성되고, 그 DDL이 실제 PG에서 up/down 모두 실행된다
 *
 * 실행 방법:
 *   INTEGRATION_TEST=true INTEGRATION_TEST_MYSQL=false PG_HOST=<host> \
 *     npx jest --testPathPattern "multi-tenancy-pinned-schema-postgres-hardening"
 *
 * PostgreSQL 전용: INTEGRATION_TEST_POSTGRES=false (MySQL 전용 실행)에서는 skip 됩니다.
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { MetadataContext } from "../../src/metadata/MetadataContext";
import { DatabaseClientOptions } from "../../src/core/DatabaseClientOptions";
import { DatabaseClient } from "../../src/DatabaseClient";
import { PostgresDriver } from "../../src/dialects/postgres/PostgresDriver";
import { PostgresTenantMigrationRunner } from "../../src/dialects/postgres/PostgresTenantMigrationRunner";
import { SchemaDiff } from "../../src/core/generators/SchemaDiff";
import { SchemaDiffMigrationGenerator } from "../../src/core/generators/SchemaDiffMigrationGenerator";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToMany,
  Inheritance,
  DeletedAt,
} from "../../src/decorators";
import {
  createTestConnection,
  rawQuery,
  TestConnectionResult,
} from "./helpers/test-connection";

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

async function columnLength(
  schema: string,
  table: string,
  column: string,
): Promise<number | null> {
  const rows = await rawQuery(
    `SELECT character_maximum_length AS len FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = '${table}' AND column_name = '${column}'`,
  );
  return rows.length === 1 ? rows[0].len : null;
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
// Suite 1: synchronize: false 재부팅
// ─────────────────────────────────────────────────────────────────

for (const strategy of STRATEGIES) {
  integrationDescribe(
    `[Integration][Postgres] pinned schema: synchronize: false boot (${strategy})`,
    () => {
      const id = suffix();
      const tenant = `test_pin_nosync_${strategy === "search_path" ? "sp" : "sq"}_${id}`;
      const planTable = `pn_plan_${id}`;
      const featureTable = `pn_feat_${id}`;
      const joinTable = `pn_pf_${id}`;
      const subTable = `pn_sub_${id}`;

      let conn: TestConnectionResult;
      let em: EntityManager;
      let Plan: any;
      let Feature: any;
      let Sub: any;

      /** Same classes, same table names — declared afresh for each boot. */
      function declareEntities() {
        @Entity({ name: featureTable, schema: "public" })
        class PinFeature {
          @PrimaryGeneratedColumn()
          id!: number;

          @Column({ type: "varchar", length: 50 })
          name!: string;
        }

        @Entity({ name: planTable, schema: "public" })
        class PinPlan {
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

        @Entity({ name: subTable })
        class PinSub {
          @PrimaryGeneratedColumn()
          id!: number;

          @Column({ type: "varchar", length: 50 })
          label!: string;
        }

        Plan = PinPlan;
        Feature = PinFeature;
        Sub = PinSub;
        return { entities: [PinFeature, PinPlan, PinSub] };
      }

      beforeAll(async () => {
        // Boot 1: synchronize creates everything and the tenant is provisioned.
        const first = await createTestConnection(
          { ...PG_BASE, synchronize: true, logging: false, tenantStrategy: strategy },
          declareEntities,
        );
        const plan = (await first.em.save(Plan, { code: "pro" })) as unknown as { id: number };
        const feature = (await first.em.save(Feature, { name: "sso" })) as unknown as { id: number };
        await rawQuery(
          `INSERT INTO "public"."${joinTable}" ("plan_id", "feature_id") VALUES (${plan.id}, ${feature.id})`,
        );
        await provision(first.em, tenant);
        await first.cleanup();

        // Boot 2: no DDL at all — the way a migrations-managed deployment boots.
        conn = await createTestConnection(
          { ...PG_BASE, synchronize: false, logging: false, tenantStrategy: strategy },
          declareEntities,
        );
        em = conn.em;
      }, 60000);

      afterAll(async () => {
        await dropSchema(tenant);
        await dropTable("public", joinTable);
        await dropTable("public", planTable);
        await dropTable("public", featureTable);
        await dropTable("public", subTable);
        await conn.cleanup();
      }, 15000);

      it("the pins are recorded without synchronize", () => {
        expect(em.resolveEntitySchema(Plan)).toBe("public");
        expect(em.resolveEntitySchema(Feature)).toBe("public");
        expect(em.resolveEntitySchema(Sub)).toBeUndefined();
      });

      it("reads the shared table and its ManyToMany relation from inside a tenant context", async () => {
        await MetadataContext.run(tenant, async () => {
          const rows = (await em.find(Plan, { relations: ["features"] })) as any[];
          expect(rows).toHaveLength(1);
          expect(rows[0].code).toBe("pro");
          expect(rows[0].features).toHaveLength(1);
          expect(rows[0].features[0].name).toBe("sso");
        });
      });

      it("writes to the shared table from inside a tenant context", async () => {
        await MetadataContext.run(tenant, async () => {
          await em.save(Plan, { code: "team" });
        });
        expect(await countRows("public", planTable)).toBe(2);
        expect(await tableExists(tenant, planTable)).toBe(false);
        expect(await tableExists(tenant, joinTable)).toBe(false);
      });

      it("keeps routing the unpinned table to the tenant schema", async () => {
        await MetadataContext.run(tenant, async () => {
          await em.save(Sub, { label: "tenant-only" });
          const rows = (await em.find(Sub)) as any[];
          expect(rows).toHaveLength(1);
        });
        expect(await countRows(tenant, subTable)).toBe(1);
        expect(await countRows("public", subTable)).toBe(0);
      });
    },
  );
}

// ─────────────────────────────────────────────────────────────────
// Suite 2: 상속 — STI 루트 고정, TPT 자식 상속/자기 스키마
// ─────────────────────────────────────────────────────────────────

integrationDescribe(
  "[Integration][Postgres] pinned schema: inheritance hierarchies (schema_qualified)",
  () => {
    const id = suffix();
    const appSchema = `test_pin_iapp_${id}`;
    const billingSchema = `test_pin_ibill_${id}`;
    const archiveSchema = `test_pin_iarch_${id}`;
    const fleetSchema = `test_pin_ifleet_${id}`;
    const tenant = `test_pin_inh_${id}`;
    const vehicleTable = `pi_vehicle_${id}`;
    const invoiceTable = `pi_invoice_${id}`;
    const creditTable = `pi_credit_${id}`;
    const archivedTable = `pi_archived_${id}`;
    const noteTable = `pi_note_${id}`;

    let conn: TestConnectionResult;
    let em: EntityManager;
    let Vehicle: any;
    let Car: any;
    let Truck: any;
    let Invoice: any;
    let CreditInvoice: any;
    let ArchivedInvoice: any;
    let Note: any;

    beforeAll(async () => {
      conn = await createTestConnection(
        {
          ...PG_BASE,
          schema: appSchema,
          synchronize: true,
          logging: false,
          tenantStrategy: "schema_qualified",
        },
        () => {
          // STI: one table in "public"; children share it whatever they say.
          @Entity({ name: vehicleTable, schema: "public" })
          @Inheritance({ strategy: "SINGLE_TABLE" })
          class PinVehicle {
            @PrimaryGeneratedColumn()
            id!: number;

            @Column({ type: "varchar", length: 50 })
            plate!: string;
          }

          @Entity()
          class PinCar extends PinVehicle {
            @Column({ type: "int", nullable: true })
            doors?: number;
          }

          @Entity({ schema: fleetSchema })
          class PinTruck extends PinVehicle {
            @Column({ type: "int", nullable: true })
            axles?: number;
          }

          // TPT: root in "billing"; one child inherits it, one pins "archive".
          @Entity({ name: invoiceTable, schema: billingSchema })
          @Inheritance({ strategy: "JOINED" })
          class PinInvoice {
            @PrimaryGeneratedColumn()
            id!: number;

            @Column({ type: "int" })
            amount!: number;
          }

          @Entity({ name: creditTable })
          class PinCreditInvoice extends PinInvoice {
            @Column({ type: "int", nullable: true })
            credit?: number;
          }

          @Entity({ name: archivedTable, schema: archiveSchema })
          class PinArchivedInvoice extends PinInvoice {
            @Column({ type: "int", nullable: true })
            reason?: number;
          }

          // Per-tenant table, so provisioning has something to clone.
          @Entity({ name: noteTable })
          class PinNote {
            @PrimaryGeneratedColumn()
            id!: number;

            @Column({ type: "varchar", length: 50 })
            body!: string;
          }

          Vehicle = PinVehicle;
          Car = PinCar;
          Truck = PinTruck;
          Invoice = PinInvoice;
          CreditInvoice = PinCreditInvoice;
          ArchivedInvoice = PinArchivedInvoice;
          Note = PinNote;
          return {
            entities: [
              PinVehicle,
              PinCar,
              PinTruck,
              PinInvoice,
              PinCreditInvoice,
              PinArchivedInvoice,
              PinNote,
            ],
          };
        },
      );
      em = conn.em;
      await provision(em, tenant, { sourceSchema: appSchema });
    }, 60000);

    afterAll(async () => {
      await dropSchema(tenant);
      await dropSchema(archiveSchema);
      await dropSchema(billingSchema);
      await dropSchema(fleetSchema);
      await dropSchema(appSchema);
      await dropTable("public", vehicleTable);
      await conn.cleanup();
    }, 15000);

    it("STI: one table in public, no schema for the child's ignored pin, nothing cloned", async () => {
      expect(await tableExists("public", vehicleTable)).toBe(true);
      expect(await tableExists(appSchema, vehicleTable)).toBe(false);
      expect(await tableExists(tenant, vehicleTable)).toBe(false);
      expect(await schemaExists(fleetSchema)).toBe(false);

      expect(em.resolveEntitySchema(Vehicle)).toBe("public");
      expect(em.resolveEntitySchema(Car)).toBe("public");
      expect(em.resolveEntitySchema(Truck)).toBe("public");
    });

    it("STI: children are written to and read from the shared public table inside a tenant context", async () => {
      await MetadataContext.run(tenant, async () => {
        await em.save(Car, { plate: "CAR-1", doors: 4 });
        await em.save(Truck, { plate: "TRK-1", axles: 3 });

        const trucks = (await em.find(Truck)) as any[];
        expect(trucks).toHaveLength(1);
        expect(trucks[0].axles).toBe(3);

        const all = (await em.find(Vehicle)) as any[];
        expect(all).toHaveLength(2);
        expect(all.map((v) => v.constructor)).toEqual(
          expect.arrayContaining([Car, Truck]),
        );
      });
      expect(await countRows("public", vehicleTable)).toBe(2);
    });

    it("TPT: child tables land in the inherited / pinned schema with FKs to the root's schema", async () => {
      expect(await tableExists(billingSchema, invoiceTable)).toBe(true);
      expect(await tableExists(billingSchema, creditTable)).toBe(true);
      expect(await tableExists(archiveSchema, archivedTable)).toBe(true);
      expect(await tableExists(appSchema, creditTable)).toBe(false);
      expect(await tableExists(appSchema, archivedTable)).toBe(false);

      expect(await foreignKeyTargets(billingSchema, creditTable)).toEqual([
        { column: "id", refSchema: billingSchema, refTable: invoiceTable },
      ]);
      expect(await foreignKeyTargets(archiveSchema, archivedTable)).toEqual([
        { column: "id", refSchema: billingSchema, refTable: invoiceTable },
      ]);

      // Not per-tenant: none of them is cloned, while the plain table is.
      expect(await tableExists(tenant, invoiceTable)).toBe(false);
      expect(await tableExists(tenant, creditTable)).toBe(false);
      expect(await tableExists(tenant, archivedTable)).toBe(false);
      expect(await tableExists(tenant, noteTable)).toBe(true);
    });

    it("TPT: writes and polymorphic reads join across the pinned schemas inside a tenant context", async () => {
      await MetadataContext.run(tenant, async () => {
        await em.save(CreditInvoice, { amount: 100, credit: 5 });
        await em.save(ArchivedInvoice, { amount: 200, reason: 7 });

        const credits = (await em.find(CreditInvoice)) as any[];
        expect(credits).toHaveLength(1);
        expect(credits[0].amount).toBe(100);
        expect(credits[0].credit).toBe(5);

        const archived = (await em.find(ArchivedInvoice)) as any[];
        expect(archived).toHaveLength(1);
        expect(archived[0].reason).toBe(7);

        const all = (await em.find(Invoice)) as any[];
        expect(all).toHaveLength(2);
        expect(all.map((i) => i.amount).sort()).toEqual([100, 200]);
      });
      expect(await countRows(billingSchema, invoiceTable)).toBe(2);
      expect(await countRows(billingSchema, creditTable)).toBe(1);
      expect(await countRows(archiveSchema, archivedTable)).toBe(1);
    });

    it("the per-tenant table still follows the tenant", async () => {
      await MetadataContext.run(tenant, async () => {
        await em.save(Note, { body: "hello" });
      });
      expect(await countRows(tenant, noteTable)).toBe(1);
      expect(await countRows(appSchema, noteTable)).toBe(0);
    });
  },
);

// ─────────────────────────────────────────────────────────────────
// Suite 3: 쓰기 경로 — search_path 테넌트 안에서 고정 테이블
// ─────────────────────────────────────────────────────────────────

integrationDescribe(
  "[Integration][Postgres] pinned schema: write paths inside a tenant context (search_path)",
  () => {
    const id = suffix();
    const tenant = `test_pin_write_${id}`;
    const itemTable = `pw_item_${id}`;

    let conn: TestConnectionResult;
    let em: EntityManager;
    let Item: any;

    beforeAll(async () => {
      conn = await createTestConnection(
        { ...PG_BASE, synchronize: true, logging: false, tenantStrategy: "search_path" },
        () => {
          @Entity({ name: itemTable, schema: "public" })
          class PinItem {
            @PrimaryGeneratedColumn()
            id!: number;

            @Column({ type: "varchar", length: 50 })
            code!: string;

            @Column({ type: "int" })
            qty!: number;

            @DeletedAt()
            deletedAt?: Date | null;
          }
          Item = PinItem;
          return { entities: [PinItem] };
        },
      );
      em = conn.em;
      await provision(em, tenant);
    }, 30000);

    afterAll(async () => {
      await dropSchema(tenant);
      await dropTable("public", itemTable);
      await conn.cleanup();
    }, 15000);

    it("insertMany / find / findByPK", async () => {
      await MetadataContext.run(tenant, async () => {
        const { affected } = await em.insertMany(Item, [
          { code: "a", qty: 1 },
          { code: "b", qty: 2 },
          { code: "c", qty: 3 },
        ]);
        expect(affected).toBe(3);

        const rows = (await em.find(Item, { where: { code: "b" } })) as any[];
        expect(rows).toHaveLength(1);
        const byPk = (await em.findByPK(Item, rows[0].id)) as any;
        expect(byPk?.qty).toBe(2);
      });
      expect(await countRows("public", itemTable)).toBe(3);
      expect(await tableExists(tenant, itemTable)).toBe(false);
    });

    it("upsert on the primary key updates the shared row", async () => {
      await MetadataContext.run(tenant, async () => {
        const [a] = (await em.find(Item, { where: { code: "a" } })) as any[];
        await em.upsert(Item, { id: a.id, code: "a", qty: 10 }, ["id"]);
        const again = (await em.findByPK(Item, a.id)) as any;
        expect(again.qty).toBe(10);
      });
      expect(await countRows("public", itemTable)).toBe(3);
    });

    it("updateMany and sum", async () => {
      await MetadataContext.run(tenant, async () => {
        const { affected } = await em.updateMany<any>(
          Item,
          { qty: 20 },
          { where: { code: "b" } },
        );
        expect(affected).toBe(1);
        // 10 (a) + 20 (b) + 3 (c)
        expect(await em.sum(Item, "qty")).toBe(33);
      });
    });

    it("softDelete hides the row, restore brings it back", async () => {
      await MetadataContext.run(tenant, async () => {
        await em.softDelete(Item, { code: "c" });
        expect((await em.find(Item)) as any[]).toHaveLength(2);
        expect((await em.find(Item, { withDeleted: true })) as any[]).toHaveLength(3);

        await em.restore(Item, { code: "c" });
        expect((await em.find(Item)) as any[]).toHaveLength(3);
      });
      const deleted = await rawQuery(
        `SELECT count(*)::int AS c FROM "public"."${itemTable}" WHERE "deletedAt" IS NOT NULL`,
      );
      expect(deleted[0].c).toBe(0);
    });

    it("SelectQueryBuilder selects FROM the pinned table", async () => {
      await MetadataContext.run(tenant, async () => {
        const qb = em.createQueryBuilder(Item, "i").orderBy({ code: "ASC" });
        expect(qb.getSql().text).toContain(`"public"."${itemTable}"`);
        const rows = (await qb.getMany()) as any[];
        expect(rows.map((r) => r.code)).toEqual(["a", "b", "c"]);
      });
    });

    it("deleteMany removes the shared rows", async () => {
      await MetadataContext.run(tenant, async () => {
        const rows = (await em.find(Item)) as any[];
        const { affected } = await em.deleteMany(
          Item,
          rows.map((r) => r.id),
        );
        expect(affected).toBe(3);
      });
      expect(await countRows("public", itemTable)).toBe(0);
    });
  },
);

// ─────────────────────────────────────────────────────────────────
// Suite 4: migrate:generate — 기본 스키마가 아닌 고정 스키마의 컬럼 변경
// ─────────────────────────────────────────────────────────────────

integrationDescribe(
  "[Integration][Postgres] pinned schema: migrate:generate names the pinned schema",
  () => {
    const id = suffix();
    const appSchema = `test_pin_gapp_${id}`;
    const billingSchema = `test_pin_gbill_${id}`;
    const ledgerTable = `pg_ledger_${id}`;

    let conn: TestConnectionResult;
    let V2: any;

    beforeAll(async () => {
      conn = await createTestConnection(
        { ...PG_BASE, schema: appSchema, synchronize: true, logging: false },
        () => {
          @Entity({ name: ledgerTable, schema: billingSchema })
          class PinLedgerV1 {
            @PrimaryGeneratedColumn()
            id!: number;

            @Column({ type: "varchar", length: 50 })
            code!: string;
          }

          // The next version of the same table: a widened column and a new one.
          @Entity({ name: ledgerTable, schema: billingSchema })
          class PinLedgerV2 {
            @PrimaryGeneratedColumn()
            id!: number;

            @Column({ type: "varchar", length: 80 })
            code!: string;

            @Column({ type: "varchar", length: 20, nullable: true })
            note!: string | null;
          }

          V2 = PinLedgerV2;
          return { entities: [PinLedgerV1] };
        },
      );
    }, 30000);

    afterAll(async () => {
      await dropSchema(billingSchema);
      await dropSchema(appSchema);
      await conn.cleanup();
    }, 15000);

    it("the generated up() / down() run against the real database in the pinned schema", async () => {
      expect(await tableExists(billingSchema, ledgerTable)).toBe(true);
      expect(await columnNames(billingSchema, ledgerTable)).toEqual(["id", "code"]);

      const connector = DatabaseClient.getInstance().getConnection();
      const runner = { query: (sql: any) => connector.query(sql) };
      const diff = await new SchemaDiff().diff([V2], runner, "postgres", appSchema);

      expect(diff.addTables).toEqual([]);
      expect(diff.addColumns).toEqual([
        expect.objectContaining({
          tableName: ledgerTable,
          schema: billingSchema,
          columnName: "note",
        }),
      ]);
      expect(diff.alterColumns).toEqual([
        expect.objectContaining({
          tableName: ledgerTable,
          schema: billingSchema,
          columnName: "code",
          expectedLength: 80,
          actualLength: 50,
        }),
      ]);

      const { up, down } = new SchemaDiffMigrationGenerator().dryRun(diff, "postgres");
      expect(up).toHaveLength(2);
      for (const stmt of up) {
        expect(stmt).toContain(`ALTER TABLE "${billingSchema}"."${ledgerTable}"`);
      }

      // up(): the statements are valid and hit the pinned table.
      for (const stmt of up) {
        await rawQuery(stmt);
      }
      expect(await columnNames(billingSchema, ledgerTable)).toEqual(["id", "code", "note"]);
      expect(await columnLength(billingSchema, ledgerTable, "code")).toBe(80);
      expect(await tableExists(appSchema, ledgerTable)).toBe(false);

      // down(): reverses it in the same schema.
      for (const stmt of down) {
        await rawQuery(stmt);
      }
      expect(await columnNames(billingSchema, ledgerTable)).toEqual(["id", "code"]);
    }, 30000);
  },
);
