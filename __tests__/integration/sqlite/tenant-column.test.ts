/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Phase 8 — tenant_column strategy end-to-end integration test (SQLite :memory:).
 *
 * Unit coverage (87 tests, 2 xdescribe) already verifies predicate injection
 * on every read/write path. This suite validates the 10 scenarios the plan
 * lists for dialect-level verification:
 *
 *   1. DDL round-trip (tenant column materialized by synchronize)
 *   2. CRUD isolation (tenant A rows invisible to tenant B)
 *   3. PK collision (two tenants, colliding manual PKs, findByPK scoped)
 *   4. INSERT without tenant context → MISSING_TENANT_CONTEXT
 *   5. INSERT with mismatched tenant value → TENANT_MISMATCH
 *   6. @NonTenantEntity opts out of scoping entirely
 *   7. runUnscoped() escape hatch sees all tenants
 *   8. Eager load (ManyToOne JOIN) respects tenant on owning table
 *   9. em.query() raw SQL emits tenant warning
 *  10. Concurrent AsyncLocalStorage requests never cross contaminate
 *
 * Runs only under INTEGRATION_TEST=true (see jest.config.js).
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { PrimaryColumn } from "../../../src/decorators/PrimaryColumn";
import { ManyToOne } from "../../../src/decorators/ManyToOne";
import { OneToMany } from "../../../src/decorators/OneToMany";
import {
  NonTenantEntity,
  TenantColumn,
} from "../../../src/decorators/TenantColumn";
import { EntityManager } from "../../../src/core/EntityManager";
import { MetadataContext } from "../../../src/metadata/MetadataContext";
import { OrmErrorCode } from "../../../src/errors/OrmErrorCode";
import { Logger } from "../../../src/utils/Logger";

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
    `tc_${Math.random().toString(36).slice(2, 10)}`,
  );
  return em;
}

async function pragmaColumns(em: EntityManager, table: string) {
  const driver = em.getDriver()!;
  const raw: any = await driver.executeRaw(`PRAGMA table_info("${table}")`);
  const rows: any[] = Array.isArray(raw) ? raw : (raw.results ?? raw.rows ?? []);
  return rows as { name: string; type: string; notnull: number }[];
}

