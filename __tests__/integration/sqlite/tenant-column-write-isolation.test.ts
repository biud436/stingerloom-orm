/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite In-Memory: no write path may touch a row owned by another tenant
 * under `tenantStrategy: "tenant_column"`.
 *
 * Regression (V6-T0-1): the read paths and the criteria-based writes carried
 * the tenant predicate, but four paths did not —
 *
 *   - `upsert()` / `batchUpsert()`: `ON CONFLICT … DO UPDATE` had no WHERE, and
 *     the injected tenant column was in the SET list, so a conflicting row was
 *     rewritten *and* re-owned.
 *   - `save({ id })` / `saveMany([{ id }])`: the UPDATE matched on the primary
 *     key alone, so a foreign row was updated; the tenant-scoped read-back then
 *     returned `null` and the caller saw nothing.
 *   - `createInsertBuilder().doUpdate()`: same missing predicate as `upsert()`.
 *
 * `insertIgnore()`, `update()`, `updateMany()`, `increment()`, `delete()`,
 * `deleteMany()`, `softDelete()`, `restore()` and the UPDATE builder were
 * already scoped and are pinned here as regressions.
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryColumn } from "../../../src/decorators/PrimaryColumn";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { UniqueIndex } from "../../../src/decorators/UniqueIndex";
import { Version } from "../../../src/decorators/Version";
import { DeletedAt } from "../../../src/decorators/DeletedAt";
import {
  NonTenantEntity,
  TenantColumn,
} from "../../../src/decorators/TenantColumn";
import { EntityManager } from "../../../src/core/EntityManager";
import { MetadataContext } from "../../../src/metadata/MetadataContext";
import { OrmErrorCode } from "../../../src/errors/OrmErrorCode";
import { EntityNotFoundError } from "../../../src/errors/EntityNotFoundError";
import { qAlias } from "../../../src/core/query-builder/alias/qAlias";
import sql from "../../../src/utils/sqlTag";
import { bufferPlugin } from "../../../src/core/plugin/buffer/bufferPlugin";

// ── Entities ────────────────────────────────────────────────────────────────

@Entity({ name: "twi_order" })
@UniqueIndex(["slug"])
class TwiOrder {
  @PrimaryGeneratedColumn() id!: number;
  @Column() slug!: string;
  @Column({ type: "int" }) amount!: number;
}

/** Declares the tenant discriminator as a real property. */
@Entity({ name: "twi_declared" })
@UniqueIndex(["slug"])
class TwiDeclared {
  @PrimaryGeneratedColumn() id!: number;
  @Column() slug!: string;
  @Column({ type: "int" }) amount!: number;
  @TenantColumn() tenantId!: string;
}

/** Optimistic locking on top of tenant scoping. */
@Entity({ name: "twi_versioned" })
class TwiVersioned {
  @PrimaryGeneratedColumn() id!: number;
  @Column() label!: string;
  @Version() version!: number;
}

/** Soft delete — a deleted foreign row must not be stealable either. */
@Entity({ name: "twi_soft" })
@UniqueIndex(["slug"])
class TwiSoft {
  @PrimaryGeneratedColumn() id!: number;
  @Column() slug!: string;
  @Column() label!: string;
  @DeletedAt() deletedAt?: Date;
}

/** Composite primary key: the conflict target is multi-column. */
@Entity({ name: "twi_composite" })
class TwiComposite {
  @PrimaryColumn({ type: "int" }) a!: number;
  @PrimaryColumn({ type: "int" }) b!: number;
  @Column({ type: "int" }) val!: number;
}

/** Nothing but a primary key: the DO UPDATE list is empty after the fix. */
@Entity({ name: "twi_pkonly" })
class TwiPkOnly {
  @PrimaryColumn({ type: "int" }) id!: number;
}

/** Opted out of tenant scoping entirely. */
@Entity({ name: "twi_global" })
@NonTenantEntity()
class TwiGlobal {
  @PrimaryGeneratedColumn() id!: number;
  @Column() label!: string;
}

const ENTITIES = [
  TwiOrder,
  TwiDeclared,
  TwiVersioned,
  TwiSoft,
  TwiComposite,
  TwiPkOnly,
  TwiGlobal,
];

