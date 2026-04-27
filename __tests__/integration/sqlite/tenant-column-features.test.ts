/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * tenant_column strategy × ORM feature combinations (SQLite :memory:).
 *
 * The base end-to-end suite (sqlite/tenant-column.test.ts) covers the 10
 * baseline scenarios from the original plan (DDL, CRUD, PK collision,
 * MISSING/MISMATCH, NonTenant, runUnscoped, eager load, raw warning,
 * concurrency). Issue #270 asks for additional coverage exercising the
 * strategy alongside other ORM features. This file pairs tenant_column
 * with: aggregates, soft delete + restore, repository pattern, batch /
 * upsert / insertMany, query builder, transactions, lifecycle events
 * (on/off + EntitySubscriber), the buffer plugin, and updateMany /
 * deleteMany / count + exists.
 *
 * Each test creates a fresh isolated in-memory DB (no shared state between
 * tests). Concurrency-sensitive features (real pools) are exercised in the
 * MySQL/PG mirror (`__tests__/integration/tenant-column-features.test.ts`).
 */

import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../../src/decorators/ManyToOne";
import { OneToMany } from "../../../src/decorators/OneToMany";
import { DeletedAt } from "../../../src/decorators/DeletedAt";
import { CreateTimestamp } from "../../../src/decorators/CreateTimestamp";
import { UpdateTimestamp } from "../../../src/decorators/UpdateTimestamp";
import {
  NonTenantEntity,
  TenantColumn,
} from "../../../src/decorators/TenantColumn";
import { EntityManager } from "../../../src/core/EntityManager";
import { MetadataContext } from "../../../src/metadata/MetadataContext";
import { OrmErrorCode } from "../../../src/errors/OrmErrorCode";
import { bufferPlugin } from "../../../src/core/plugin/buffer/bufferPlugin";
import type {
  EntityEventListener,
  EntityEventType,
} from "../../../src/core/EntityEventEmitter";
import { EntitySubscriber } from "../../../src/core/EntitySubscriber";

async function makeEm(entities: any[], opts: Record<string, any> = {}) {
  const em = new EntityManager();
  await em.register(
    {
      type: "sqlite",
      database: ":memory:",
      entities,
      synchronize: true,
      tenantStrategy: "tenant_column",
      logging: false,
      ...opts,
    },
    `tcf_${Math.random().toString(36).slice(2, 10)}`,
  );
  return em;
}

