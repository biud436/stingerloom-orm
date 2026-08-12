/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * V4-T0-1 — tenant_column strategy: missing-context policy (SQLite :memory:).
 *
 * Before this policy existed, read/update/delete on a tenant-scoped entity
 * executed OUTSIDE any `MetadataContext.run()` silently targeted every
 * tenant's rows (fail-open) while INSERT alone failed loud. The
 * `tenantOnMissingContext` option makes that state observable/controllable:
 *
 *   - "warn" (default): keep the unfiltered query for backward compat, but
 *     log a warning once per entity class.
 *   - "throw": reject with MISSING_TENANT_CONTEXT, symmetrical with INSERT.
 *   - "allow": explicitly sanctioned unfiltered access, no log.
 *
 * Explicit escape hatches stay policy-exempt in every mode:
 *   - `MetadataContext.runUnscoped()`
 *   - `MetadataContext.run("public", ...)` (admin/bootstrap context)
 *   - `findOption.withoutTenantScope`
 *
 * Runs only under INTEGRATION_TEST=true (see jest.config.js).
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../../src/decorators/ManyToOne";
import { OneToMany } from "../../../src/decorators/OneToMany";
import { EntityManager } from "../../../src/core/EntityManager";
import { MetadataContext } from "../../../src/metadata/MetadataContext";
import { OrmErrorCode } from "../../../src/errors/OrmErrorCode";
import { Logger } from "../../../src/utils/Logger";

const MISSING_CONTEXT_MARKER = /\[multi-tenancy\] .*no active tenant context/;

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
    `tcmc_${Math.random().toString(36).slice(2, 10)}`,
  );
  return em;
}

/** Seeds 2 rows under tenant "acme" and 1 row under tenant "globex". */
async function seed(em: EntityManager, entity: any) {
  await MetadataContext.run("acme", async () => {
    await em.save(entity, { name: "A1", status: "active" });
    await em.save(entity, { name: "A2", status: "active" });
  });
  await MetadataContext.run("globex", async () => {
    await em.save(entity, { name: "B1", status: "active" });
  });
}

function missingContextWarnCalls(spy: jest.SpyInstance) {
  return spy.mock.calls.filter((c) =>
    MISSING_CONTEXT_MARKER.test(String(c[0])),
  );
}

