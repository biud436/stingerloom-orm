/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { DeletedAt } from "../../src/decorators/DeletedAt";
import { NonTenantEntity } from "../../src/decorators/TenantColumn";
import { EntityManager } from "../../src/core/EntityManager";
import { MetadataContext } from "../../src/metadata/MetadataContext";

/**
 * Phase 6 — tenant predicate injection on SelectQueryBuilder (getMany,
 * getCount, exists) with both the chainable `.withoutTenantScope()` opt-out
 * and the FindOption-level `withoutTenantScope: true` escape hatch.
 *
 * Each test constructs an in-memory SQLite EM under `tenant_column` strategy,
 * seeds rows across two tenants, and asserts that queries built through
 * `createQueryBuilder()` are tenant-scoped by default.
 */
describe("SelectQueryBuilder under tenant_column strategy", () => {
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

  @NonTenantEntity()
  @Entity()
  class GlobalTag {
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

  describe("getMany()", () => {
    it("scopes by current tenant", async () => {
      const em = await makeEm([User]);
      try {
        await seedTwoTenants(em);
        await MetadataContext.run("acme", async () => {
          const rows: any[] = await em
            .createQueryBuilder(User, "u")
            .getMany();
          expect(rows.map((r) => r.name).sort()).toEqual(["Alice", "Anna"]);
        });
        await MetadataContext.run("globex", async () => {
          const rows: any[] = await em
            .createQueryBuilder(User, "u")
            .getMany();
          expect(rows.map((r) => r.name).sort()).toEqual([
            "Bea",
            "Bob",
            "Bryan",
          ]);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });

    it("respects user-supplied WHERE in addition to the tenant predicate", async () => {
      const em = await makeEm([User]);
      try {
        await seedTwoTenants(em);
        await MetadataContext.run("globex", async () => {
          const rows: any[] = await em
            .createQueryBuilder(User, "u")
            .where("name", "Alice")
            .getMany();
          // Alice belongs to acme — under globex context, tenant filter must
          // eliminate her even though the WHERE name="Alice" matches.
          expect(rows).toEqual([]);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });

    it("withoutTenantScope() bypasses the tenant predicate", async () => {
      const em = await makeEm([User]);
      try {
        await seedTwoTenants(em);
        await MetadataContext.run("acme", async () => {
          const rows: any[] = await em
            .createQueryBuilder(User, "u")
            .withoutTenantScope()
            .getMany();
          expect(rows.length).toBe(5);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });

    it("runUnscoped() bypasses the tenant predicate on the builder", async () => {
      const em = await makeEm([User]);
      try {
        await seedTwoTenants(em);
        await MetadataContext.run("acme", async () => {
          const rows = await MetadataContext.runUnscoped(() =>
            em.createQueryBuilder(User, "u").getMany(),
          );
          expect(rows.length).toBe(5);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });

    it("@NonTenantEntity queries are unfiltered", async () => {
      const em = await makeEm([GlobalTag]);
      try {
        await em.save(GlobalTag, { slug: "a" });
        await em.save(GlobalTag, { slug: "b" });
        await MetadataContext.run("acme", async () => {
          const rows: any[] = await em
            .createQueryBuilder(GlobalTag, "g")
            .getMany();
          expect(rows.map((r) => r.slug).sort()).toEqual(["a", "b"]);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });

    it("soft-delete predicate and tenant predicate compose correctly", async () => {
      const em = await makeEm([Product]);
      try {
        await MetadataContext.run("acme", async () => {
          await em.save(Product, { name: "widget", stock: 5 });
          await em.save(Product, { name: "gadget", stock: 1 });
          await em.softDelete(Product, { name: "gadget" } as any);
        });
        await MetadataContext.run("globex", async () => {
          await em.save(Product, { name: "widget", stock: 9 });
        });

        await MetadataContext.run("acme", async () => {
          const live: any[] = await em
            .createQueryBuilder(Product, "p")
            .getMany();
          expect(live.map((r) => r.name)).toEqual(["widget"]);

          const all: any[] = await em
            .createQueryBuilder(Product, "p")
            .withDeleted()
            .getMany();
          expect(all.map((r) => r.name).sort()).toEqual(["gadget", "widget"]);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  describe("getCount() / exists()", () => {
    it("getCount() scopes by tenant", async () => {
      const em = await makeEm([User]);
      try {
        await seedTwoTenants(em);
        await MetadataContext.run("acme", async () => {
          const n = await em.createQueryBuilder(User, "u").getCount();
          expect(n).toBe(2);
        });
        await MetadataContext.run("globex", async () => {
          const n = await em.createQueryBuilder(User, "u").getCount();
          expect(n).toBe(3);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });

    it("exists() scopes by tenant", async () => {
      const em = await makeEm([User]);
      try {
        await seedTwoTenants(em);
        await MetadataContext.run("acme", async () => {
          const ex = await em
            .createQueryBuilder(User, "u")
            .where("name", "Bob")
            .exists();
          expect(ex).toBe(false);
        });
        await MetadataContext.run("globex", async () => {
          const ex = await em
            .createQueryBuilder(User, "u")
            .where("name", "Bob")
            .exists();
          expect(ex).toBe(true);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });

    it("withoutTenantScope() applies to getCount and exists", async () => {
      const em = await makeEm([User]);
      try {
        await seedTwoTenants(em);
        await MetadataContext.run("acme", async () => {
          const total = await em
            .createQueryBuilder(User, "u")
            .withoutTenantScope()
            .getCount();
          expect(total).toBe(5);

          const hasBob = await em
            .createQueryBuilder(User, "u")
            .withoutTenantScope()
            .where("name", "Bob")
            .exists();
          expect(hasBob).toBe(true);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  describe("FindOption.withoutTenantScope", () => {
    it("em.find({ withoutTenantScope: true }) returns rows from all tenants", async () => {
      const em = await makeEm([User]);
      try {
        await seedTwoTenants(em);
        await MetadataContext.run("acme", async () => {
          const rows: any[] = await em.find(User, {
            withoutTenantScope: true,
          } as any);
          expect(rows.length).toBe(5);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });

    it("em.find({}) without the flag remains tenant-scoped", async () => {
      const em = await makeEm([User]);
      try {
        await seedTwoTenants(em);
        await MetadataContext.run("acme", async () => {
          const rows: any[] = await em.find(User);
          expect(rows.length).toBe(2);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });

    it("findWithCursor({ withoutTenantScope: true }) crosses tenants", async () => {
      const em = await makeEm([User]);
      try {
        await seedTwoTenants(em);
        await MetadataContext.run("acme", async () => {
          const page = await em.findWithCursor(User, {
            take: 10,
            withoutTenantScope: true,
          } as any);
          expect(page.data.length).toBe(5);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  describe("clone() preserves withoutTenantScope flag", () => {
    it("a cloned builder inherits the opt-out", async () => {
      const em = await makeEm([User]);
      try {
        await seedTwoTenants(em);
        await MetadataContext.run("acme", async () => {
          const base = em
            .createQueryBuilder(User, "u")
            .withoutTenantScope();
          const rows: any[] = await base.clone().getMany();
          expect(rows.length).toBe(5);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });
});