describe("[Integration] SQLite: tenant_column × feature matrix", () => {
  beforeEach(() => MetadataContext.reset());

  // ─────────────────────────────────────────────────────────
  // 1. Aggregates (count, sum, avg, min, max, exists)
  // ─────────────────────────────────────────────────────────
  describe("aggregates respect tenant scope", () => {
    @Entity({ name: "tcf_invoice" })
    class Invoice {
      @PrimaryGeneratedColumn() id!: number;
      @Column({ type: "int" }) amount!: number;
    }

    let em: EntityManager;
    beforeEach(async () => {
      em = await makeEm([Invoice]);
      await MetadataContext.run("acme", async () => {
        for (const a of [10, 20, 30]) await em.save(Invoice, { amount: a });
      });
      await MetadataContext.run("globex", async () => {
        for (const a of [100, 200]) await em.save(Invoice, { amount: a });
      });
    });
    afterEach(async () => {
      await em.propagateShutdown({ closeConnections: true });
    });

    it("count/sum/avg/min/max all reflect only the active tenant", async () => {
      await MetadataContext.run("acme", async () => {
        expect(await em.count(Invoice)).toBe(3);
        expect(await em.sum(Invoice, "amount")).toBe(60);
        expect(await em.avg(Invoice, "amount")).toBe(20);
        expect(await em.min(Invoice, "amount")).toBe(10);
        expect(await em.max(Invoice, "amount")).toBe(30);
      });
      await MetadataContext.run("globex", async () => {
        expect(await em.count(Invoice)).toBe(2);
        expect(await em.sum(Invoice, "amount")).toBe(300);
      });
    });

    it("exists() is tenant-scoped", async () => {
      // amount=100 only exists in globex.
      await MetadataContext.run("acme", async () => {
        expect(await em.exists(Invoice, { amount: 100 } as any)).toBe(false);
        expect(await em.exists(Invoice, { amount: 10 } as any)).toBe(true);
      });
      await MetadataContext.run("globex", async () => {
        expect(await em.exists(Invoice, { amount: 100 } as any)).toBe(true);
        expect(await em.exists(Invoice, { amount: 10 } as any)).toBe(false);
      });
    });
  });

  // ─────────────────────────────────────────────────────────
  // 2. Soft delete + restore + withDeleted
  // ─────────────────────────────────────────────────────────
  describe("@DeletedAt soft delete is tenant-scoped", () => {
    @Entity({ name: "tcf_post" })
    class Post {
      @PrimaryGeneratedColumn() id!: number;
      @Column() title!: string;
      @DeletedAt() deletedAt!: Date | null;
    }

    let em: EntityManager;
    beforeEach(async () => {
      em = await makeEm([Post]);
    });
    afterEach(async () => {
      await em.propagateShutdown({ closeConnections: true });
    });

    it("softDelete on tenant A leaves tenant B's identical title intact", async () => {
      await MetadataContext.run("acme", async () => {
        await em.save(Post, { title: "shared-title" });
      });
      await MetadataContext.run("globex", async () => {
        await em.save(Post, { title: "shared-title" });
      });

      // acme soft-deletes its row by title; globex's row must be untouched.
      await MetadataContext.run("acme", async () => {
        await em.softDelete(Post, { title: "shared-title" } as any);
        const live = await em.find(Post);
        expect(live.length).toBe(0);
        const all = await em.find(Post, { withDeleted: true } as any);
        expect(all.length).toBe(1);
        expect((all[0] as any).deletedAt).toBeTruthy();
      });
      await MetadataContext.run("globex", async () => {
        const live = await em.find(Post);
        expect(live.length).toBe(1);
        expect((live[0] as any).deletedAt).toBeNull();
      });
    });

    it("restore() under tenant A only revives that tenant's deleted row", async () => {
      await MetadataContext.run("acme", async () => {
        const a: any = await em.save(Post, { title: "restore-me" });
        await em.softDelete(Post, { id: a.id } as any);
      });
      await MetadataContext.run("globex", async () => {
        const g: any = await em.save(Post, { title: "restore-me" });
        await em.softDelete(Post, { id: g.id } as any);
      });

      // globex tries to restore by title — must not bring back acme's row.
      await MetadataContext.run("globex", async () => {
        await em.restore(Post, { title: "restore-me" } as any);
        const live = await em.find(Post);
        expect(live.length).toBe(1);
      });
      await MetadataContext.run("acme", async () => {
        // acme's row stays deleted.
        const live = await em.find(Post);
        expect(live.length).toBe(0);
      });
    });
  });

  // ─────────────────────────────────────────────────────────
  // 3. Repository pattern
  // ─────────────────────────────────────────────────────────
  describe("getRepository() inherits tenant scoping", () => {
    @Entity({ name: "tcf_widget" })
    class Widget {
      @PrimaryGeneratedColumn() id!: number;
      @Column() name!: string;
    }

    it("repo.find / repo.save / repo.count are scoped per tenant", async () => {
      const em = await makeEm([Widget]);
      try {
        const repo = em.getRepository(Widget);
        await MetadataContext.run("acme", async () => {
          await repo.save({ name: "w-a-1" } as any);
          await repo.save({ name: "w-a-2" } as any);
        });
        await MetadataContext.run("globex", async () => {
          await repo.save({ name: "w-g-1" } as any);
        });
        await MetadataContext.run("acme", async () => {
          const rows = await repo.find();
          expect(rows.length).toBe(2);
          expect(await repo.count()).toBe(2);
        });
        await MetadataContext.run("globex", async () => {
          expect(await repo.count()).toBe(1);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  // 4. insertMany / saveMany / batchUpsert
  // ─────────────────────────────────────────────────────────
  describe("batch writes inject tenant on every row", () => {
    @Entity({ name: "tcf_event" })
    class Event {
      @PrimaryGeneratedColumn() id!: number;
      @Column() kind!: string;
      @Column({ type: "int" }) seq!: number;
    }

    it("insertMany + saveMany rows land under the active tenant only", async () => {
      const em = await makeEm([Event]);
      try {
        await MetadataContext.run("acme", async () => {
          await em.insertMany(Event, [
            { kind: "click", seq: 1 },
            { kind: "click", seq: 2 },
            { kind: "submit", seq: 3 },
          ] as any);
        });
        await MetadataContext.run("globex", async () => {
          await em.saveMany(Event, [
            { kind: "click", seq: 10 },
            { kind: "click", seq: 11 },
          ] as any);
        });
        await MetadataContext.run("acme", async () => {
          expect(await em.count(Event)).toBe(3);
          expect(await em.count(Event, { kind: "click" } as any)).toBe(2);
        });
        await MetadataContext.run("globex", async () => {
          expect(await em.count(Event)).toBe(2);
          expect(await em.sum(Event, "seq")).toBe(21);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  // 5. Query builder
  // ─────────────────────────────────────────────────────────
  describe("createQueryBuilder respects tenant scope", () => {
    @Entity({ name: "tcf_item" })
    class Item {
      @PrimaryGeneratedColumn() id!: number;
      @Column() name!: string;
      @Column({ type: "int" }) price!: number;
    }

    it("getMany / orderBy / where filters are intersected with tenant predicate", async () => {
      const em = await makeEm([Item]);
      try {
        await MetadataContext.run("acme", async () => {
          await em.save(Item, { name: "a", price: 100 });
          await em.save(Item, { name: "b", price: 200 });
          await em.save(Item, { name: "c", price: 300 });
        });
        await MetadataContext.run("globex", async () => {
          await em.save(Item, { name: "d", price: 999 });
        });

        await MetadataContext.run("acme", async () => {
          const qb = em.createQueryBuilder(Item, "i");
          const rows: any[] = await qb
            .where("price", ">", 100)
            .orderBy({ price: "DESC" } as any)
            .getMany();
          expect(rows.map((r) => r.name)).toEqual(["c", "b"]);
        });

        // Even WHERE that matches globex's row must yield nothing under acme.
        await MetadataContext.run("acme", async () => {
          const qb = em.createQueryBuilder(Item, "i");
          const rows: any[] = await qb.where("price", 999).getMany();
          expect(rows).toEqual([]);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  // 6. Transactions
  // ─────────────────────────────────────────────────────────
  describe("em.transaction() preserves tenant scope across statements", () => {
    @Entity({ name: "tcf_txn_user" })
    class TxnUser {
      @PrimaryGeneratedColumn() id!: number;
      @Column() name!: string;
    }

    it("commit makes rows visible only to the tenant that wrote them", async () => {
      const em = await makeEm([TxnUser]);
      try {
        await MetadataContext.run("acme", async () => {
          await em.transaction(async (tx) => {
            await tx.save(TxnUser, { name: "tx-a-1" });
            await tx.save(TxnUser, { name: "tx-a-2" });
          });
        });
        await MetadataContext.run("globex", async () => {
          expect(await em.count(TxnUser)).toBe(0);
        });
        await MetadataContext.run("acme", async () => {
          expect(await em.count(TxnUser)).toBe(2);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });

    it("rollback leaves no rows visible under the tenant", async () => {
      const em = await makeEm([TxnUser]);
      try {
        await MetadataContext.run("acme", async () => {
          await expect(
            em.transaction(async (tx) => {
              await tx.save(TxnUser, { name: "won't survive" });
              throw new Error("boom");
            }),
          ).rejects.toThrow("boom");
          expect(await em.count(TxnUser)).toBe(0);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  // 7. Lifecycle events: on/off
  // ─────────────────────────────────────────────────────────
  describe("on()/off() listeners observe per-tenant writes", () => {
    @Entity({ name: "tcf_event_user" })
    class EvUser {
      @PrimaryGeneratedColumn() id!: number;
      @Column() name!: string;
    }

    it("beforeInsert fires once per save and sees the actual entity", async () => {
      const em = await makeEm([EvUser]);
      try {
        const seen: Array<{ ev: EntityEventType; name: string }> = [];
        const listener: EntityEventListener = (p) => {
          seen.push({
            ev: "beforeInsert",
            name: (p.data as any).name,
          });
        };
        em.on("beforeInsert", listener);
        try {
          await MetadataContext.run("acme", () =>
            em.save(EvUser, { name: "first" }),
          );
          await MetadataContext.run("globex", () =>
            em.save(EvUser, { name: "second" }),
          );
        } finally {
          em.off("beforeInsert", listener);
        }
        // off() must stop further events.
        await MetadataContext.run("acme", () =>
          em.save(EvUser, { name: "third" }),
        );
        expect(seen).toEqual([
          { ev: "beforeInsert", name: "first" },
          { ev: "beforeInsert", name: "second" },
        ]);
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  // 8. EntitySubscriber
  // ─────────────────────────────────────────────────────────
  describe("EntitySubscriber observes inserts per tenant", () => {
    @Entity({ name: "tcf_sub_user" })
    class SubUser {
      @PrimaryGeneratedColumn() id!: number;
      @Column() name!: string;
    }

    it("afterInsert event fires for each tenant write", async () => {
      const em = await makeEm([SubUser]);
      const seen: string[] = [];
      const sub: EntitySubscriber<SubUser> = {
        listenTo: () => SubUser,
        afterInsert: async (event: { entity: Partial<SubUser> }) => {
          seen.push((event.entity as any).name);
        },
      } as any;
      em.addSubscriber(sub);
      try {
        await MetadataContext.run("acme", () =>
          em.save(SubUser, { name: "from-acme" }),
        );
        await MetadataContext.run("globex", () =>
          em.save(SubUser, { name: "from-globex" }),
        );
        expect(seen.sort()).toEqual(["from-acme", "from-globex"]);
      } finally {
        em.removeSubscriber(sub);
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  // 9. Buffer plugin (Unit of Work) under tenant context
  // ─────────────────────────────────────────────────────────
  describe("bufferPlugin flush under tenant_column", () => {
    @Entity({ name: "tcf_buf_user" })
    class BufUser {
      @PrimaryGeneratedColumn() id!: number;
      @Column() name!: string;
    }

    it("rows flushed inside MetadataContext.run land under that tenant", async () => {
      const em = await makeEm([BufUser]);
      em.extend(bufferPlugin());
      const newBufUser = (name: string): BufUser =>
        Object.assign(Object.create(BufUser.prototype), { name });
      try {
        await MetadataContext.run("acme", async () => {
          const buf = em.buffer();
          buf.persist(newBufUser("buf-a-1"));
          buf.persist(newBufUser("buf-a-2"));
          await buf.flush();
        });
        await MetadataContext.run("globex", async () => {
          const buf = em.buffer();
          buf.persist(newBufUser("buf-g-1"));
          await buf.flush();
        });
        await MetadataContext.run("acme", async () => {
          const rows = await em.find(BufUser);
          expect(rows.map((r: any) => r.name).sort()).toEqual([
            "buf-a-1",
            "buf-a-2",
          ]);
        });
        await MetadataContext.run("globex", async () => {
          const rows = await em.find(BufUser);
          expect(rows.map((r: any) => r.name)).toEqual(["buf-g-1"]);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  // 10. updateMany / deleteMany are tenant-scoped
  // ─────────────────────────────────────────────────────────
  describe("updateMany / deleteMany restrict effects to active tenant", () => {
    @Entity({ name: "tcf_um_user" })
    class UmUser {
      @PrimaryGeneratedColumn() id!: number;
      @Column() status!: string;
    }

    it("updateMany under tenant A leaves tenant B rows unchanged", async () => {
      const em = await makeEm([UmUser]);
      try {
        await MetadataContext.run("acme", async () => {
          await em.save(UmUser, { status: "pending" });
          await em.save(UmUser, { status: "pending" });
        });
        await MetadataContext.run("globex", async () => {
          await em.save(UmUser, { status: "pending" });
        });

        await MetadataContext.run("acme", async () => {
          await em.updateMany(
            UmUser,
            { status: "done" } as any,
            { where: { status: "pending" } as any },
          );
          const all = await em.find(UmUser);
          expect(all.every((r: any) => r.status === "done")).toBe(true);
        });
        await MetadataContext.run("globex", async () => {
          const all = await em.find(UmUser);
          expect(all.every((r: any) => r.status === "pending")).toBe(true);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });

    it("delete with WHERE never crosses tenants", async () => {
      const em = await makeEm([UmUser]);
      try {
        await MetadataContext.run("acme", async () => {
          await em.save(UmUser, { status: "stale" });
        });
        await MetadataContext.run("globex", async () => {
          await em.save(UmUser, { status: "stale" });
        });
        await MetadataContext.run("acme", async () => {
          await em.delete(UmUser, { status: "stale" } as any);
          expect(await em.count(UmUser)).toBe(0);
        });
        await MetadataContext.run("globex", async () => {
          expect(await em.count(UmUser)).toBe(1);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  // 11. @CreateTimestamp / @UpdateTimestamp populate without leaking tenant
  // ─────────────────────────────────────────────────────────
  describe("@CreateTimestamp + @UpdateTimestamp + @TenantColumn coexist", () => {
    @Entity({ name: "tcf_ts_user" })
    class TsUser {
      @PrimaryGeneratedColumn() id!: number;
      @Column() name!: string;
      @CreateTimestamp() createdAt!: Date;
      @UpdateTimestamp() updatedAt!: Date;
      @TenantColumn() tenantId!: string;
    }

    it("INSERT auto-fills timestamps and tenantId from context", async () => {
      const em = await makeEm([TsUser]);
      try {
        const saved = await MetadataContext.run("acme", () =>
          em.save(TsUser, { name: "alice" } as any),
        );
        expect((saved as any).createdAt).toBeTruthy();
        expect((saved as any).updatedAt).toBeTruthy();
        expect((saved as any).tenantId).toBe("acme");
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });

    it("supplying mismatched tenantId on insert is rejected even with @CreateTimestamp present", async () => {
      const em = await makeEm([TsUser]);
      try {
        await expect(
          MetadataContext.run("acme", () =>
            em.save(TsUser, {
              name: "ghost",
              tenantId: "globex",
            } as any),
          ),
        ).rejects.toMatchObject({ code: OrmErrorCode.TENANT_MISMATCH });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  // 12. ManyToOne / OneToMany relation scoping
  // ─────────────────────────────────────────────────────────
  describe("relations stay tenant-scoped on both sides", () => {
    @Entity({ name: "tcf_author" })
    class Author {
      @PrimaryGeneratedColumn() id!: number;
      @Column() name!: string;
      @OneToMany(() => Book, { mappedBy: "author" })
      books!: Book[];
    }
    @Entity({ name: "tcf_book" })
    class Book {
      @PrimaryGeneratedColumn() id!: number;
      @Column() title!: string;
      @Column({ type: "int", nullable: true })
      authorId!: number | null;
      @ManyToOne(() => Author, (a: any) => a.books, {
        joinColumn: "authorId",
        createForeignKeyConstraints: false,
      })
      author!: Author;
    }

    it("loading the inverse side under one tenant never leaks the other tenant's children", async () => {
      const em = await makeEm([Author, Book]);
      try {
        const acmeId = await MetadataContext.run("acme", async () => {
          const a: any = await em.save(Author, { name: "shared-name" });
          await em.save(Book, { title: "a-1", authorId: a.id });
          await em.save(Book, { title: "a-2", authorId: a.id });
          return a.id;
        });
        await MetadataContext.run("globex", async () => {
          const g: any = await em.save(Author, { name: "shared-name" });
          await em.save(Book, { title: "g-1", authorId: g.id });
        });

        await MetadataContext.run("acme", async () => {
          const author: any = await em.findOne(Author, {
            where: { id: acmeId } as any,
            relations: ["books"],
          } as any);
          expect(author).not.toBeNull();
          expect(author!.books.length).toBe(2);
          expect(author!.books.map((b: any) => b.title).sort()).toEqual([
            "a-1",
            "a-2",
          ]);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  // 13. NonTenantEntity cohabits with scoped entities in one EM
  // ─────────────────────────────────────────────────────────
  describe("@NonTenantEntity rows cross-tenant readable, scoped entities still isolated", () => {
    @NonTenantEntity()
    @Entity({ name: "tcf_country" })
    class Country {
      @PrimaryGeneratedColumn() id!: number;
      @Column() code!: string;
    }
    @Entity({ name: "tcf_customer" })
    class Customer {
      @PrimaryGeneratedColumn() id!: number;
      @Column() name!: string;
    }

    it("Country reads identical from every tenant; Customer is isolated", async () => {
      const em = await makeEm([Country, Customer]);
      try {
        // Seed countries without context — NonTenantEntity is unscoped.
        await em.save(Country, { code: "KR" });
        await em.save(Country, { code: "US" });
        // Seed customers per tenant.
        await MetadataContext.run("acme", () =>
          em.save(Customer, { name: "a-cust" }),
        );
        await MetadataContext.run("globex", () =>
          em.save(Customer, { name: "g-cust" }),
        );
        // Both tenants see all 2 countries…
        await MetadataContext.run("acme", async () => {
          expect((await em.find(Country)).length).toBe(2);
          expect((await em.find(Customer)).map((c: any) => c.name)).toEqual([
            "a-cust",
          ]);
        });
        await MetadataContext.run("globex", async () => {
          expect((await em.find(Country)).length).toBe(2);
          expect((await em.find(Customer)).map((c: any) => c.name)).toEqual([
            "g-cust",
          ]);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });
});