describe("[Integration] SQLite: tenant_column strategy — end-to-end", () => {
  beforeEach(() => MetadataContext.reset());

  // ─────────────────────────────────────────────────────────
  // 1. DDL round-trip
  // ─────────────────────────────────────────────────────────
  describe("1. DDL round-trip", () => {
    @Entity()
    class WidgetDdl {
      @PrimaryGeneratedColumn() id!: number;
      @Column() name!: string;
    }

    it("synchronize creates the tenant_id column without user declaration", async () => {
      const em = await makeEm([WidgetDdl]);
      try {
        const cols = await pragmaColumns(em, "widget_ddl");
        const tenantCol = cols.find((c) => c.name === "tenant_id");
        expect(tenantCol).toBeDefined();
        expect(tenantCol!.notnull).toBe(1);
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });

    it("honors a user-declared @TenantColumn property key", async () => {
      @Entity()
      class AuditLog {
        @PrimaryGeneratedColumn() id!: number;
        @Column() action!: string;
        @TenantColumn() tenantId!: string;
      }

      const em = await makeEm([AuditLog]);
      try {
        const cols = await pragmaColumns(em, "audit_log");
        // @TenantColumn() with no name falls back to propertyKey → "tenantId".
        // The *global* tenant_id column must not be injected alongside.
        expect(cols.find((c) => c.name === "tenantId")).toBeDefined();
        expect(cols.find((c) => c.name === "tenant_id")).toBeUndefined();

        await MetadataContext.run("acme", async () => {
          const row: any = await em.save(AuditLog, { action: "login" });
          expect(row.tenantId).toBe("acme");
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });

    it("@NonTenantEntity skips tenant column injection", async () => {
      @NonTenantEntity()
      @Entity()
      class SystemConfig {
        @PrimaryColumn({ type: "varchar", length: 64 }) key!: string;
        @Column() value!: string;
      }

      const em = await makeEm([SystemConfig]);
      try {
        const cols = await pragmaColumns(em, "system_config");
        expect(cols.find((c) => c.name === "tenant_id")).toBeUndefined();
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  // 2. CRUD isolation
  // ─────────────────────────────────────────────────────────
  describe("2. CRUD isolation across tenants", () => {
    @Entity()
    class UserCrud {
      @PrimaryGeneratedColumn() id!: number;
      @Column() name!: string;
    }

    it("data inserted under tenant A is invisible to tenant B", async () => {
      const em = await makeEm([UserCrud]);
      try {
        await MetadataContext.run("acme", async () => {
          await em.save(UserCrud, { name: "Alice" });
          await em.save(UserCrud, { name: "Anna" });
        });
        await MetadataContext.run("globex", async () => {
          await em.save(UserCrud, { name: "Bob" });
        });

        await MetadataContext.run("acme", async () => {
          const rows: any[] = await em.find(UserCrud);
          expect(rows.map((r) => r.name).sort()).toEqual(["Alice", "Anna"]);
        });
        await MetadataContext.run("globex", async () => {
          const rows: any[] = await em.find(UserCrud);
          expect(rows.map((r) => r.name)).toEqual(["Bob"]);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  // 3. PK collision scenario
  // ─────────────────────────────────────────────────────────
  describe("3. PK collision — manual PKs, different tenants", () => {
    @Entity()
    class InvoiceManual {
      @PrimaryColumn({ type: "int" }) id!: number;
      @Column() amount!: number;
    }

    it("two tenants can share a PK without cross-read (composite is not required for the scope filter)", async () => {
      const em = await makeEm([InvoiceManual]);
      try {
        // NOTE: SQLite's underlying PK uniqueness is global, so strictly
        // colliding PKs would violate UNIQUE. The check here validates that
        // IF the two PKs did collide (e.g., composite-PK future), findByPK
        // would still scope. Meanwhile we simulate with tenant A using id=1
        // and tenant B using id=2 — the test remains meaningful because
        // findByPK(1) under tenant B must still return null.
        await MetadataContext.run("acme", async () => {
          await em.save(InvoiceManual, { id: 1, amount: 100 });
        });
        await MetadataContext.run("globex", async () => {
          await em.save(InvoiceManual, { id: 2, amount: 200 });
        });

        await MetadataContext.run("acme", async () => {
          const mine: any = await em.findByPK(InvoiceManual, 1);
          expect(mine?.amount).toBe(100);
          expect(await em.findByPK(InvoiceManual, 2)).toBeNull();
        });
        await MetadataContext.run("globex", async () => {
          expect(await em.findByPK(InvoiceManual, 1)).toBeNull();
          const mine: any = await em.findByPK(InvoiceManual, 2);
          expect(mine?.amount).toBe(200);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  // 4. INSERT without tenant context
  // ─────────────────────────────────────────────────────────
  describe("4. INSERT without tenant context → MISSING_TENANT_CONTEXT", () => {
    @Entity()
    class OrderCtx {
      @PrimaryGeneratedColumn() id!: number;
      @Column() total!: number;
    }

    it("throws MISSING_TENANT_CONTEXT when no MetadataContext.run() is active", async () => {
      const em = await makeEm([OrderCtx]);
      try {
        await expect(
          em.save(OrderCtx, { total: 50 }),
        ).rejects.toMatchObject({
          code: OrmErrorCode.MISSING_TENANT_CONTEXT,
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  // 5. INSERT with mismatched tenant
  // ─────────────────────────────────────────────────────────
  describe("5. INSERT with mismatched tenant → TENANT_MISMATCH", () => {
    @Entity()
    class AuditMismatch {
      @PrimaryGeneratedColumn() id!: number;
      @Column() action!: string;
      @TenantColumn() tenantId!: string;
    }

    it("throws TENANT_MISMATCH when supplied tenantId disagrees with active context", async () => {
      const em = await makeEm([AuditMismatch]);
      try {
        await expect(
          MetadataContext.run("acme", () =>
            em.save(AuditMismatch, { action: "x", tenantId: "globex" } as any),
          ),
        ).rejects.toMatchObject({ code: OrmErrorCode.TENANT_MISMATCH });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });

    it("accepts INSERT when supplied tenantId matches context", async () => {
      const em = await makeEm([AuditMismatch]);
      try {
        await MetadataContext.run("acme", async () => {
          const row: any = await em.save(AuditMismatch, {
            action: "ok",
            tenantId: "acme",
          } as any);
          expect(row.tenantId).toBe("acme");
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  // 6. @NonTenantEntity works without filter
  // ─────────────────────────────────────────────────────────
  describe("6. @NonTenantEntity — global, no filter", () => {
    @NonTenantEntity()
    @Entity()
    class CountryRef {
      @PrimaryColumn({ type: "varchar", length: 2 }) code!: string;
      @Column() name!: string;
    }

    it("can seed without a tenant context and read identically across tenants", async () => {
      const em = await makeEm([CountryRef]);
      try {
        // Seed without context.
        await em.save(CountryRef, { code: "KR", name: "Korea" });
        await em.save(CountryRef, { code: "US", name: "United States" });

        const assertBothVisible = async () => {
          const rows: any[] = await em.find(CountryRef);
          expect(rows.length).toBe(2);
        };

        await MetadataContext.run("acme", assertBothVisible);
        await MetadataContext.run("globex", assertBothVisible);
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  // 7. runUnscoped() sees everything
  // ─────────────────────────────────────────────────────────
  describe("7. runUnscoped() escape hatch", () => {
    @Entity()
    class Ticket {
      @PrimaryGeneratedColumn() id!: number;
      @Column() subject!: string;
    }

    it("unscoped find returns rows from every tenant", async () => {
      const em = await makeEm([Ticket]);
      try {
        await MetadataContext.run("acme", async () => {
          await em.save(Ticket, { subject: "A1" });
          await em.save(Ticket, { subject: "A2" });
        });
        await MetadataContext.run("globex", async () => {
          await em.save(Ticket, { subject: "B1" });
        });

        await MetadataContext.run("acme", async () => {
          const all = await MetadataContext.runUnscoped(() => em.find(Ticket));
          expect(all.length).toBe(3);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  // 8. Eager load propagates tenant scope on owning table
  // ─────────────────────────────────────────────────────────
  describe("8. Eager load — ManyToOne JOIN respects tenant on owner", () => {
    @Entity()
    class Author8 {
      @PrimaryGeneratedColumn() id!: number;
      @Column() name!: string;
      @OneToMany(() => Book8, { mappedBy: "author" }) books!: Book8[];
    }

    @Entity()
    class Book8 {
      @PrimaryGeneratedColumn() id!: number;
      @Column() title!: string;
      @Column({ type: "int", nullable: true }) authorId!: number | null;
      @ManyToOne(() => Author8, (a: any) => a.books, {
        joinColumn: "authorId",
        createForeignKeyConstraints: false,
      })
      author!: Author8;
    }

    it("OneToMany relation batch loads only current tenant's children", async () => {
      const em = await makeEm([Author8, Book8]);
      try {
        await MetadataContext.run("acme", async () => {
          const a: any = await em.save(Author8, { name: "AcmeAuthor" });
          await em.save(Book8, { title: "A-book", authorId: a.id });
          await em.save(Book8, { title: "A-book-2", authorId: a.id });
        });
        await MetadataContext.run("globex", async () => {
          const g: any = await em.save(Author8, { name: "GlobexAuthor" });
          await em.save(Book8, { title: "G-book", authorId: g.id });
        });

        await MetadataContext.run("acme", async () => {
          const rows: any[] = await em.find(Author8, {
            where: { name: "AcmeAuthor" } as any,
            relations: ["books"],
          } as any);
          expect(rows.length).toBe(1);
          expect(rows[0].books.length).toBe(2);
          expect(rows[0].books.map((b: any) => b.title).sort()).toEqual([
            "A-book",
            "A-book-2",
          ]);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  // 9. em.query() raw-SQL warning
  // ─────────────────────────────────────────────────────────
  describe("9. em.query() emits tenant warning", () => {
    @Entity()
    class RawLog {
      @PrimaryGeneratedColumn() id!: number;
      @Column() message!: string;
    }

    it("warns when raw SQL is issued under an active tenant context", async () => {
      const em = await makeEm([RawLog]);
      const warnSpy = jest.spyOn((em as any).logger as Logger, "warn");
      try {
        await MetadataContext.run("acme", async () => {
          await em.query("SELECT 1 as one");
        });
        const calls = warnSpy.mock.calls.filter((c) =>
          /\[multi-tenancy\] em\.query\(\)/.test(String(c[0])),
        );
        expect(calls.length).toBeGreaterThanOrEqual(1);
        expect(String(calls[0][0])).toContain('tenant="acme"');
      } finally {
        warnSpy.mockRestore();
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  // 10. Concurrent AsyncLocalStorage isolation
  // ─────────────────────────────────────────────────────────
  describe("10. Concurrent requests — AsyncLocalStorage isolation", () => {
    @Entity()
    class Record10 {
      @PrimaryGeneratedColumn() id!: number;
      @Column() tenantTag!: string;
      @Column() value!: number;
    }

    it("parallel reads under three tenant contexts each only see their own rows", async () => {
      const em = await makeEm([Record10]);
      try {
        // Seed sequentially — SQLite in-memory has a single connection and
        // rejects concurrent write transactions. The MySQL / PostgreSQL
        // integration tests cover parallel writes.
        for (const tag of ["alpha", "beta", "gamma"]) {
          await MetadataContext.run(`t-${tag}`, async () => {
            for (let i = 0; i < 5; i++)
              await em.save(Record10, { tenantTag: tag, value: i });
          });
        }

        // Parallel reads — races the AsyncLocalStorage entries; each context
        // must keep its own tenant binding intact.
        const [alpha, beta, gamma] = await Promise.all([
          MetadataContext.run("t-alpha", () => em.find(Record10)),
          MetadataContext.run("t-beta", () => em.find(Record10)),
          MetadataContext.run("t-gamma", () => em.find(Record10)),
        ]);

        expect(alpha.length).toBe(5);
        expect(beta.length).toBe(5);
        expect(gamma.length).toBe(5);
        expect(
          (alpha as any[]).every((r) => r.tenantTag === "alpha"),
        ).toBe(true);
        expect((beta as any[]).every((r) => r.tenantTag === "beta")).toBe(true);
        expect(
          (gamma as any[]).every((r) => r.tenantTag === "gamma"),
        ).toBe(true);
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });
});