// ── Helpers ─────────────────────────────────────────────────────────────────

async function makeEm(opts: Record<string, any> = {}) {
  const em = new EntityManager();
  await em.register(
    {
      type: "sqlite",
      database: ":memory:",
      entities: ENTITIES,
      synchronize: true,
      tenantStrategy: "tenant_column",
      logging: false,
      ...opts,
    },
    `twi_${Math.random().toString(36).slice(2, 10)}`,
  );
  return em;
}

/** Every row of a table, tenant column included, with no scoping applied. */
async function allRows(em: EntityManager, table: string): Promise<any[]> {
  const driver = em.getDriver()!;
  const raw: any = await driver.executeRaw(
    `SELECT * FROM "${table}" ORDER BY rowid`,
  );
  return Array.isArray(raw) ? raw : (raw.results ?? raw.rows ?? []);
}

async function errorOf(fn: () => unknown | Promise<unknown>): Promise<any> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

describe("[Integration] SQLite: tenant_column write isolation", () => {
  let em: EntityManager;

  beforeEach(async () => {
    MetadataContext.reset();
    em = await makeEm();
  });

  afterEach(async () => {
    await em.propagateShutdown();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // upsert / batchUpsert
  // ─────────────────────────────────────────────────────────────────────────
  describe("upsert()", () => {
    beforeEach(async () => {
      await MetadataContext.run("globex", () =>
        em.save(TwiOrder, { slug: "g1", amount: 100 } as any),
      );
    });

    it("leaves another tenant's row untouched on a unique conflict", async () => {
      const result = await MetadataContext.run("acme", () =>
        em.upsert(TwiOrder, { slug: "g1", amount: 777 } as any, ["slug"]),
      );

      expect(result.affected).toBe(0);
      expect(await allRows(em, "twi_order")).toEqual([
        { id: 1, slug: "g1", amount: 100, tenant_id: "globex" },
      ]);
    });

    it("leaves another tenant's row untouched on a primary-key conflict", async () => {
      const result = await MetadataContext.run("acme", () =>
        em.upsert(TwiOrder, { id: 1, slug: "g1", amount: 778 } as any),
      );

      expect(result.affected).toBe(0);
      expect(await allRows(em, "twi_order")).toEqual([
        { id: 1, slug: "g1", amount: 100, tenant_id: "globex" },
      ]);
    });

    it("still updates the caller's own row", async () => {
      await MetadataContext.run("acme", () =>
        em.save(TwiOrder, { slug: "a1", amount: 10 } as any),
      );

      const result = await MetadataContext.run("acme", () =>
        em.upsert(TwiOrder, { slug: "a1", amount: 42 } as any, ["slug"]),
      );

      expect(result.affected).toBe(1);
      expect(await allRows(em, "twi_order")).toEqual([
        { id: 1, slug: "g1", amount: 100, tenant_id: "globex" },
        { id: 2, slug: "a1", amount: 42, tenant_id: "acme" },
      ]);
    });

    it("still inserts a fresh row for the active tenant", async () => {
      const result = await MetadataContext.run("acme", () =>
        em.upsert(TwiOrder, { slug: "a2", amount: 7 } as any, ["slug"]),
      );

      expect(result.affected).toBe(1);
      const rows = await allRows(em, "twi_order");
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ slug: "a2", tenant_id: "acme" });
    });

    it("keeps inserting when the primary key is the only insertable column", async () => {
      // The tenant column is dropped from the DO UPDATE list, which empties it
      // for a PK-only entity — the statement must degrade to DO NOTHING, not
      // to a no-op that writes nothing at all.
      const result = await MetadataContext.run("acme", () =>
        em.upsert(TwiPkOnly, { id: 1 } as any),
      );

      expect(result.affected).toBe(1);
      expect(await allRows(em, "twi_pkonly")).toEqual([
        { id: 1, tenant_id: "acme" },
      ]);
    });

    it("blocks a composite-primary-key conflict owned by another tenant", async () => {
      await MetadataContext.run("globex", () =>
        em.save(TwiComposite, { a: 1, b: 2, val: 10 } as any),
      );

      const result = await MetadataContext.run("acme", () =>
        em.upsert(TwiComposite, { a: 1, b: 2, val: 999 } as any),
      );

      expect(result.affected).toBe(0);
      expect(await allRows(em, "twi_composite")).toEqual([
        { a: 1, b: 2, val: 10, tenant_id: "globex" },
      ]);
    });

    it("cannot steal a soft-deleted row from another tenant", async () => {
      await MetadataContext.run("globex", async () => {
        await em.save(TwiSoft, { slug: "s1", label: "g" } as any);
        await em.softDelete(TwiSoft, { slug: "s1" } as any);
      });

      const result = await MetadataContext.run("acme", () =>
        em.upsert(TwiSoft, { slug: "s1", label: "stolen" } as any, ["slug"]),
      );

      expect(result.affected).toBe(0);
      const rows = await allRows(em, "twi_soft");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ label: "g", tenant_id: "globex" });
      expect(rows[0].deletedAt ?? rows[0].deleted_at).toBeTruthy();
    });

    it("does not move an entity between tenants through the tenant property", async () => {
      await MetadataContext.run("globex", () =>
        em.save(TwiDeclared, { slug: "d1", amount: 1 } as any),
      );

      const error = await errorOf(() =>
        MetadataContext.run("acme", () =>
          em.upsert(
            TwiDeclared,
            { slug: "d1", amount: 2, tenantId: "globex" } as any,
            ["slug"],
          ),
        ),
      );

      expect(error?.code).toBe(OrmErrorCode.TENANT_MISMATCH);
      expect(await allRows(em, "twi_declared")).toEqual([
        { id: 1, slug: "d1", amount: 1, tenantId: "globex" },
      ]);
    });
  });

  describe("upsert() diagnostics", () => {
    it("warns once per entity class when a foreign row is skipped", async () => {
      await MetadataContext.run("globex", () =>
        em.save(TwiOrder, { slug: "g1", amount: 100 } as any),
      );
      const warn = jest.spyOn((em as any).logger, "warn");

      await MetadataContext.run("acme", async () => {
        await em.upsert(TwiOrder, { slug: "g1", amount: 1 } as any, ["slug"]);
        await em.upsert(TwiOrder, { slug: "g1", amount: 2 } as any, ["slug"]);
      });

      const suppressed = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes("belongs to another tenant"));
      expect(suppressed).toHaveLength(1);
      warn.mockRestore();
    });

    it("stays quiet when the statement degraded to DO NOTHING", async () => {
      await MetadataContext.run("acme", () =>
        em.upsert(TwiPkOnly, { id: 1 } as any),
      );
      const warn = jest.spyOn((em as any).logger, "warn");

      // The caller's own row: nothing to update, so the conflict is skipped
      // for reasons that have nothing to do with tenancy.
      const again = await MetadataContext.run("acme", () =>
        em.upsert(TwiPkOnly, { id: 1 } as any),
      );

      expect(again.affected).toBe(0);
      expect(
        warn.mock.calls
          .map((c) => String(c[0]))
          .filter((m) => m.includes("belongs to another tenant")),
      ).toHaveLength(0);
      warn.mockRestore();
    });
  });

  describe("batchUpsert()", () => {
    it("updates own rows, inserts new ones and skips foreign ones", async () => {
      await MetadataContext.run("globex", () =>
        em.save(TwiOrder, { slug: "g1", amount: 100 } as any),
      );
      await MetadataContext.run("acme", () =>
        em.save(TwiOrder, { slug: "a1", amount: 10 } as any),
      );

      const result = await MetadataContext.run("acme", () =>
        em.batchUpsert(
          TwiOrder,
          [
            { slug: "a1", amount: 11 },
            { slug: "g1", amount: 999 },
            { slug: "a2", amount: 12 },
          ] as any,
          ["slug"],
        ),
      );

      expect(result.affected).toBe(2);
      // The blocked row still consumes a rowid, so only the values are pinned.
      const rows = await allRows(em, "twi_order");
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({
        slug: "g1",
        amount: 100,
        tenant_id: "globex",
      });
      expect(rows[1]).toMatchObject({
        slug: "a1",
        amount: 11,
        tenant_id: "acme",
      });
      expect(rows[2]).toMatchObject({
        slug: "a2",
        amount: 12,
        tenant_id: "acme",
      });
    });
  });

  describe("insertIgnore() (already scoped — regression pin)", () => {
    it("never writes over a conflicting foreign row", async () => {
      await MetadataContext.run("globex", () =>
        em.save(TwiOrder, { slug: "g1", amount: 100 } as any),
      );

      const result = await MetadataContext.run("acme", () =>
        em.insertIgnore(TwiOrder, { slug: "g1", amount: 780 } as any, ["slug"]),
      );

      expect(result.affected).toBe(0);
      expect(await allRows(em, "twi_order")).toEqual([
        { id: 1, slug: "g1", amount: 100, tenant_id: "globex" },
      ]);
    });
  });

  describe("createInsertBuilder().doUpdate()", () => {
    beforeEach(async () => {
      await MetadataContext.run("globex", () =>
        em.save(TwiOrder, { slug: "g1", amount: 100 } as any),
      );
    });

    it("leaves another tenant's row untouched on conflict", async () => {
      const result = await MetadataContext.run("acme", () =>
        em
          .createInsertBuilder(TwiOrder)
          .values({ slug: "g1", amount: 1234 } as any)
          .onConflict(["slug"] as any)
          .doUpdate(["amount"] as any)
          .execute(),
      );

      expect(result.affected).toBe(0);
      expect(await allRows(em, "twi_order")).toEqual([
        { id: 1, slug: "g1", amount: 100, tenant_id: "globex" },
      ]);
    });

    it("still updates the caller's own row", async () => {
      await MetadataContext.run("acme", () =>
        em.save(TwiOrder, { slug: "a1", amount: 10 } as any),
      );

      const result = await MetadataContext.run("acme", () =>
        em
          .createInsertBuilder(TwiOrder)
          .values({ slug: "a1", amount: 55 } as any)
          .onConflict(["slug"] as any)
          .doUpdate(["amount"] as any)
          .execute(),
      );

      expect(result.affected).toBe(1);
      expect(await allRows(em, "twi_order")).toEqual([
        { id: 1, slug: "g1", amount: 100, tenant_id: "globex" },
        { id: 2, slug: "a1", amount: 55, tenant_id: "acme" },
      ]);
    });

    it("cannot be defeated by a top-level OR in doUpdateWhere", async () => {
      // AND binds tighter than OR, so an unparenthesized caller predicate
      // would leave the tenant guard applying to one arm only.
      const result = await MetadataContext.run("acme", () =>
        em
          .createInsertBuilder(TwiOrder)
          .values({ slug: "g1", amount: 777 } as any)
          .onConflict(["slug"] as any)
          .doUpdate(["amount"] as any)
          .doUpdateWhere(sql`"twi_order"."amount" > 0 OR "twi_order"."amount" <= 0`)
          .execute(),
      );

      expect(result.affected).toBe(0);
      expect(await allRows(em, "twi_order")).toEqual([
        { id: 1, slug: "g1", amount: 100, tenant_id: "globex" },
      ]);
    });

    it("refuses to assign the tenant column on conflict", async () => {
      await MetadataContext.run("acme", () =>
        em.save(TwiOrder, { slug: "a1", amount: 10 } as any),
      );

      const error = await errorOf(() =>
        MetadataContext.run("acme", () =>
          em
            .createInsertBuilder(TwiOrder)
            .values({ slug: "a1", amount: 2, tenant_id: "acme" } as any)
            .onConflict(["slug"] as any)
            .doUpdate({ amount: 2, tenant_id: "globex" } as any)
            .execute(),
        ),
      );

      expect(error?.code).toBe(OrmErrorCode.TENANT_MISMATCH);
      expect(await allRows(em, "twi_order")).toEqual([
        { id: 1, slug: "g1", amount: 100, tenant_id: "globex" },
        { id: 2, slug: "a1", amount: 10, tenant_id: "acme" },
      ]);
    });

    it("keeps the caller's own doUpdateWhere predicate as well", async () => {
      await MetadataContext.run("acme", () =>
        em.save(TwiOrder, { slug: "a1", amount: 10 } as any),
      );

      const stored = qAlias(TwiOrder, "twi_order") as any;

      const result = await MetadataContext.run("acme", () =>
        em
          .createInsertBuilder(TwiOrder)
          .values({ slug: "a1", amount: 5 } as any)
          .onConflict(["slug"] as any)
          .doUpdate(["amount"] as any)
          .doUpdateWhere(stored.amount.lt(5))
          .execute(),
      );

      // The stored amount (10) fails the caller's predicate, so nothing is
      // written even though the row belongs to this tenant.
      expect(result.affected).toBe(0);

      expect(await allRows(em, "twi_order")).toEqual([
        { id: 1, slug: "g1", amount: 100, tenant_id: "globex" },
        { id: 2, slug: "a1", amount: 10, tenant_id: "acme" },
      ]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // save / saveMany
  // ─────────────────────────────────────────────────────────────────────────
  describe("save()", () => {
    beforeEach(async () => {
      await MetadataContext.run("globex", () =>
        em.save(TwiOrder, { slug: "g1", amount: 100 } as any),
      );
    });

    it("rejects an UPDATE of another tenant's row and writes nothing", async () => {
      const error = await errorOf(() =>
        MetadataContext.run("acme", () =>
          em.save(TwiOrder, { id: 1, slug: "g1-x", amount: 4242 } as any),
        ),
      );

      expect(error).toBeInstanceOf(EntityNotFoundError);
      expect(await allRows(em, "twi_order")).toEqual([
        { id: 1, slug: "g1", amount: 100, tenant_id: "globex" },
      ]);
    });

    it("rejects saveMany() over another tenant's row", async () => {
      const error = await errorOf(() =>
        MetadataContext.run("acme", () =>
          em.saveMany(TwiOrder, [{ id: 1, amount: 4243 }] as any),
        ),
      );

      expect(error).toBeInstanceOf(EntityNotFoundError);
      expect(await allRows(em, "twi_order")).toEqual([
        { id: 1, slug: "g1", amount: 100, tenant_id: "globex" },
      ]);
    });

    it("still updates the caller's own row and returns it", async () => {
      const created: any = await MetadataContext.run("acme", () =>
        em.save(TwiOrder, { slug: "a1", amount: 10 } as any),
      );

      const updated: any = await MetadataContext.run("acme", () =>
        em.save(TwiOrder, { id: created.id, amount: 11 } as any),
      );

      expect(updated.amount).toBe(11);
      expect(await allRows(em, "twi_order")).toEqual([
        { id: 1, slug: "g1", amount: 100, tenant_id: "globex" },
        { id: 2, slug: "a1", amount: 11, tenant_id: "acme" },
      ]);
    });

    it("round-trips a hydrated entity without rewriting its tenant", async () => {
      await MetadataContext.run("acme", async () => {
        await em.save(TwiOrder, { slug: "a1", amount: 10 } as any);
        const row: any = await em.findOne(TwiOrder, {
          where: { slug: "a1" } as any,
        });
        expect(row.tenant_id).toBe("acme");

        row.amount = 12;
        await em.save(TwiOrder, row);
      });

      expect(await allRows(em, "twi_order")).toEqual([
        { id: 1, slug: "g1", amount: 100, tenant_id: "globex" },
        { id: 2, slug: "a1", amount: 12, tenant_id: "acme" },
      ]);
    });

    it("rejects a payload naming another tenant", async () => {
      await MetadataContext.run("globex", () =>
        em.save(TwiDeclared, { slug: "d1", amount: 1 } as any),
      );

      const error = await errorOf(() =>
        MetadataContext.run("acme", () =>
          em.save(TwiDeclared, {
            id: 1,
            amount: 2,
            tenantId: "globex",
          } as any),
        ),
      );

      expect(error?.code).toBe(OrmErrorCode.TENANT_MISMATCH);
      expect(await allRows(em, "twi_declared")).toEqual([
        { id: 1, slug: "d1", amount: 1, tenantId: "globex" },
      ]);
    });

    it("reports a foreign row as not found rather than as a stale version", async () => {
      await MetadataContext.run("globex", () =>
        em.save(TwiVersioned, { label: "g" } as any),
      );

      const error = await errorOf(() =>
        MetadataContext.run("acme", () =>
          em.save(TwiVersioned, {
            id: 1,
            label: "stolen",
            version: 1,
          } as any),
        ),
      );

      expect(error).toBeInstanceOf(EntityNotFoundError);
      expect(await allRows(em, "twi_versioned")).toEqual([
        { id: 1, label: "g", version: 1, tenant_id: "globex" },
      ]);
    });

    it("keeps reporting a stale @Version inside the caller's own tenant", async () => {
      await MetadataContext.run("acme", () =>
        em.save(TwiVersioned, { label: "a" } as any),
      );

      const error = await errorOf(() =>
        MetadataContext.run("acme", () =>
          em.save(TwiVersioned, { id: 1, label: "x", version: 99 } as any),
        ),
      );

      expect(error?.code).toBe(OrmErrorCode.OPTIMISTIC_LOCK_FAILED);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Handing a row to another tenant is a write too
  // ─────────────────────────────────────────────────────────────────────────
  describe("reassigning the tenant column", () => {
    it("rejects updateMany() that sets the tenant column to another tenant", async () => {
      await MetadataContext.run("acme", () =>
        em.save(TwiOrder, { slug: "a1", amount: 10 } as any),
      );

      const error = await errorOf(() =>
        MetadataContext.run("acme", () =>
          em.updateMany(TwiOrder, { tenant_id: "globex" } as any, {
            where: { id: 1 } as any,
          }),
        ),
      );

      expect(error?.code).toBe(OrmErrorCode.TENANT_MISMATCH);
      expect(await allRows(em, "twi_order")).toEqual([
        { id: 1, slug: "a1", amount: 10, tenant_id: "acme" },
      ]);
    });

    it("rejects update() on a declared @TenantColumn property", async () => {
      await MetadataContext.run("acme", () =>
        em.save(TwiDeclared, { slug: "d1", amount: 1 } as any),
      );

      const error = await errorOf(() =>
        MetadataContext.run("acme", () =>
          em.update(TwiDeclared, { id: 1 } as any, {
            tenantId: "globex",
          } as any),
        ),
      );

      expect(error?.code).toBe(OrmErrorCode.TENANT_MISMATCH);
      expect(await allRows(em, "twi_declared")).toEqual([
        { id: 1, slug: "d1", amount: 1, tenantId: "acme" },
      ]);
    });

    it("accepts the current tenant in the payload and drops it from the SET list", async () => {
      await MetadataContext.run("acme", () =>
        em.save(TwiOrder, { slug: "a1", amount: 10 } as any),
      );

      const result = await MetadataContext.run("acme", () =>
        em.updateMany(TwiOrder, { amount: 11, tenant_id: "acme" } as any, {
          where: { id: 1 } as any,
        }),
      );

      expect(result.affected).toBe(1);
      expect(await allRows(em, "twi_order")).toEqual([
        { id: 1, slug: "a1", amount: 11, tenant_id: "acme" },
      ]);
    });

    it("rejects createUpdateBuilder().set() on the tenant column", async () => {
      await MetadataContext.run("acme", () =>
        em.save(TwiOrder, { slug: "a1", amount: 10 } as any),
      );

      const error = await errorOf(() =>
        MetadataContext.run("acme", () =>
          em
            .createUpdateBuilder(TwiOrder)
            .set({ tenant_id: "globex" } as any)
            .where({ id: 1 } as any)
            .execute(),
        ),
      );

      expect(error?.code).toBe(OrmErrorCode.TENANT_MISMATCH);
      expect(await allRows(em, "twi_order")).toEqual([
        { id: 1, slug: "a1", amount: 10, tenant_id: "acme" },
      ]);
    });

    it("lets runUnscoped() move a row deliberately", async () => {
      await MetadataContext.run("acme", () =>
        em.save(TwiOrder, { slug: "a1", amount: 10 } as any),
      );

      await MetadataContext.runUnscoped(() =>
        em.updateMany(TwiOrder, { tenant_id: "globex" } as any, {
          where: { id: 1 } as any,
        }),
      );

      expect(await allRows(em, "twi_order")).toEqual([
        { id: 1, slug: "a1", amount: 10, tenant_id: "globex" },
      ]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // WriteBuffer (opt-in plugin)
  // ─────────────────────────────────────────────────────────────────────────
  describe("buffer plugin with batchUpdate", () => {
    it("does not rewrite another tenant's rows on flush", async () => {
      const buffered = await makeEm({ plugins: [bufferPlugin({ batchUpdate: true })] });
      try {
        await MetadataContext.run("globex", async () => {
          await buffered.save(TwiOrder, { slug: "g1", amount: 100 } as any);
          await buffered.save(TwiOrder, { slug: "g2", amount: 200 } as any);
        });

        const buf = (buffered as any).buffer();
        const loaded: any[] = await MetadataContext.runUnscoped(() =>
          buf.find(TwiOrder, {}),
        );
        expect(loaded).toHaveLength(2);

        // Two dirty instances of one class is exactly the shape that used to
        // take the hand-built `UPDATE ... WHERE pk IN (...)` batch path.
        loaded[0].amount = 901;
        loaded[1].amount = 902;

        const error = await errorOf(() =>
          MetadataContext.run("acme", () => buf.flush()),
        );
        // The instances were hydrated under "globex", so the per-row save path
        // the batch now defers to rejects them on the payload's tenant value
        // before the UPDATE is even built.
        expect(error?.code).toBe(OrmErrorCode.TENANT_MISMATCH);

        const rows = await allRows(buffered, "twi_order");
        expect(rows.map((r) => r.amount)).toEqual([100, 200]);
        expect(rows.every((r) => r.tenant_id === "globex")).toBe(true);
      } finally {
        await buffered.propagateShutdown();
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Escape hatches and opt-outs
  // ─────────────────────────────────────────────────────────────────────────
  describe("escape hatches", () => {
    it("runUnscoped() still reaches every tenant's rows", async () => {
      await MetadataContext.run("globex", () =>
        em.save(TwiOrder, { slug: "g1", amount: 100 } as any),
      );

      await MetadataContext.runUnscoped(async () => {
        await em.save(TwiOrder, { id: 1, amount: 101 } as any);
      });

      expect(await allRows(em, "twi_order")).toEqual([
        { id: 1, slug: "g1", amount: 101, tenant_id: "globex" },
      ]);
    });

    it("still refuses an unscoped INSERT — upsert needs a tenant to write", async () => {
      const error = await errorOf(() =>
        MetadataContext.runUnscoped(() =>
          em.upsert(TwiOrder, { slug: "u1", amount: 1 } as any, ["slug"]),
        ),
      );

      expect(error?.code).toBe(OrmErrorCode.MISSING_TENANT_CONTEXT);
    });

    it("leaves @NonTenantEntity writes unscoped", async () => {
      await MetadataContext.run("globex", () =>
        em.save(TwiGlobal, { label: "g" } as any),
      );

      const updated: any = await MetadataContext.run("acme", () =>
        em.save(TwiGlobal, { id: 1, label: "shared" } as any),
      );

      expect(updated.label).toBe("shared");
      expect(await allRows(em, "twi_global")).toEqual([
        { id: 1, label: "shared" },
      ]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Paths that were already scoped
  // ─────────────────────────────────────────────────────────────────────────
  describe("criteria-based writes (regression pins)", () => {
    beforeEach(async () => {
      await MetadataContext.run("globex", () =>
        em.save(TwiOrder, { slug: "g1", amount: 100 } as any),
      );
    });

    it("update / updateMany / increment / delete / deleteMany report 0", async () => {
      await MetadataContext.run("acme", async () => {
        expect(
          (await em.update(TwiOrder, { id: 1 } as any, { amount: 1 } as any)).affected,
        ).toBe(0);
        expect(
          (await em.updateMany(TwiOrder, { amount: 2 } as any, { where: { id: 1 } as any })).affected,
        ).toBe(0);
        expect((await em.increment(TwiOrder, { id: 1 } as any, "amount" as any, 5)).affected).toBe(0);
        expect((await em.deleteMany(TwiOrder, [1])).affected).toBe(0);
        expect((await em.delete(TwiOrder, { id: 1 } as any)).affected).toBe(0);
      });

      expect(await allRows(em, "twi_order")).toEqual([
        { id: 1, slug: "g1", amount: 100, tenant_id: "globex" },
      ]);
    });
  });
});
