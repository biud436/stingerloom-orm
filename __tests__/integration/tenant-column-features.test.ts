/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * tenant_column strategy × feature matrix on real database servers
 * (MySQL + PostgreSQL).
 *
 * Mirrors the SQLite suite (`__tests__/integration/sqlite/tenant-column-features.test.ts`)
 * for the subset of scenarios where a real engine adds confidence beyond what
 * an in-memory single-connection DB can show:
 *
 *   1. Aggregates (sum/avg) — verifies dialect-specific WHERE injection
 *   2. Soft delete + withDeleted — NOW()/datetime() expression per dialect
 *   3. Restore is tenant-scoped on real DDL
 *   4. updateMany / deleteMany under real pool
 *   5. Transaction commit/rollback isolation per tenant
 *   6. Query builder where + orderBy intersect with tenant predicate
 *   7. Concurrent writes from two tenants don't leak (real pool)
 *
 * Runs only under INTEGRATION_TEST=true.
 * Disable individual dialects with INTEGRATION_TEST_MYSQL=false /
 * INTEGRATION_TEST_POSTGRES=false.
 */

import "reflect-metadata";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { DeletedAt } from "../../src/decorators/DeletedAt";
import { EntityManager } from "../../src/core/EntityManager";
import { MetadataContext } from "../../src/metadata/MetadataContext";
import {
  createTestConnection,
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
  invoice: "tcfx_invoice",
  post: "tcfx_post",
  user: "tcfx_user",
  item: "tcfx_item",
} as const;

