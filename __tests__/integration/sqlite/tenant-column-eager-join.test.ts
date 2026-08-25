/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * tenant_column strategy — eager JOIN must scope the JOINED table, not just
 * the root (SQLite :memory:).
 *
 * The batched relation loader (RelationLoader) and the lazy proxy loader both
 * filter the related entity by the active tenant. The eager ManyToOne /
 * OneToOne LEFT JOIN in ReadExecutor.findInternal must behave identically:
 * an FK that points at another tenant's row hydrates as null, never as the
 * other tenant's data.
 *
 * Attack vector reproduced here: INSERT validates the tenant of the inserted
 * row itself but cannot validate cross-tenant FK targets, so tenant B can
 * store an FK value that resolves to tenant A's row. Without a tenant
 * predicate in the JOIN's ON clause, tenant B's read hydrates tenant A's row.
 *
 * Runs only under INTEGRATION_TEST=true (see jest.config.js).
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../../src/decorators/ManyToOne";
import { OneToMany } from "../../../src/decorators/OneToMany";
import { OneToOne } from "../../../src/decorators/OneToOne";
import { EntityManager } from "../../../src/core/EntityManager";
import { MetadataContext } from "../../../src/metadata/MetadataContext";

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
    `tcej_${Math.random().toString(36).slice(2, 10)}`,
  );
  return em;
}

