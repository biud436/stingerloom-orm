/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { PrimaryColumn } from "../../src/decorators/PrimaryColumn";
import { DeletedAt } from "../../src/decorators/DeletedAt";
import { NonTenantEntity } from "../../src/decorators/TenantColumn";
import { EntityManager } from "../../src/core/EntityManager";
import { MetadataContext } from "../../src/metadata/MetadataContext";

/**
 * Phase 5b coverage — tenant predicate injection on read/write paths
 * beyond the INSERT and basic find/delete paths already covered in
 * tenant-column-insert.test.ts. Each suite here constructs an in-memory
 * SQLite EM under `tenantStrategy: "tenant_column"`, seeds rows across two
 * tenants, and asserts that a query issued from one tenant's context never
 * observes or mutates rows belonging to another tenant.
 */
describe("Read/write queries under tenant_column strategy", () => {
  async function makeEm(entities: any[], opts: Record<string, any> = {}) {
    const em = new EntityManager();
    await em.register(
      {
        type: "sqlite",
        database: ":memory:",
        entities,
        synchronize: true,
        tenantStrategy: "tenant_column",
        ...opts,
      },
      `t_${Math.random().toString(36).slice(2, 10)}`,
    );
    return em;
  }

  beforeEach(() => MetadataContext.reset());

  // ── Entity fixtures ─────────────────────────────────────────────────────

  @Entity()
  class User {
    @PrimaryGeneratedColumn() id!: number;
    @Column() name!: string;
  }

  @Entity()
  class Product {
    @PrimaryGeneratedColumn() id!: number;
    @Column() name!: string;
    @Column({ type: "int", nullable: true }) stock!: number | null;
    @DeletedAt() deletedAt!: Date | null;
  }

  @Entity()
  class ManualPk {
    @PrimaryColumn({ type: "int" }) id!: number;
    @Column() label!: string;
  }

  @NonTenantEntity()
  @Entity()
  class GlobalRef {
    @PrimaryGeneratedColumn() id!: number;
    @Column() slug!: string;
  }

  async function seedTwoTenants(em: EntityManager) {
    await MetadataContext.run("acme", async () => {
      await em.save(User, { name: "Alice" });
      await em.save(User, { name: "Anna" });
    });
    await MetadataContext.run("globex", async () => {
      await em.save(User, { name: "Bob" });
      await em.save(User, { name: "Bryan" });
      await em.save(User, { name: "Bea" });
    });
  }

  // ── count / exists ─────────────────────────────────────────────────────

  describe("count() / exists()", () => {
    it("count() scopes by tenant", async () => {
      const em = await makeEm([User]);
      try {
        await seedTwoTenants(em);
        await MetadataContext.run("acme", async () => {
          expect(await em.count(User)).toBe(2);
        });
        await MetadataContext.run("globex", async () => {
          expect(await em.count(User)).toBe(3);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });

    it("exists() scopes by tenant — no false positives across tenants", async () => {
      const em = await makeEm([User]);
      try {
        await seedTwoTenants(em);
        await MetadataContext.run("acme", async () => {
          expect(await em.exists(User, { name: "Bob" } as any)).toBe(false);
          expect(await em.exists(User, { name: "Alice" } as any)).toBe(true);
        });
        await MetadataContext.run("globex", async () => {
          expect(await em.exists(User, { name: "Alice" } as any)).toBe(false);
          expect(await em.exists(User, { name: "Bob" } as any)).toBe(true);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });

    it("runUnscoped() bypasses tenant filter on count()", async () => {
      const em = await makeEm([User]);
      try {
        await seedTwoTenants(em);
        await MetadataContext.run("acme", async () => {
          const total = await MetadataContext.runUnscoped(() => em.count(User));
          expect(total).toBe(5);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });

    it("@NonTenantEntity count/exists is unfiltered", async () => {
      const em = await makeEm([GlobalRef]);
      try {
        // Seeding works without a tenant context because GlobalRef is non-tenant.
        await em.save(GlobalRef, { slug: "a" });
        await em.save(GlobalRef, { slug: "b" });
        await MetadataContext.run("acme", async () => {
          expect(await em.count(GlobalRef)).toBe(2);
          expect(await em.exists(GlobalRef, { slug: "a" } as any)).toBe(true);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  // ── findAndCount / findWithPage ────────────────────────────────────────

  describe("findAndCount() / findWithPage()", () => {
    it("findAndCount() returns tenant-scoped rows and count", async () => {
      const em = await makeEm([User]);
      try {
        await seedTwoTenants(em);
        await MetadataContext.run("acme", async () => {
          const [rows, total] = await em.findAndCount(User, {});
          expect(total).toBe(2);
          expect(rows.map((r: any) => r.name).sort()).toEqual(["Alice", "Anna"]);
        });
        await MetadataContext.run("globex", async () => {
          const [rows, total] = await em.findAndCount(User, {});
          expect(total).toBe(3);
          expect(rows.map((r: any) => r.name).sort()).toEqual([
            "Bea",
            "Bob",
            "Bryan",
          ]);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });

    it("findWithPage() returns tenant-scoped rows and total", async () => {
      const em = await makeEm([User]);
      try {
        await seedTwoTenants(em);
        await MetadataContext.run("globex", async () => {
          const page = await em.findWithPage(User, { page: 1, pageSize: 2 });
          expect(page.total).toBe(3);
          expect(page.totalPages).toBe(2);
          expect(page.data.length).toBe(2);
          expect(
            page.data.every((r: any) => r.name.startsWith("B")),
          ).toBe(true);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  // ── findWithCursor ─────────────────────────────────────────────────────

  describe("findWithCursor()", () => {
    it("scopes by tenant across all pages", async () => {
      const em = await makeEm([User]);
      try {
        await seedTwoTenants(em);
        await MetadataContext.run("globex", async () => {
          const first = await em.findWithCursor(User, { take: 2 });
          expect(first.data.length).toBe(2);
          expect(
            first.data.every((r: any) => r.name.startsWith("B")),
          ).toBe(true);
          if (first.hasNextPage && first.nextCursor) {
            const second = await em.findWithCursor(User, {
              take: 2,
              cursor: first.nextCursor,
            });
            expect(
              second.data.every((r: any) => r.name.startsWith("B")),
            ).toBe(true);
            // Total unique names across pages == 3 (globex tenant size)
            const names = new Set<string>();
            first.data.forEach((r: any) => names.add(r.name));
            second.data.forEach((r: any) => names.add(r.name));
            expect(names.size).toBe(3);
          }
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  // ── findByPK / findByPKs ───────────────────────────────────────────────

  describe("findByPK() / findByPKs()", () => {
    it("findByPK() rejects another tenant's PK even when autoIncrement IDs differ", async () => {
      const em = await makeEm([User]);
      try {
        let aliceId!: number;
        let bobId!: number;
        await MetadataContext.run("acme", async () => {
          const alice: any = await em.save(User, { name: "Alice" });
          aliceId = alice.id;
        });
        await MetadataContext.run("globex", async () => {
          const bob: any = await em.save(User, { name: "Bob" });
          bobId = bob.id;
        });

        // Under tenant A, fetching B's PK returns null.
        await MetadataContext.run("acme", async () => {
          expect(await em.findByPK(User, bobId)).toBeNull();
          const me: any = await em.findByPK(User, aliceId);
          expect(me?.name).toBe("Alice");
        });
        await MetadataContext.run("globex", async () => {
          expect(await em.findByPK(User, aliceId)).toBeNull();
          const me: any = await em.findByPK(User, bobId);
          expect(me?.name).toBe("Bob");
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });

    it("findByPK() with a manual @PrimaryColumn rejects another tenant's id", async () => {
      // Composite (tenant_id, pk) PK is not yet wired (plan §6 #5), so tenants
      // must use non-overlapping manual ids. This test still validates that
      // PK-based lookup is tenant-scoped — it filters A's id out of B's context.
      const em = await makeEm([ManualPk]);
      try {
        await MetadataContext.run("acme", async () => {
          await em.save(ManualPk, { id: 10, label: "acme-10" });
          await em.save(ManualPk, { id: 11, label: "acme-11" });
        });
        await MetadataContext.run("globex", async () => {
          await em.save(ManualPk, { id: 20, label: "globex-20" });
        });

        await MetadataContext.run("acme", async () => {
          const mine: any = await em.findByPK(ManualPk, 10);
          expect(mine?.label).toBe("acme-10");
          expect(await em.findByPK(ManualPk, 20)).toBeNull();
        });
        await MetadataContext.run("globex", async () => {
          expect(await em.findByPK(ManualPk, 10)).toBeNull();
          expect(await em.findByPK(ManualPk, 11)).toBeNull();
          const mine: any = await em.findByPK(ManualPk, 20);
          expect(mine?.label).toBe("globex-20");
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });

    it("findByPKs() filters out other tenants' IDs", async () => {
      const em = await makeEm([User]);
      try {
        let ids: number[] = [];
        await MetadataContext.run("acme", async () => {
          const a: any = await em.save(User, { name: "Alice" });
          ids.push(a.id);
        });
        await MetadataContext.run("globex", async () => {
          const b: any = await em.save(User, { name: "Bob" });
          const c: any = await em.save(User, { name: "Bryan" });
          ids.push(b.id, c.id);
        });

        // Under tenant A, asking for [acme_id, globex_id, globex_id] returns only Alice.
        await MetadataContext.run("acme", async () => {
          const rows: any[] = await em.findByPKs(User, ids);
          expect(rows.map((r) => r.name)).toEqual(["Alice"]);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  // ── updateMany ─────────────────────────────────────────────────────────

  describe("updateMany()", () => {
    it("cannot touch another tenant's rows even with matching WHERE", async () => {
      // NOTE: SQLite returns `changes` via run(), but EntityManager expects
      // `rowCount` (postgres) or `results.affectedRows` (mysql). On SQLite
      // `result.affected` is always 0 — verified by checking the raw table
      // contents instead.
      const em = await makeEm([User]);
      try {
        await seedTwoTenants(em);
        // Under acme, rename every matching row to "Common".
        await MetadataContext.run("acme", async () => {
          await em.updateMany(
            User,
            { name: "Common" } as any,
            { where: { id: { gt: 0 } as any } as any },
          );
        });

        const driver = em.getDriver()!;
        const raw: any = await driver.executeRaw(
          "SELECT name, tenant_id FROM user ORDER BY id",
        );
        const rows: any[] = Array.isArray(raw)
          ? raw
          : (raw.results ?? raw.rows ?? []);
        const byTenant = rows.reduce(
          (acc: Record<string, string[]>, r: any) => {
            (acc[r.tenant_id] ??= []).push(r.name);
            return acc;
          },
          {},
        );
        expect(byTenant.acme.length).toBe(2);
        expect(byTenant.acme.every((n: string) => n === "Common")).toBe(true);
        expect(byTenant.globex.sort()).toEqual(["Bea", "Bob", "Bryan"]);
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  // ── deleteMany ─────────────────────────────────────────────────────────

  describe("deleteMany()", () => {
    it("deleteMany([ids]) does not delete rows belonging to another tenant", async () => {
      // Composite (tenant_id, pk) PK is not implemented (plan §6 #5), so
      // tenants must use non-overlapping manual ids. The property under test
      // is that deleteMany passes IDs belonging to *other* tenants without
      // touching those rows.
      const em = await makeEm([ManualPk]);
      try {
        await MetadataContext.run("acme", async () => {
          await em.save(ManualPk, { id: 10, label: "acme-10" });
          await em.save(ManualPk, { id: 11, label: "acme-11" });
        });
        await MetadataContext.run("globex", async () => {
          await em.save(ManualPk, { id: 20, label: "globex-20" });
          await em.save(ManualPk, { id: 21, label: "globex-21" });
        });

        // Attacker scenario: acme calls deleteMany with BOTH its own ids and
        // globex's ids. Only acme's rows should disappear.
        await MetadataContext.run("acme", async () => {
          await em.deleteMany(ManualPk, [10, 11, 20, 21]);
        });

        const driver = em.getDriver()!;
        const raw: any = await driver.executeRaw(
          "SELECT label, tenant_id FROM manual_pk ORDER BY id",
        );
        const rows: any[] = Array.isArray(raw)
          ? raw
          : (raw.results ?? raw.rows ?? []);
        expect(rows).toEqual([
          { label: "globex-20", tenant_id: "globex" },
          { label: "globex-21", tenant_id: "globex" },
        ]);
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  // ── softDelete / restore ───────────────────────────────────────────────

  describe("softDelete() / restore()", () => {
    it("softDelete does not tombstone another tenant's rows", async () => {
      const em = await makeEm([Product]);
      try {
        await MetadataContext.run("acme", async () => {
          await em.save(Product, { name: "widget", stock: 5 });
        });
        await MetadataContext.run("globex", async () => {
          await em.save(Product, { name: "widget", stock: 10 });
        });

        await MetadataContext.run("acme", async () => {
          await em.softDelete(Product, { name: "widget" } as any);
        });

        // globex row is still live.
        await MetadataContext.run("globex", async () => {
          const live = await em.find(Product, { where: { name: "widget" } as any });
          expect(live.length).toBe(1);
          expect((live[0] as any).stock).toBe(10);
        });

        // acme row is gone from default find but visible under withDeleted.
        await MetadataContext.run("acme", async () => {
          const live = await em.find(Product, { where: { name: "widget" } as any });
          expect(live.length).toBe(0);
          const withDeleted: any = await em.find(Product, {
            where: { name: "widget" } as any,
            withDeleted: true,
          } as any);
          expect(withDeleted.length).toBe(1);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });

    it("restore does not revive another tenant's tombstoned rows", async () => {
      const em = await makeEm([Product]);
      try {
        // Both tenants soft-delete their own row.
        await MetadataContext.run("acme", async () => {
          await em.save(Product, { name: "widget", stock: 1 });
          await em.softDelete(Product, { name: "widget" } as any);
        });
        await MetadataContext.run("globex", async () => {
          await em.save(Product, { name: "widget", stock: 2 });
          await em.softDelete(Product, { name: "widget" } as any);
        });

        // acme restores; globex row must remain deleted.
        await MetadataContext.run("acme", async () => {
          await em.restore(Product, { name: "widget" } as any);
        });

        await MetadataContext.run("globex", async () => {
          const live = await em.find(Product, { where: { name: "widget" } as any });
          expect(live.length).toBe(0);
        });
        await MetadataContext.run("acme", async () => {
          const live = await em.find(Product, { where: { name: "widget" } as any });
          expect(live.length).toBe(1);
          expect((live[0] as any).stock).toBe(1);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  // ── runUnscoped escape hatch ───────────────────────────────────────────

  describe("runUnscoped() escape hatch", () => {
    it("unscoped find / count returns rows from all tenants", async () => {
      const em = await makeEm([User]);
      try {
        await seedTwoTenants(em);
        await MetadataContext.run("acme", async () => {
          await MetadataContext.runUnscoped(async () => {
            const all = await em.find(User);
            expect(all.length).toBe(5);
          });
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });

    it("unscoped updateMany touches all tenants (admin escape hatch)", async () => {
      const em = await makeEm([User]);
      try {
        await seedTwoTenants(em);
        await MetadataContext.run("acme", async () => {
          await MetadataContext.runUnscoped(async () => {
            await em.updateMany(
              User,
              { name: "Migrated" } as any,
              { where: { id: { gt: 0 } as any } as any },
            );
          });
        });

        // All 5 rows (both tenants) are renamed.
        const driver = em.getDriver()!;
        const raw: any = await driver.executeRaw(
          "SELECT name FROM user",
        );
        const rows: any[] = Array.isArray(raw)
          ? raw
          : (raw.results ?? raw.rows ?? []);
        expect(rows.length).toBe(5);
        expect(rows.every((r: any) => r.name === "Migrated")).toBe(true);
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });
});
