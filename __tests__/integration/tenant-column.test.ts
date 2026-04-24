/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Phase 8 — tenant_column strategy end-to-end integration test (MySQL + PostgreSQL).
 *
 * Mirrors __tests__/integration/sqlite/tenant-column.test.ts but against real
 * database servers. Runs only under INTEGRATION_TEST=true. Individual drivers
 * can be disabled via INTEGRATION_TEST_MYSQL=false / INTEGRATION_TEST_POSTGRES=false.
 *
 * Scenarios (same as plan §Phase 8):
 *   1. DDL round-trip — tenant column materialized via INFORMATION_SCHEMA lookup
 *   2. CRUD isolation
 *   3. PK collision — manual PKs, one row per tenant
 *   4. INSERT without tenant context → MISSING_TENANT_CONTEXT
 *   5. INSERT with mismatched tenant value → TENANT_MISMATCH
 *   6. @NonTenantEntity — global, no filter
 *   7. runUnscoped() escape hatch
 *   8. Eager load — ManyToOne JOIN respects tenant
 *   9. em.query() raw-SQL warning
 *  10. Concurrent AsyncLocalStorage isolation (parallel writes and reads)
 */
import "reflect-metadata";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { PrimaryColumn } from "../../src/decorators/PrimaryColumn";
import { ManyToOne } from "../../src/decorators/ManyToOne";
import { OneToMany } from "../../src/decorators/OneToMany";
import {
  NonTenantEntity,
  TenantColumn,
} from "../../src/decorators/TenantColumn";
import { EntityManager } from "../../src/core/EntityManager";
import { MetadataContext } from "../../src/metadata/MetadataContext";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";
import { Logger } from "../../src/utils/Logger";
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
  user: "tc_user",
  post: "tc_post",
  invoice: "tc_invoice",
  audit: "tc_audit",
  country: "tc_country",
  raw: "tc_raw",
  concurrent: "tc_concurrent",
} as const;