describe("[Integration] SQLite: tenant_column — missing tenant context policy", () => {
  beforeEach(() => MetadataContext.reset());

  // ─────────────────────────────────────────────────────────
  // 1. Default policy ("warn") — fail-open kept, made observable
  // ─────────────────────────────────────────────────────────
  describe("1. default policy (warn)", () => {
    @Entity()
    class OrderWarnMc {
      @PrimaryGeneratedColumn() id!: number;
      @Column() name!: string;
      @Column() status!: string;
    }

    it("find() without context returns every tenant's rows AND warns once per entity", async () => {
      const em = await makeEm([OrderWarnMc]);
      const warnSpy = jest.spyOn((em as any).logger as Logger, "warn");
      try {
        await seed(em, OrderWarnMc);

        // Documented fail-open: unfiltered read crosses tenants.
        const rows: any[] = await em.find(OrderWarnMc);
        expect(rows.length).toBe(3);

        const calls = missingContextWarnCalls(warnSpy);
        expect(calls.length).toBe(1);
        expect(String(calls[0][0])).toContain("OrderWarnMc");

        // Dedup: a second unscoped call on the same entity does not re-warn.
        await em.find(OrderWarnMc);
        expect(missingContextWarnCalls(warnSpy).length).toBe(1);
      } finally {
        warnSpy.mockRestore();
        await em.propagateShutdown({ closeConnections: true });
      }
    });

    it("updateMany()/deleteMany() without context touch other tenants' rows and warn", async () => {
      const em = await makeEm([OrderWarnMc]);
      const warnSpy = jest.spyOn((em as any).logger as Logger, "warn");
      try {
        await seed(em, OrderWarnMc);

        // Documented fail-open: cross-tenant UPDATE (3 rows, not 2).
        const updated = await em.updateMany(
          OrderWarnMc,
          { status: "closed" } as any,
          { where: { status: "active" } as any },
        );
        expect(updated.affected).toBe(3);
        expect(missingContextWarnCalls(warnSpy).length).toBeGreaterThanOrEqual(
          1,
        );

        // Documented fail-open: cross-tenant DELETE by PK list.
        const all: any[] = await MetadataContext.runUnscoped(() =>
          em.find(OrderWarnMc),
        );
        const deleted = await em.deleteMany(
          OrderWarnMc,
          all.map((r) => r.id),
        );
        expect(deleted.affected).toBe(3);
      } finally {
        warnSpy.mockRestore();
        await em.propagateShutdown({ closeConnections: true });
      }
    });

    it("count() without context aggregates across tenants and warns", async () => {
      const em = await makeEm([OrderWarnMc]);
      const warnSpy = jest.spyOn((em as any).logger as Logger, "warn");
      try {
        await seed(em, OrderWarnMc);
        const n = await em.count(OrderWarnMc);
        expect(Number(n)).toBe(3);
        expect(missingContextWarnCalls(warnSpy).length).toBe(1);
      } finally {
        warnSpy.mockRestore();
        await em.propagateShutdown({ closeConnections: true });
      }
    });

    it("scoped/escape-hatch paths never warn", async () => {
      const em = await makeEm([OrderWarnMc]);
      const warnSpy = jest.spyOn((em as any).logger as Logger, "warn");
      try {
        await seed(em, OrderWarnMc);
        warnSpy.mockClear();

        await MetadataContext.run("acme", () => em.find(OrderWarnMc));
        await MetadataContext.runUnscoped(() => em.find(OrderWarnMc));
        await MetadataContext.run("public", () => em.find(OrderWarnMc));
        await em.find(OrderWarnMc, { withoutTenantScope: true } as any);

        expect(missingContextWarnCalls(warnSpy).length).toBe(0);
      } finally {
        warnSpy.mockRestore();
        await em.propagateShutdown({ closeConnections: true });
      }
    });

    it("relation eager load without context warns for the related entity too", async () => {
      @Entity()
      class AuthorWarnMc {
        @PrimaryGeneratedColumn() id!: number;
        @Column() name!: string;
        @OneToMany(() => BookWarnMc, { mappedBy: "author" })
        books!: BookWarnMc[];
      }
      @Entity()
      class BookWarnMc {
        @PrimaryGeneratedColumn() id!: number;
        @Column() title!: string;
        @Column({ type: "int", nullable: true }) authorId!: number | null;
        @ManyToOne(() => AuthorWarnMc, (a: any) => a.books, {
          joinColumn: "authorId",
          createForeignKeyConstraints: false,
        })
        author!: AuthorWarnMc;
      }

      const em = await makeEm([AuthorWarnMc, BookWarnMc]);
      const warnSpy = jest.spyOn((em as any).logger as Logger, "warn");
      try {
        await MetadataContext.run("acme", async () => {
          const a: any = await em.save(AuthorWarnMc, { name: "AcmeAuthor" });
          await em.save(BookWarnMc, { title: "A-book", authorId: a.id });
        });

        await em.find(AuthorWarnMc, { relations: ["books"] } as any);

        const warned = missingContextWarnCalls(warnSpy).map((c) =>
          String(c[0]),
        );
        expect(warned.some((m) => m.includes("AuthorWarnMc"))).toBe(true);
        expect(warned.some((m) => m.includes("BookWarnMc"))).toBe(true);
      } finally {
        warnSpy.mockRestore();
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  // 2. tenantOnMissingContext: "throw" — symmetrical with INSERT
  // ─────────────────────────────────────────────────────────
  describe('2. tenantOnMissingContext: "throw"', () => {
    @Entity()
    class OrderThrowMc {
      @PrimaryGeneratedColumn() id!: number;
      @Column() name!: string;
      @Column() status!: string;
    }

    const rejectsMissingContext = (p: Promise<unknown>) =>
      expect(p).rejects.toMatchObject({
        code: OrmErrorCode.MISSING_TENANT_CONTEXT,
      });

    it("read paths reject MISSING_TENANT_CONTEXT outside a tenant context", async () => {
      const em = await makeEm([OrderThrowMc], {
        tenantOnMissingContext: "throw",
      });
      try {
        await seed(em, OrderThrowMc);

        await rejectsMissingContext(em.find(OrderThrowMc));
        await rejectsMissingContext(
          em.findOne(OrderThrowMc, { where: { name: "A1" } as any }),
        );
        await rejectsMissingContext(em.findByPK(OrderThrowMc, 1));
        await rejectsMissingContext(em.count(OrderThrowMc));
        await rejectsMissingContext(em.exists(OrderThrowMc));
        await rejectsMissingContext(
          em
            .createQueryBuilder(OrderThrowMc, "o")
            .where("status", "active")
            .getMany(),
        );
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });

    it("write paths reject MISSING_TENANT_CONTEXT outside a tenant context", async () => {
      const em = await makeEm([OrderThrowMc], {
        tenantOnMissingContext: "throw",
      });
      try {
        await seed(em, OrderThrowMc);

        await rejectsMissingContext(
          em.updateMany(
            OrderThrowMc,
            { status: "closed" } as any,
            { where: { status: "active" } as any },
          ),
        );
        await rejectsMissingContext(em.deleteMany(OrderThrowMc, [1, 2, 3]));
        // INSERT keeps its original fail-loud behavior (pre-dates the policy).
        await rejectsMissingContext(
          em.save(OrderThrowMc, { name: "X", status: "active" }),
        );

        // Nothing leaked through.
        const survivors: any[] = await MetadataContext.runUnscoped(() =>
          em.find(OrderThrowMc),
        );
        expect(survivors.length).toBe(3);
        expect(survivors.every((r) => r.status === "active")).toBe(true);
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });

    it("scoped calls and explicit escape hatches still work", async () => {
      const em = await makeEm([OrderThrowMc], {
        tenantOnMissingContext: "throw",
      });
      try {
        await seed(em, OrderThrowMc);

        // Normal tenant scoping is unaffected.
        await MetadataContext.run("acme", async () => {
          const rows: any[] = await em.find(OrderThrowMc);
          expect(rows.map((r: any) => r.name).sort()).toEqual(["A1", "A2"]);
        });

        // runUnscoped() is the sanctioned cross-tenant path.
        const all: any[] = await MetadataContext.runUnscoped(() =>
          em.find(OrderThrowMc),
        );
        expect(all.length).toBe(3);

        // Explicit "public" context is the sanctioned admin/bootstrap path.
        const admin: any[] = await MetadataContext.run("public", () =>
          em.find(OrderThrowMc),
        );
        expect(admin.length).toBe(3);

        // Per-call opt-out skips scoping (and therefore the policy) entirely.
        const optOut: any[] = await em.find(OrderThrowMc, {
          withoutTenantScope: true,
        } as any);
        expect(optOut.length).toBe(3);
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  // 3. tenantOnMissingContext: "allow" — sanctioned, silent
  // ─────────────────────────────────────────────────────────
  describe('3. tenantOnMissingContext: "allow"', () => {
    @Entity()
    class OrderAllowMc {
      @PrimaryGeneratedColumn() id!: number;
      @Column() name!: string;
      @Column() status!: string;
    }

    it("reads stay unfiltered with no warning; INSERT still throws", async () => {
      const em = await makeEm([OrderAllowMc], {
        tenantOnMissingContext: "allow",
      });
      const warnSpy = jest.spyOn((em as any).logger as Logger, "warn");
      try {
        await seed(em, OrderAllowMc);

        const rows: any[] = await em.find(OrderAllowMc);
        expect(rows.length).toBe(3);
        expect(missingContextWarnCalls(warnSpy).length).toBe(0);

        // The policy governs read/update/delete only — INSERT stays loud.
        await expect(
          em.save(OrderAllowMc, { name: "X", status: "active" }),
        ).rejects.toMatchObject({
          code: OrmErrorCode.MISSING_TENANT_CONTEXT,
        });
      } finally {
        warnSpy.mockRestore();
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });
});
