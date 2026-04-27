/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * tenantStrategy "database" × feature matrix on real database servers
 * (MySQL + PostgreSQL).
 *
 * Mirrors `__tests__/integration/sqlite/tenant-database-features.test.ts`
 * for the subset of scenarios that genuinely benefit from physical DB
 * isolation:
 *
 *   1. Aggregates per tenant DB
 *   2. Soft delete + restore inside one tenant DB only
 *   3. Per-tenant transaction commit/rollback isolation
 *   4. Concurrent parallel writes across tenants under real pools
 *   5. forEachTenant settled-mode keeps going past one failing tenant
 *   6. Repository proxy resolves the right tenant per call
 *
 * Each test provisions tenant catalogs at the top via `CREATE DATABASE` on
 * the admin connection, and drops them in afterAll. Runs only under
 * INTEGRATION_TEST=true.
 */

import "reflect-metadata";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { DeletedAt } from "../../src/decorators/DeletedAt";
import { MetadataContext } from "../../src/metadata/MetadataContext";
import { DatabaseClient } from "../../src/DatabaseClient";
import { MultiTenantEntityManager } from "../../src/core/MultiTenantEntityManager";
import { EntityManager } from "../../src/core/EntityManager";
import {
  getTestDrivers,
  type TestDriverConfig,
} from "./helpers/driver-config";

const INTEGRATION = process.env.INTEGRATION_TEST === "true";
const drivers = INTEGRATION ? getTestDrivers() : [];

@Entity({ name: "tdfx_user" })
class UserE {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
}

@Entity({ name: "tdfx_invoice" })
class InvoiceE {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "int" }) amount!: number;
}

@Entity({ name: "tdfx_post" })
class PostE {
  @PrimaryGeneratedColumn() id!: number;
  @Column() title!: string;
  @DeletedAt() deletedAt!: Date | null;
}

const ENTITIES = [UserE, InvoiceE, PostE];

async function provisionTenantDatabases(
  baseOptions: Record<string, any>,
  names: string[],
): Promise<() => Promise<void>> {
  const adminEm = new EntityManager();
  const adminConn = `tdfx_admin_${Date.now()}`;
  await adminEm.register(
    {
      ...baseOptions,
      entities: [],
      synchronize: false,
      logging: false,
    } as any,
    adminConn,
  );
  const driver = adminEm.getDriver()!;
  for (const name of names) {
    try {
      await driver.executeRaw(`DROP DATABASE IF EXISTS ${name}`);
    } catch {
      /* ignore */
    }
    await driver.executeRaw(`CREATE DATABASE ${name}`);
  }
  return async () => {
    for (const name of names) {
      try {
        await driver.executeRaw(`DROP DATABASE IF EXISTS ${name}`);
      } catch {
        /* ignore */
      }
    }
    await adminEm.propagateShutdown({ closeConnections: true });
  };
}