describe.each(drivers)(
  "[Integration][$label] tenant_column strategy — end-to-end",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let UserE: any;
    let PostE: any;
    let InvoiceE: any;
    let AuditE: any;
    let CountryE: any;
    let RawE: any;
    let ConcurrentE: any;

    async function verifyTenantColumnExists(
      table: string,
      expectedColumn = "tenant_id",
    ): Promise<boolean> {
      if (type === "mysql") {
        const rows: any[] = await rawQuery(
          `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND COLUMN_NAME = '${expectedColumn}'`,
        );
        return Array.isArray(rows) && rows.length > 0;
      }
      const rows: any[] = await rawQuery(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = '${table}'
           AND column_name = '${expectedColumn}'`,
      );
      return Array.isArray(rows) && rows.length > 0;
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
          @Entity({ name: TABLES.user })
          class UserEntity {
            @PrimaryGeneratedColumn() id!: number;
            @Column() name!: string;
            @OneToMany(() => PostEntity, { mappedBy: "author" })
            posts!: PostEntity[];
          }
          @Entity({ name: TABLES.post })
          class PostEntity {
            @PrimaryGeneratedColumn() id!: number;
            @Column() title!: string;
            @Column({ type: "int", nullable: true })
            authorId!: number | null;
            @ManyToOne(() => UserEntity, (u: any) => u.posts, {
              joinColumn: "authorId",
              createForeignKeyConstraints: false,
            })
            author!: UserEntity;
          }
          @Entity({ name: TABLES.invoice })
          class InvoiceEntity {
            @PrimaryColumn({ type: "int" }) id!: number;
            @Column() amount!: number;
          }
          @Entity({ name: TABLES.audit })
          class AuditEntity {
            @PrimaryGeneratedColumn() id!: number;
            @Column() action!: string;
            @TenantColumn() tenantId!: string;
          }
          @NonTenantEntity()
          @Entity({ name: TABLES.country })
          class CountryEntity {
            @PrimaryColumn({ type: "varchar", length: 2 }) code!: string;
            @Column() name!: string;
          }
          @Entity({ name: TABLES.raw })
          class RawEntity {
            @PrimaryGeneratedColumn() id!: number;
            @Column() message!: string;
          }
          @Entity({ name: TABLES.concurrent })
          class ConcurrentEntity {
            @PrimaryGeneratedColumn() id!: number;
            @Column() tag!: string;
          }
          UserE = UserEntity;
          PostE = PostEntity;
          InvoiceE = InvoiceEntity;
          AuditE = AuditEntity;
          CountryE = CountryEntity;
          RawE = RawEntity;
          ConcurrentE = ConcurrentEntity;
          return {
            entities: [
              UserEntity,
              PostEntity,
              InvoiceEntity,
              AuditEntity,
              CountryEntity,
              RawEntity,
              ConcurrentEntity,
            ],
          };
        },
      );
      em = conn.em;
    }, 60000);

    afterAll(async () => {
      // Drop in reverse dependency order (post → user).
      const dropOrder = [
        TABLES.post,
        TABLES.user,
        TABLES.invoice,
        TABLES.audit,
        TABLES.country,
        TABLES.raw,
        TABLES.concurrent,
      ];
      for (const t of dropOrder) {
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
      // Truncate in reverse-FK order. Post references User via authorId (no FK
      // constraint is actually created — createForeignKeyConstraints: false).
      for (const t of [
        TABLES.post,
        TABLES.user,
        TABLES.invoice,
        TABLES.audit,
        TABLES.country,
        TABLES.raw,
        TABLES.concurrent,
      ]) {
        try {
          await truncateTestTable(t);
        } catch {
          /* ignore */
        }
      }
    });

    // ─────────────────────────────────────────────────────
    // 1. DDL round-trip
    // ─────────────────────────────────────────────────────
    describe("1. DDL round-trip", () => {
      it("synchronize injects tenant_id column into every scoped table", async () => {
        for (const t of [
          TABLES.user,
          TABLES.post,
          TABLES.invoice,
          TABLES.raw,
          TABLES.concurrent,
        ]) {
          expect(await verifyTenantColumnExists(t, "tenant_id")).toBe(true);
        }
      });

      it("user-declared @TenantColumn property name is used (tenantId, no tenant_id duplicate)", async () => {
        expect(await verifyTenantColumnExists(TABLES.audit, "tenantId")).toBe(
          true,
        );
        expect(await verifyTenantColumnExists(TABLES.audit, "tenant_id")).toBe(
          false,
        );
      });

      it("@NonTenantEntity tables have no tenant column", async () => {
        expect(
          await verifyTenantColumnExists(TABLES.country, "tenant_id"),
        ).toBe(false);
      });
    });

    // ─────────────────────────────────────────────────────
    // 2. CRUD isolation
    // ─────────────────────────────────────────────────────
    describe("2. CRUD isolation across tenants", () => {
      it("tenant A rows are invisible to tenant B and vice versa", async () => {
        await MetadataContext.run("acme", async () => {
          await em.save(UserE, { name: "Alice" });
          await em.save(UserE, { name: "Anna" });
        });
        await MetadataContext.run("globex", async () => {
          await em.save(UserE, { name: "Bob" });
        });

        await MetadataContext.run("acme", async () => {
          const rows: any[] = await em.find(UserE);
          expect(rows.map((r) => r.name).sort()).toEqual(["Alice", "Anna"]);
        });
        await MetadataContext.run("globex", async () => {
          const rows: any[] = await em.find(UserE);
          expect(rows.map((r) => r.name)).toEqual(["Bob"]);
        });
      });
    });

    // ─────────────────────────────────────────────────────
    // 3. PK collision (manual PKs one-per-tenant)
    // ─────────────────────────────────────────────────────
    describe("3. PK lookups are tenant-scoped", () => {
      it("findByPK returns null for another tenant's PK", async () => {
        // Without composite (tenant_id, pk) PK, two rows with the same id
        // can't coexist in a single shared table. We verify scope filtering
        // using distinct IDs per tenant — the test is still meaningful
        // because findByPK(id) under the wrong tenant must return null.
        await MetadataContext.run("acme", async () => {
          await em.save(InvoiceE, { id: 1, amount: 100 });
        });
        await MetadataContext.run("globex", async () => {
          await em.save(InvoiceE, { id: 2, amount: 200 });
        });

        await MetadataContext.run("acme", async () => {
          const mine: any = await em.findByPK(InvoiceE, 1);
          expect(mine?.amount).toBe(100);
          expect(await em.findByPK(InvoiceE, 2)).toBeNull();
        });
        await MetadataContext.run("globex", async () => {
          expect(await em.findByPK(InvoiceE, 1)).toBeNull();
          const mine: any = await em.findByPK(InvoiceE, 2);
          expect(mine?.amount).toBe(200);
        });
      });
    });

    // ─────────────────────────────────────────────────────
    // 4. INSERT without tenant context
    // ─────────────────────────────────────────────────────
    describe("4. INSERT without tenant context", () => {
      it("throws MISSING_TENANT_CONTEXT", async () => {
        await expect(em.save(UserE, { name: "ghost" })).rejects.toMatchObject({
          code: OrmErrorCode.MISSING_TENANT_CONTEXT,
        });
      });
    });

    // ─────────────────────────────────────────────────────
    // 5. INSERT with mismatched tenant value
    // ─────────────────────────────────────────────────────
    describe("5. INSERT with mismatched tenant value", () => {
      it("throws TENANT_MISMATCH when supplied tenantId disagrees with context", async () => {
        await expect(
          MetadataContext.run("acme", () =>
            em.save(AuditE, { action: "x", tenantId: "globex" } as any),
          ),
        ).rejects.toMatchObject({ code: OrmErrorCode.TENANT_MISMATCH });
      });

      it("accepts INSERT when supplied tenantId matches context", async () => {
        await MetadataContext.run("acme", async () => {
          const row: any = await em.save(AuditE, {
            action: "ok",
            tenantId: "acme",
          } as any);
          expect(row.tenantId).toBe("acme");
        });
      });
    });

    // ─────────────────────────────────────────────────────
    // 6. @NonTenantEntity
    // ─────────────────────────────────────────────────────
    describe("6. @NonTenantEntity — unfiltered, shared", () => {
      it("seeds without context and reads identically from every tenant", async () => {
        await em.save(CountryE, { code: "KR", name: "Korea" });
        await em.save(CountryE, { code: "US", name: "United States" });

        const assertBoth = async () => {
          const rows: any[] = await em.find(CountryE);
          expect(rows.length).toBe(2);
        };
        await MetadataContext.run("acme", assertBoth);
        await MetadataContext.run("globex", assertBoth);
      });
    });

    // ─────────────────────────────────────────────────────
    // 7. runUnscoped()
    // ─────────────────────────────────────────────────────
    describe("7. runUnscoped() escape hatch", () => {
      it("unscoped find returns rows from every tenant", async () => {
        await MetadataContext.run("acme", async () => {
          await em.save(UserE, { name: "A1" });
          await em.save(UserE, { name: "A2" });
        });
        await MetadataContext.run("globex", async () => {
          await em.save(UserE, { name: "B1" });
        });

        await MetadataContext.run("acme", async () => {
          const all = await MetadataContext.runUnscoped(() => em.find(UserE));
          expect(all.length).toBe(3);
        });
      });
    });

    // ─────────────────────────────────────────────────────
    // 8. Eager load
    // ─────────────────────────────────────────────────────
    describe("8. Eager load — OneToMany respects tenant on owner", () => {
      it("author.books batch loads only current tenant's children", async () => {
        await MetadataContext.run("acme", async () => {
          const a: any = await em.save(UserE, { name: "AcmeAuthor" });
          await em.save(PostE, { title: "A-1", authorId: a.id });
          await em.save(PostE, { title: "A-2", authorId: a.id });
        });
        await MetadataContext.run("globex", async () => {
          const g: any = await em.save(UserE, { name: "GlobexAuthor" });
          await em.save(PostE, { title: "G-1", authorId: g.id });
        });

        await MetadataContext.run("acme", async () => {
          const rows: any[] = await em.find(UserE, {
            where: { name: "AcmeAuthor" } as any,
            relations: ["posts"],
          } as any);
          expect(rows.length).toBe(1);
          expect(rows[0].posts.length).toBe(2);
          expect(rows[0].posts.map((p: any) => p.title).sort()).toEqual([
            "A-1",
            "A-2",
          ]);
        });
      });
    });

    // ─────────────────────────────────────────────────────
    // 9. em.query() raw-SQL warning
    // ─────────────────────────────────────────────────────
    describe("9. em.query() emits tenant warning", () => {
      it("warns when raw SQL runs under an active tenant context", async () => {
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
        }
      });
    });

    // ─────────────────────────────────────────────────────
    // 10. Concurrent AsyncLocalStorage
    // ─────────────────────────────────────────────────────
    describe("10. Concurrent AsyncLocalStorage isolation", () => {
      it("three parallel tenants each only see their own rows (writes + reads)", async () => {
        // Real DB drivers have connection pools → truly parallel transactions.
        const tags = ["alpha", "beta", "gamma"] as const;
        await Promise.all(
          tags.map((tag) =>
            MetadataContext.run(`t-${tag}`, async () => {
              for (let i = 0; i < 5; i++) {
                await em.save(ConcurrentE, { tag });
              }
            }),
          ),
        );

        const [alpha, beta, gamma] = await Promise.all([
          MetadataContext.run("t-alpha", () => em.find(ConcurrentE)),
          MetadataContext.run("t-beta", () => em.find(ConcurrentE)),
          MetadataContext.run("t-gamma", () => em.find(ConcurrentE)),
        ]);

        expect(alpha.length).toBe(5);
        expect(beta.length).toBe(5);
        expect(gamma.length).toBe(5);
        expect((alpha as any[]).every((r) => r.tag === "alpha")).toBe(true);
        expect((beta as any[]).every((r) => r.tag === "beta")).toBe(true);
        expect((gamma as any[]).every((r) => r.tag === "gamma")).toBe(true);
      });
    });
  },
);

// Skip-marker so jest reports gracefully when INTEGRATION_TEST is unset.
if (!INTEGRATION) {
  describe.skip("[Integration] tenant_column — skipped (set INTEGRATION_TEST=true)", () => {
    it("is disabled", () => {
      /* no-op */
    });
  });
}
