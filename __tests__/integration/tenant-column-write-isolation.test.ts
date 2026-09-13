/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * tenant_column write isolation against real servers (MySQL/MariaDB + PostgreSQL).
 *
 * Mirrors __tests__/integration/sqlite/tenant-column-write-isolation.test.ts.
 * The dialects diverge exactly where this fix does: PostgreSQL guards the
 * conflict branch with `DO UPDATE … WHERE`, MySQL has no predicate there and
 * guards every assignment with `IF()` instead. MySQL's affected-rows count is
 * not a usable signal — mysql2 connects with `CLIENT_FOUND_ROWS`, so a blocked
 * row reports 1 (matched, unchanged), a real update reports 2 and an insert
 * reports 1 — so the row contents are the assertion that matters on both.
 *
 * Runs only under INTEGRATION_TEST=true; individual drivers can be disabled
 * with INTEGRATION_TEST_MYSQL=false / INTEGRATION_TEST_POSTGRES=false.
 */
import "reflect-metadata";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { UniqueIndex } from "../../src/decorators/UniqueIndex";
import { TenantColumn } from "../../src/decorators/TenantColumn";
import { EntityManager } from "../../src/core/EntityManager";
import { MetadataContext } from "../../src/metadata/MetadataContext";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";
import { EntityNotFoundError } from "../../src/errors/EntityNotFoundError";
import {
  createTestConnection,
  rawQuery,
  dropTestTable,
  truncateTestTable,
  TestConnectionResult,
} from "./helpers/test-connection";
import {
  getTestDrivers,
  type TestDriverConfig,
} from "./helpers/driver-config";

const INTEGRATION = process.env.INTEGRATION_TEST === "true";
const drivers = INTEGRATION ? getTestDrivers() : [];

const TABLES = {
  order: "tcwi_order",
  declared: "tcwi_declared",
} as const;