describe("[Integration] SQLite: tenant_column — eager JOIN scopes the joined table", () => {
  beforeEach(() => MetadataContext.reset());

  @Entity()
  class ProfileEJ {
    @PrimaryGeneratedColumn() id!: number;
    @Column() secret!: string;
    @OneToMany(() => AccountEJ, { mappedBy: "profile" }) accounts!: AccountEJ[];
  }

  @Entity()
  class AccountEJ {
    @PrimaryGeneratedColumn() id!: number;
    @Column() name!: string;
    @Column({ type: "int", nullable: true }) profileId!: number | null;
    @ManyToOne(() => ProfileEJ, (p: any) => p.accounts, {
      joinColumn: "profileId",
      eager: true,
      createForeignKeyConstraints: false,
    })
    profile!: ProfileEJ | null;
  }

  it("eager ManyToOne: FK pointing at another tenant's row hydrates as null", async () => {
    const em = await makeEm([ProfileEJ, AccountEJ]);
    try {
      let acmeProfileId!: number;
      await MetadataContext.run("acme", async () => {
        const p: any = await em.save(ProfileEJ, { secret: "acme-secret" });
        acmeProfileId = p.id;
      });

      // Tenant globex stores an FK that resolves to tenant acme's row.
      await MetadataContext.run("globex", async () => {
        await em.save(AccountEJ, {
          name: "globex-acct",
          profileId: acmeProfileId,
        });
      });

      await MetadataContext.run("globex", async () => {
        const rows: any[] = await em.find(AccountEJ);
        expect(rows.length).toBe(1);
        // Must NOT hydrate acme's profile — same contract as the batched
        // relation loader, which filters the related table by tenant.
        expect(rows[0].profile ?? null).toBeNull();
      });
    } finally {
      await em.propagateShutdown({ closeConnections: true });
    }
  });

  it("eager ManyToOne: findOne behaves identically to find", async () => {
    const em = await makeEm([ProfileEJ, AccountEJ]);
    try {
      let acmeProfileId!: number;
      await MetadataContext.run("acme", async () => {
        const p: any = await em.save(ProfileEJ, { secret: "acme-secret" });
        acmeProfileId = p.id;
      });
      await MetadataContext.run("globex", async () => {
        await em.save(AccountEJ, {
          name: "globex-acct",
          profileId: acmeProfileId,
        });
      });

      await MetadataContext.run("globex", async () => {
        const row: any = await em.findOne(AccountEJ, {
          where: { name: "globex-acct" } as any,
        });
        expect(row).not.toBeNull();
        expect(row.profile ?? null).toBeNull();
      });
    } finally {
      await em.propagateShutdown({ closeConnections: true });
    }
  });

  it("eager ManyToOne: same-tenant FK still hydrates (sanity)", async () => {
    const em = await makeEm([ProfileEJ, AccountEJ]);
    try {
      await MetadataContext.run("acme", async () => {
        const p: any = await em.save(ProfileEJ, { secret: "acme-secret" });
        await em.save(AccountEJ, { name: "acme-acct", profileId: p.id });
      });

      await MetadataContext.run("acme", async () => {
        const rows: any[] = await em.find(AccountEJ);
        expect(rows.length).toBe(1);
        expect(rows[0].profile?.secret).toBe("acme-secret");
      });
    } finally {
      await em.propagateShutdown({ closeConnections: true });
    }
  });

  it("eager ManyToOne under runUnscoped(): joined row hydrates without tenant filter", async () => {
    const em = await makeEm([ProfileEJ, AccountEJ]);
    try {
      let acmeProfileId!: number;
      await MetadataContext.run("acme", async () => {
        const p: any = await em.save(ProfileEJ, { secret: "acme-secret" });
        acmeProfileId = p.id;
      });
      await MetadataContext.run("globex", async () => {
        await em.save(AccountEJ, {
          name: "globex-acct",
          profileId: acmeProfileId,
        });
      });

      // Cross-tenant access is sanctioned inside runUnscoped — the JOIN
      // must not filter there, mirroring the root behavior.
      await MetadataContext.runUnscoped(async () => {
        const rows: any[] = await em.find(AccountEJ);
        expect(rows.length).toBe(1);
        expect(rows[0].profile?.secret).toBe("acme-secret");
      });
    } finally {
      await em.propagateShutdown({ closeConnections: true });
    }
  });

  // ─────────────────────────────────────────────────────────
  // OneToOne (owning side) — same JOIN loop, same contract.
  // The `relations` option for M2O/O2O owning side routes through the
  // eager JOIN too, so this also covers plain relations-loading.
  // ─────────────────────────────────────────────────────────
  @Entity()
  class PassportEJ {
    @PrimaryGeneratedColumn() id!: number;
    @Column() passNo!: string;
  }

  @Entity()
  class TravelerEJ {
    @PrimaryGeneratedColumn() id!: number;
    @Column() name!: string;
    @Column({ type: "int", nullable: true }) passportFk!: number | null;
    @OneToOne(() => PassportEJ, { joinColumn: "passportFk" })
    passport!: PassportEJ | null;
  }

  it("OneToOne via relations option: cross-tenant FK hydrates as null", async () => {
    const em = await makeEm([PassportEJ, TravelerEJ]);
    try {
      let acmePassportId!: number;
      await MetadataContext.run("acme", async () => {
        const p: any = await em.save(PassportEJ, { passNo: "ACME-001" });
        acmePassportId = p.id;
      });
      await MetadataContext.run("globex", async () => {
        await em.save(TravelerEJ, {
          name: "globex-traveler",
          passportFk: acmePassportId,
        });
      });

      await MetadataContext.run("globex", async () => {
        const rows: any[] = await em.find(TravelerEJ, {
          relations: ["passport"],
        } as any);
        expect(rows.length).toBe(1);
        expect(rows[0].passport ?? null).toBeNull();
      });
    } finally {
      await em.propagateShutdown({ closeConnections: true });
    }
  });

  it("OneToOne via relations option: same-tenant FK still hydrates (sanity)", async () => {
    const em = await makeEm([PassportEJ, TravelerEJ]);
    try {
      await MetadataContext.run("acme", async () => {
        const p: any = await em.save(PassportEJ, { passNo: "ACME-001" });
        await em.save(TravelerEJ, { name: "acme-traveler", passportFk: p.id });
      });

      await MetadataContext.run("acme", async () => {
        const rows: any[] = await em.find(TravelerEJ, {
          relations: ["passport"],
        } as any);
        expect(rows.length).toBe(1);
        expect(rows[0].passport?.passNo).toBe("ACME-001");
      });
    } finally {
      await em.propagateShutdown({ closeConnections: true });
    }
  });
});