describe.each(drivers)(
  "[Integration][$label] tenantStrategy database × feature matrix",
  ({ type, options }: TestDriverConfig) => {
    const tenantA = `tdfx_a_${type}`;
    const tenantB = `tdfx_b_${type}`;
    const tenantC = `tdfx_c_${type}`;
    let dropDatabases: () => Promise<void>;

    beforeAll(async () => {
      dropDatabases = await provisionTenantDatabases(options, [
        tenantA,
        tenantB,
        tenantC,
      ]);
    }, 60000);

    afterAll(async () => {
      await dropDatabases();
    }, 30000);

    beforeEach(async () => {
      const truncateEm = async (dbName: string) => {
        const em = new EntityManager();
        const conn = `tdfx_t_${dbName}_${Date.now()}_${Math.random()
          .toString(36)
          .slice(2, 6)}`;
        try {
          await em.register(
            {
              ...(options as any),
              database: dbName,
              entities: ENTITIES,
              synchronize: true,
              logging: false,
              tenantStrategy: "database",
            } as any,
            conn,
          );
          for (const t of ["tdfx_user", "tdfx_invoice", "tdfx_post"]) {
            const stmt =
              type === "postgres"
                ? `TRUNCATE TABLE ${t} RESTART IDENTITY CASCADE`
                : `TRUNCATE TABLE ${t}`;
            try {
              await em.getDriver()!.executeRaw(stmt);
            } catch {
              /* ignore */
            }
          }
        } finally {
          await em
            .propagateShutdown({ closeConnections: true })
            .catch(() => {});
        }
      };
      for (const dbName of [tenantA, tenantB, tenantC]) {
        await truncateEm(dbName);
      }
    });

    afterEach(async () => {
      MetadataContext.reset();
      await DatabaseClient.getInstance().close();
    });

    async function makeMtem(
      override: Record<string, any> = {},
    ): Promise<MultiTenantEntityManager> {
      const tenantToDb: Record<string, string> = {
        acme: tenantA,
        globex: tenantB,
        initech: tenantC,
      };
      const mtem = new MultiTenantEntityManager();
      await mtem.register({
        ...(options as any),
        entities: ENTITIES,
        synchronize: true,
        logging: false,
        tenantStrategy: "database",
        tenantDatabaseResolver: (tenantId: string) => {
          const dbName = tenantToDb[tenantId];
          if (!dbName) throw new Error(`Unknown tenant: ${tenantId}`);
          return {
            ...(options as any),
            database: dbName,
            entities: ENTITIES,
            synchronize: true,
            logging: false,
          } as any;
        },
        ...override,
      } as any);
      return mtem;
    }

    // ──────────────────────────────────────────────────────────
    it("aggregates land in the per-tenant DB only", async () => {
      const mtem = await makeMtem();
      await MetadataContext.run("acme", async () => {
        for (const a of [10, 20, 30]) await mtem.save(InvoiceE, { amount: a });
      });
      await MetadataContext.run("globex", async () => {
        for (const a of [100, 200]) await mtem.save(InvoiceE, { amount: a });
      });

      await MetadataContext.run("acme", async () => {
        expect(await mtem.count(InvoiceE)).toBe(3);
        expect(Number(await mtem.sum(InvoiceE, "amount"))).toBe(60);
      });
      await MetadataContext.run("globex", async () => {
        expect(await mtem.count(InvoiceE)).toBe(2);
        expect(Number(await mtem.sum(InvoiceE, "amount"))).toBe(300);
      });
    });

    // ──────────────────────────────────────────────────────────
    it("softDelete + restore land in the right physical DB", async () => {
      const mtem = await makeMtem();
      const acme = (await MetadataContext.run("acme", () =>
        mtem.save(PostE, { title: "shared" }),
      )) as PostE;
      await MetadataContext.run("globex", () =>
        mtem.save(PostE, { title: "shared" }),
      );

      await MetadataContext.run("acme", async () => {
        await mtem.softDelete(PostE, { id: acme.id } as any);
        expect((await mtem.find(PostE)).length).toBe(0);
        const all = (await mtem.find(PostE, {
          withDeleted: true,
        } as any)) as PostE[];
        expect(all.length).toBe(1);
      });
      await MetadataContext.run("globex", async () => {
        const live = (await mtem.find(PostE)) as PostE[];
        expect(live.length).toBe(1);
        expect(live[0].deletedAt).toBeNull();
      });
      await MetadataContext.run("acme", async () => {
        await mtem.restore(PostE, { title: "shared" } as any);
        expect((await mtem.find(PostE)).length).toBe(1);
      });
    });

    // ──────────────────────────────────────────────────────────
    it("transaction commit/rollback isolated to the tenant DB", async () => {
      const mtem = await makeMtem();
      // Commit on acme.
      await MetadataContext.run("acme", () =>
        mtem.transaction(async (tx) => {
          await tx.save(UserE, { name: "tx1" });
          await tx.save(UserE, { name: "tx2" });
        }),
      );
      // Rollback on globex.
      await MetadataContext.run("globex", async () => {
        await expect(
          mtem.transaction(async (tx) => {
            await tx.save(UserE, { name: "wont-survive" });
            throw new Error("boom");
          }),
        ).rejects.toThrow("boom");
      });
      await MetadataContext.run("acme", async () => {
        expect(await mtem.count(UserE)).toBe(2);
      });
      await MetadataContext.run("globex", async () => {
        expect(await mtem.count(UserE)).toBe(0);
      });
    });

    // ──────────────────────────────────────────────────────────
    it("concurrent parallel writes across tenants stay isolated under real pools", async () => {
      const mtem = await makeMtem();
      const tasks: Array<Promise<unknown>> = [];
      for (let i = 0; i < 4; i++) {
        tasks.push(
          Promise.resolve(
            MetadataContext.run("acme", () =>
              mtem.save(UserE, { name: `acme-${i}` }),
            ),
          ),
        );
        tasks.push(
          Promise.resolve(
            MetadataContext.run("globex", () =>
              mtem.save(UserE, { name: `globex-${i}` }),
            ),
          ),
        );
        tasks.push(
          Promise.resolve(
            MetadataContext.run("initech", () =>
              mtem.save(UserE, { name: `initech-${i}` }),
            ),
          ),
        );
      }
      await Promise.all(tasks);

      for (const t of ["acme", "globex", "initech"]) {
        await MetadataContext.run(t, async () => {
          const rows = (await mtem.find(UserE)) as UserE[];
          expect(rows.length).toBe(4);
          expect(rows.every((r) => r.name.startsWith(t))).toBe(true);
        });
      }
    });

    // ──────────────────────────────────────────────────────────
    it("forEachTenant settled-mode reports per-tenant errors", async () => {
      const mtem = await makeMtem();
      // seed something so each tenant has a count.
      await MetadataContext.run("acme", () =>
        mtem.save(UserE, { name: "a" }),
      );
      await MetadataContext.run("globex", () =>
        mtem.save(UserE, { name: "g" }),
      );

      const result = await mtem.forEachTenant(
        async (tenantEm, tenantId) => {
          if (tenantId === "globex") throw new Error("simulated");
          return tenantEm.count(UserE);
        },
        { mode: "settled" },
      );
      const map = Object.fromEntries(
        result.map((r) => [r.tenantId, r.error ? "ERR" : r.value]),
      );
      expect(map).toEqual({ acme: 1, globex: "ERR" });
    });

    // ──────────────────────────────────────────────────────────
    it("repository proxy routes per call to the tenant's DB", async () => {
      const mtem = await makeMtem();
      const repo = mtem.getRepository(UserE);
      await MetadataContext.run("acme", async () => {
        await repo.save({ name: "alice" } as any);
      });
      await MetadataContext.run("globex", async () => {
        await repo.save({ name: "carol" } as any);
      });
      await MetadataContext.run("acme", async () => {
        const rows = await repo.find();
        expect(rows.map((r: any) => r.name)).toEqual(["alice"]);
      });
    });
  },
);

if (!INTEGRATION) {
  describe.skip("[Integration] tenant_database features — skipped (set INTEGRATION_TEST=true)", () => {
    it("is disabled", () => {
      /* no-op */
    });
  });
}