describe.each(drivers)(
  "[Integration][$label] tenant_column × feature matrix",
  ({ options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let InvoiceE: any;
    let PostE: any;
    let UserE: any;
    let ItemE: any;

    beforeAll(async () => {
      conn = await createTestConnection(
        {
          ...options,
          synchronize: true,
          logging: false,
          tenantStrategy: "tenant_column",
        },
        () => {
          @Entity({ name: TABLES.invoice })
          class Invoice {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "int" }) amount!: number;
          }
          @Entity({ name: TABLES.post })
          class Post {
            @PrimaryGeneratedColumn() id!: number;
            @Column() title!: string;
            @DeletedAt() deletedAt!: Date | null;
          }
          @Entity({ name: TABLES.user })
          class User {
            @PrimaryGeneratedColumn() id!: number;
            @Column() name!: string;
            @Column() status!: string;
          }
          @Entity({ name: TABLES.item })
          class Item {
            @PrimaryGeneratedColumn() id!: number;
            @Column() name!: string;
            @Column({ type: "int" }) price!: number;
          }
          InvoiceE = Invoice;
          PostE = Post;
          UserE = User;
          ItemE = Item;
          return { entities: [Invoice, Post, User, Item] };
        },
      );
      em = conn.em;
    }, 60000);

    afterAll(async () => {
      for (const t of Object.values(TABLES)) {
        try {
          await dropTestTable(t);
        } catch {
          /* ignore */
        }
      }
      await conn.cleanup();
    }, 30000);

    beforeEach(async () => {
      MetadataContext.reset();
      for (const t of Object.values(TABLES)) {
        try {
          await truncateTestTable(t);
        } catch {
          /* ignore */
        }
      }
    });

    // ─────────────────────────────────────────────────────
    it("aggregates: sum/avg/count are tenant-scoped on the real engine", async () => {
      await MetadataContext.run("acme", async () => {
        for (const a of [10, 20, 30]) await em.save(InvoiceE, { amount: a });
      });
      await MetadataContext.run("globex", async () => {
        for (const a of [100, 200]) await em.save(InvoiceE, { amount: a });
      });

      await MetadataContext.run("acme", async () => {
        expect(await em.count(InvoiceE)).toBe(3);
        expect(Number(await em.sum(InvoiceE, "amount"))).toBe(60);
        expect(Number(await em.avg(InvoiceE, "amount"))).toBe(20);
      });
      await MetadataContext.run("globex", async () => {
        expect(await em.count(InvoiceE)).toBe(2);
        expect(Number(await em.sum(InvoiceE, "amount"))).toBe(300);
      });
    });

    // ─────────────────────────────────────────────────────
    it("softDelete uses dialect NOW() and is tenant-scoped", async () => {
      await MetadataContext.run("acme", async () => {
        await em.save(PostE, { title: "shared" });
      });
      await MetadataContext.run("globex", async () => {
        await em.save(PostE, { title: "shared" });
      });

      await MetadataContext.run("acme", async () => {
        await em.softDelete(PostE, { title: "shared" } as any);
        expect((await em.find(PostE)).length).toBe(0);
        const all = (await em.find(PostE, {
          withDeleted: true,
        } as any)) as any[];
        expect(all.length).toBe(1);
        expect(all[0].deletedAt).toBeTruthy();
      });
      await MetadataContext.run("globex", async () => {
        const live = await em.find(PostE);
        expect(live.length).toBe(1);
      });
    });

    it("restore() on tenant A only revives that tenant's deleted rows", async () => {
      await MetadataContext.run("acme", async () => {
        const a: any = await em.save(PostE, { title: "restore-me" });
        await em.softDelete(PostE, { id: a.id } as any);
      });
      await MetadataContext.run("globex", async () => {
        const g: any = await em.save(PostE, { title: "restore-me" });
        await em.softDelete(PostE, { id: g.id } as any);
      });

      await MetadataContext.run("acme", async () => {
        await em.restore(PostE, { title: "restore-me" } as any);
        expect((await em.find(PostE)).length).toBe(1);
      });
      await MetadataContext.run("globex", async () => {
        // globex's row is still soft-deleted.
        expect((await em.find(PostE)).length).toBe(0);
      });
    });

    // ─────────────────────────────────────────────────────
    it("updateMany under tenant A leaves tenant B unchanged on real DB", async () => {
      await MetadataContext.run("acme", async () => {
        await em.save(UserE, { name: "u1", status: "pending" });
        await em.save(UserE, { name: "u2", status: "pending" });
      });
      await MetadataContext.run("globex", async () => {
        await em.save(UserE, { name: "u3", status: "pending" });
      });

      await MetadataContext.run("acme", async () => {
        await em.updateMany(
          UserE,
          { status: "done" } as any,
          { where: { status: "pending" } as any },
        );
        const all = (await em.find(UserE)) as any[];
        expect(all.every((r) => r.status === "done")).toBe(true);
      });
      await MetadataContext.run("globex", async () => {
        const all = (await em.find(UserE)) as any[];
        expect(all.every((r) => r.status === "pending")).toBe(true);
      });
    });

    // ─────────────────────────────────────────────────────
    it("transaction commit only persists rows under the active tenant", async () => {
      await MetadataContext.run("acme", () =>
        em.transaction(async (tx) => {
          await tx.save(UserE, { name: "tx-1", status: "x" });
          await tx.save(UserE, { name: "tx-2", status: "x" });
        }),
      );
      await MetadataContext.run("acme", async () => {
        expect(await em.count(UserE)).toBe(2);
      });
      await MetadataContext.run("globex", async () => {
        expect(await em.count(UserE)).toBe(0);
      });
    });

    it("transaction rollback leaves no rows for the active tenant", async () => {
      await MetadataContext.run("acme", async () => {
        await expect(
          em.transaction(async (tx) => {
            await tx.save(UserE, { name: "doomed", status: "x" });
            throw new Error("boom");
          }),
        ).rejects.toThrow("boom");
        expect(await em.count(UserE)).toBe(0);
      });
    });

    // ─────────────────────────────────────────────────────
    it("query builder where + orderBy intersect with tenant predicate", async () => {
      await MetadataContext.run("acme", async () => {
        await em.save(ItemE, { name: "a", price: 100 });
        await em.save(ItemE, { name: "b", price: 200 });
        await em.save(ItemE, { name: "c", price: 300 });
      });
      await MetadataContext.run("globex", async () => {
        await em.save(ItemE, { name: "g", price: 999 });
      });

      await MetadataContext.run("acme", async () => {
        const qb = em.createQueryBuilder(ItemE, "i");
        const rows: any[] = await qb
          .where("price", ">", 100)
          .orderBy({ price: "DESC" } as any)
          .getMany();
        expect(rows.map((r) => r.name)).toEqual(["c", "b"]);
      });

      await MetadataContext.run("acme", async () => {
        const qb = em.createQueryBuilder(ItemE, "i");
        const rows = await qb.where("price", 999).getMany();
        expect(rows).toEqual([]);
      });
    });

    // ─────────────────────────────────────────────────────
    it("concurrent writes from multiple tenants stay isolated under real pool", async () => {
      // Real driver has a connection pool — these execute in parallel
      // sessions, exercising AsyncLocalStorage propagation across awaits.
      const tags = ["alpha", "beta", "gamma"] as const;
      await Promise.all(
        tags.map((tag) =>
          MetadataContext.run(`real-${tag}`, async () => {
            for (let i = 0; i < 5; i++) {
              await em.save(InvoiceE, { amount: i + 1 });
            }
          }),
        ),
      );

      for (const tag of tags) {
        await MetadataContext.run(`real-${tag}`, async () => {
          expect(await em.count(InvoiceE)).toBe(5);
          expect(Number(await em.sum(InvoiceE, "amount"))).toBe(1 + 2 + 3 + 4 + 5);
        });
      }
    });
  },
);

if (!INTEGRATION) {
  describe.skip("[Integration] tenant_column features — skipped (set INTEGRATION_TEST=true)", () => {
    it("is disabled", () => {
      /* no-op */
    });
  });
}