describe.each(drivers)(
  "[Integration][$label] tenant_column write isolation",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let OrderE: any;
    let DeclaredE: any;

    /** Every row of a table, tenant column included, with no scoping applied. */
    async function allRows(table: string): Promise<any[]> {
      const rows: any = await rawQuery(
        `SELECT * FROM ${type === "mysql" ? `\`${table}\`` : `"${table}"`} ORDER BY id`,
      );
      return Array.isArray(rows) ? rows : (rows?.rows ?? []);
    }

    /**
     * A blocked conflict reports 0 on PostgreSQL; on MySQL the count conflates
     * "matched but unchanged" with "inserted", so only the rows are checked.
     */
    function expectBlockedCount(affected: number): void {
      if (type === "mysql") return;
      expect(affected).toBe(0);
    }

    async function errorOf(fn: () => unknown | Promise<unknown>): Promise<any> {
      try {
        await fn();
        return null;
      } catch (e) {
        return e;
      }
    }

    beforeAll(async () => {
      conn = await createTestConnection(
        {
          ...options,
          synchronize: true,
          logging: false,
          tenantStrategy: "tenant_column",
        },
        () => {
          @Entity({ name: TABLES.order })
          @UniqueIndex(["slug"])
          class OrderEntity {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 64 }) slug!: string;
            @Column({ type: "int" }) amount!: number;
          }

          @Entity({ name: TABLES.declared })
          @UniqueIndex(["slug"])
          class DeclaredEntity {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 64 }) slug!: string;
            @Column({ type: "int" }) amount!: number;
            @TenantColumn() tenantId!: string;
          }

          OrderE = OrderEntity;
          DeclaredE = DeclaredEntity;
          return { entities: [OrderEntity, DeclaredEntity] };
        },
      );
      em = conn.em;
    }, 60000);

    afterAll(async () => {
      for (const t of [TABLES.order, TABLES.declared]) {
        try {
          await dropTestTable(t);
        } catch {
          /* ignore */
        }
      }
      await conn.cleanup();
    });

    beforeEach(async () => {
      await truncateTestTable(TABLES.order);
      await truncateTestTable(TABLES.declared);
      await MetadataContext.run("globex", () =>
        em.save(OrderE, { slug: "g1", amount: 100 }),
      );
    });

    it("upsert() leaves another tenant's row untouched (unique conflict)", async () => {
      const result = await MetadataContext.run("acme", () =>
        em.upsert(OrderE, { slug: "g1", amount: 777 }, ["slug"]),
      );

      expectBlockedCount(result.affected);
      const rows = await allRows(TABLES.order);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        slug: "g1",
        amount: 100,
        tenant_id: "globex",
      });
    });

    it("upsert() leaves another tenant's row untouched (primary-key conflict)", async () => {
      const [existing] = await allRows(TABLES.order);

      const result = await MetadataContext.run("acme", () =>
        em.upsert(OrderE, { id: existing.id, slug: "g1", amount: 778 }),
      );

      expectBlockedCount(result.affected);
      const rows = await allRows(TABLES.order);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ amount: 100, tenant_id: "globex" });
    });

    it("upsert() still updates the caller's own row", async () => {
      await MetadataContext.run("acme", () =>
        em.save(OrderE, { slug: "a1", amount: 10 }),
      );

      await MetadataContext.run("acme", () =>
        em.upsert(OrderE, { slug: "a1", amount: 42 }, ["slug"]),
      );

      const rows = await allRows(TABLES.order);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ amount: 100, tenant_id: "globex" });
      expect(rows[1]).toMatchObject({ amount: 42, tenant_id: "acme" });
    });

    it("batchUpsert() updates own rows, inserts new ones and skips foreign ones", async () => {
      await MetadataContext.run("acme", () =>
        em.save(OrderE, { slug: "a1", amount: 10 }),
      );

      await MetadataContext.run("acme", () =>
        em.batchUpsert(
          OrderE,
          [
            { slug: "a1", amount: 11 },
            { slug: "g1", amount: 999 },
            { slug: "a2", amount: 12 },
          ],
          ["slug"],
        ),
      );

      const rows = await allRows(TABLES.order);
      const bySlug = Object.fromEntries(rows.map((r) => [r.slug, r]));
      expect(bySlug["g1"]).toMatchObject({ amount: 100, tenant_id: "globex" });
      expect(bySlug["a1"]).toMatchObject({ amount: 11, tenant_id: "acme" });
      expect(bySlug["a2"]).toMatchObject({ amount: 12, tenant_id: "acme" });
    });

    it("save() rejects an UPDATE of another tenant's row and writes nothing", async () => {
      const [existing] = await allRows(TABLES.order);

      const error = await errorOf(() =>
        MetadataContext.run("acme", () =>
          em.save(OrderE, { id: existing.id, slug: "g1-x", amount: 4242 }),
        ),
      );

      expect(error).toBeInstanceOf(EntityNotFoundError);
      const rows = await allRows(TABLES.order);
      expect(rows[0]).toMatchObject({
        slug: "g1",
        amount: 100,
        tenant_id: "globex",
      });
    });

    it("save() still updates the caller's own row", async () => {
      const created: any = await MetadataContext.run("acme", () =>
        em.save(OrderE, { slug: "a1", amount: 10 }),
      );

      await MetadataContext.run("acme", () =>
        em.save(OrderE, { id: created.id, amount: 11 }),
      );

      const rows = await allRows(TABLES.order);
      expect(rows[1]).toMatchObject({ amount: 11, tenant_id: "acme" });
    });

    it("save() rejects a payload naming another tenant", async () => {
      await MetadataContext.run("globex", () =>
        em.save(DeclaredE, { slug: "d1", amount: 1 }),
      );
      const [existing] = await allRows(TABLES.declared);

      const error = await errorOf(() =>
        MetadataContext.run("acme", () =>
          em.save(DeclaredE, {
            id: existing.id,
            amount: 2,
            tenantId: "globex",
          }),
        ),
      );

      expect(error?.code).toBe(OrmErrorCode.TENANT_MISMATCH);
      const rows = await allRows(TABLES.declared);
      expect(rows[0]).toMatchObject({ amount: 1, tenantId: "globex" });
    });

    it("createInsertBuilder().doUpdate() leaves another tenant's row untouched", async () => {
      const result = await MetadataContext.run("acme", () =>
        em
          .createInsertBuilder(OrderE)
          .values({ slug: "g1", amount: 1234 } as any)
          .onConflict(["slug"] as any)
          .doUpdate(["amount"] as any)
          .execute(),
      );

      expectBlockedCount(result.affected);
      const rows = await allRows(TABLES.order);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ amount: 100, tenant_id: "globex" });
    });

    it("insertIgnore() still skips a conflicting foreign row", async () => {
      const result = await MetadataContext.run("acme", () =>
        em.insertIgnore(OrderE, { slug: "g1", amount: 780 }, ["slug"]),
      );

      expectBlockedCount(result.affected);
      const rows = await allRows(TABLES.order);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ amount: 100, tenant_id: "globex" });
    });
  },
);
