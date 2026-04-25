/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Phase 7 — tenantStrategy: "database" end-to-end integration test
 * (MySQL + PostgreSQL).
 *
 * Mirrors __tests__/integration/sqlite/tenant-database.test.ts but provisions
 * physical tenant databases via raw `CREATE DATABASE` calls. The admin DB
 * holds nothing tenant-specific — every tenant gets its own DB and its own
 * pool.
 *
 * The 12 plan scenarios still apply, plus a real-pool concurrent-write test
 * (#10) that SQLite couldn't run because of single-connection serialization.
 */
import "reflect-metadata";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { MetadataContext } from "../../src/metadata/MetadataContext";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";
import { DatabaseClient } from "../../src/DatabaseClient";
import { MultiTenantEntityManager } from "../../src/core/MultiTenantEntityManager";
import { EntityManager } from "../../src/core/EntityManager";
import {
  getTestDrivers,
  type TestDriverConfig,
} from "./helpers/driver-config";

const INTEGRATION = process.env.INTEGRATION_TEST === "true";
const drivers = INTEGRATION ? getTestDrivers() : [];

@Entity({ name: "td_user" })
class UserE {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
}

/**
 * Provision two physical tenant databases on the target server. Returns a
 * cleanup function that drops them. Idempotent — DROP IF EXISTS first.
 */
async function provisionTenantDatabases(
  type: "mysql" | "postgres",
  baseOptions: Record<string, any>,
  names: string[],
): Promise<() => Promise<void>> {
  const adminEm = new EntityManager();
  const adminConn = `td_admin_${Date.now()}`;
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

  // Drop first, then recreate.
  for (const name of names) {
    try {
      await driver.executeRaw(`DROP DATABASE IF EXISTS ${name}`);
    } catch {
      /* ignore — DROP IF EXISTS handles missing-DB on both dialects */
    }
    if (type === "postgres") {
      await driver.executeRaw(`CREATE DATABASE ${name}`);
    } else {
      await driver.executeRaw(`CREATE DATABASE ${name}`);
    }
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
  "[Integration][$label] tenantStrategy database — end-to-end",
  ({ type, options }: TestDriverConfig) => {
    const tenantA = `td_tenant_a_${type}`;
    const tenantB = `td_tenant_b_${type}`;
    const tenantC = `td_tenant_c_${type}`;
    let dropDatabases: () => Promise<void>;

    beforeAll(async () => {
      dropDatabases = await provisionTenantDatabases(type, options, [
        tenantA,
        tenantB,
        tenantC,
      ]);
    });

    afterAll(async () => {
      await dropDatabases();
    });

    beforeEach(async () => {
      // Tenant DBs persist across tests in the same describe; clear rows so
      // each test starts with a clean state. Use a one-shot EM per tenant so
      // a single bad TRUNCATE on one DB doesn't strand the others.
      const truncateEm = async (dbName: string) => {
        const em = new EntityManager();
        const conn = `td_truncate_${dbName}_${Date.now()}_${Math.random()
          .toString(36)
          .slice(2, 6)}`;
        try {
          await em.register(
            {
              ...(options as any),
              database: dbName,
              entities: [UserE],
              synchronize: true,
              logging: false,
              tenantStrategy: "database",
            } as any,
            conn,
          );
          const stmt =
            type === "postgres"
              ? `TRUNCATE TABLE td_user RESTART IDENTITY CASCADE`
              : `TRUNCATE TABLE td_user`;
          try {
            await em.getDriver()!.executeRaw(stmt);
          } catch {
            /* table may not exist on first run; synchronize already handled it */
          }
        } finally {
          await em.propagateShutdown({ closeConnections: true }).catch(() => {});
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

    /**
     * Build a MultiTenantEntityManager pointing at this dialect, with a
     * resolver that maps every tenant to its own physical DB on the same
     * server. The admin EM uses the original test DB.
     */
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
        entities: [UserE],
        synchronize: true,
        logging: false,
        tenantStrategy: "database",
        tenantDatabaseResolver: (tenantId: string) => {
          const dbName = tenantToDb[tenantId];
          if (!dbName) throw new Error(`Unknown tenant: ${tenantId}`);
          return {
            ...(options as any),
            database: dbName,
            entities: [UserE],
            synchronize: true,
            logging: false,
          } as any;
        },
        ...override,
      } as any);
      return mtem;
    }

    // ──────────────────────────────────────────────────────────
    // Scenarios
    // ──────────────────────────────────────────────────────────

    it("1. lazy-provisions per-tenant databases on first query", async () => {
      const mtem = await makeMtem();
      await MetadataContext.run("acme", () =>
        mtem.save(UserE, { name: "alice" }),
      );
      const tenants = mtem.getRouter().getResolvedTenants();
      expect(tenants).toContain("acme");
    });

    it("2. cross-tenant isolation — tenants don't see each other's rows", async () => {
      const mtem = await makeMtem();
      await MetadataContext.run("acme", () =>
        mtem.save(UserE, { name: "alice" }),
      );
      await MetadataContext.run("globex", () =>
        mtem.save(UserE, { name: "carol" }),
      );

      const acme = (await MetadataContext.run("acme", () =>
        mtem.find(UserE),
      )) as UserE[];
      const globex = (await MetadataContext.run("globex", () =>
        mtem.find(UserE),
      )) as UserE[];
      expect(acme.map((u) => u.name)).toEqual(["alice"]);
      expect(globex.map((u) => u.name)).toEqual(["carol"]);
    });

    it("3. eagerProvisionTenants synchronizes every tenant DDL up-front", async () => {
      const mtem = await makeMtem({
        eagerProvisionTenants: ["acme", "globex"],
      });
      const tenants = mtem.getRouter().getResolvedTenants().sort();
      expect(tenants).toEqual(["acme", "globex"]);
    });

    it("4. forEachTenant fans out across resolved tenants", async () => {
      const mtem = await makeMtem();
      await MetadataContext.run("acme", () =>
        mtem.save(UserE, { name: "a1" }),
      );
      await MetadataContext.run("globex", () =>
        mtem.save(UserE, { name: "g1" }),
      );

      const result = await mtem.forEachTenant((tenantEm) =>
        tenantEm.count(UserE),
      );
      const map = Object.fromEntries(
        result.map((r) => [r.tenantId, r.value]),
      );
      expect(map).toEqual({ acme: 1, globex: 1 });
    });

    it("5. CROSS_TENANT_TRANSACTION fires when tenant changes mid-transaction", async () => {
      const mtem = await makeMtem();
      let captured: unknown;
      await MetadataContext.run("acme", async () => {
        try {
          await mtem.transaction(async () => {
            await MetadataContext.run("globex", async () => {
              await mtem.save(UserE, { name: "should fail" });
            });
          });
        } catch (e) {
          captured = e;
        }
      });
      expect(captured).toBeInstanceOf(OrmError);
      expect((captured as OrmError).code).toBe(
        OrmErrorCode.CROSS_TENANT_TRANSACTION,
      );
    });

    it("6. publicTenantBehavior: throw rejects context-less queries", async () => {
      const mtem = await makeMtem({ publicTenantBehavior: "throw" });
      let captured: unknown;
      try {
        await mtem.save(UserE, { name: "ghost" });
      } catch (e) {
        captured = e;
      }
      expect(captured).toBeInstanceOf(OrmError);
      expect((captured as OrmError).code).toBe(
        OrmErrorCode.MISSING_TENANT_CONTEXT,
      );
    });

    it("7. publicTenantBehavior: default routes context-less queries to the admin EM", async () => {
      const mtem = await makeMtem({ publicTenantBehavior: "default" });
      // Admin DB doesn't have td_user — synchronize creates it.
      await mtem.save(UserE, { name: "admin row" });
      const adminRows = (await mtem
        .getDefaultEntityManager()
        .find(UserE)) as UserE[];
      expect(adminRows.map((u) => u.name)).toContain("admin row");
    });

    it("8. parallel writes across tenants are concurrent-safe (real pools)", async () => {
      const mtem = await makeMtem();
      // 5 parallel writes per tenant; AsyncLocalStorage must keep each
      // request's tenant context distinct.
      const tasks: Array<Promise<unknown>> = [];
      for (let i = 0; i < 5; i++) {
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
      }
      await Promise.all(tasks);

      const acme = (await MetadataContext.run("acme", () =>
        mtem.find(UserE),
      )) as UserE[];
      const globex = (await MetadataContext.run("globex", () =>
        mtem.find(UserE),
      )) as UserE[];
      expect(acme.map((u) => u.name).sort()).toEqual(
        ["acme-0", "acme-1", "acme-2", "acme-3", "acme-4"],
      );
      expect(globex.map((u) => u.name).sort()).toEqual(
        ["globex-0", "globex-1", "globex-2", "globex-3", "globex-4"],
      );
    });

    it("9. lazy-provisioning race — resolver invoked exactly once per tenant", async () => {
      let calls = 0;
      const tenantToDb: Record<string, string> = { initech: tenantC };
      const mtem = new MultiTenantEntityManager();
      await mtem.register({
        ...(options as any),
        entities: [UserE],
        synchronize: true,
        logging: false,
        tenantStrategy: "database",
        tenantDatabaseResolver: async (tenantId: string) => {
          calls++;
          await new Promise((r) => setTimeout(r, 10));
          return {
            ...options,
            database: tenantToDb[tenantId]!,
            entities: [UserE],
            synchronize: true,
            logging: false,
          };
        },
      });
      const ems = await Promise.all(
        Array.from({ length: 10 }, () =>
          mtem.getRouter().resolve("initech"),
        ),
      );
      expect(calls).toBe(1);
      expect(new Set(ems).size).toBe(1);
    });

    it("10. propagateShutdown closes all tenant pools + admin pool", async () => {
      const mtem = await makeMtem({
        eagerProvisionTenants: ["acme", "globex"],
      });
      const before = DatabaseClient.getInstance().getRegisteredNames().length;
      expect(before).toBeGreaterThanOrEqual(3);
      await mtem.propagateShutdown({ closeConnections: true });
      expect(DatabaseClient.getInstance().getRegisteredNames()).toEqual([]);
    });
  },
);
