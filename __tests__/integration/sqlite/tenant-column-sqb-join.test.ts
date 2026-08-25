/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * tenant_column strategy — SelectQueryBuilder entity/relation JOINs must
 * scope the JOINED table (SQLite :memory:).
 *
 * SQB already scopes the root (buildQuery), count, exists, and whereHas
 * subqueries. Entity-aware joins (leftJoin(Entity, ...), *AndSelect) and
 * relation joins (leftJoinRelation*) joined another tenant's rows freely:
 * a cross-tenant FK hydrated the other tenant's row, and an INNER relation
 * join matched it. The predicate must bind the tenant active at EXECUTION
 * time (a builder may be constructed outside MetadataContext.run()).
 *
 * String-based joins (raw table name) remain unscoped by design — the ORM
 * cannot know the entity — matching the em.query() escape-hatch stance.
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
    `tcsqb_${Math.random().toString(36).slice(2, 10)}`,
  );
  return em;
}

describe("[Integration] SQLite: tenant_column — SQB joins scope the joined table", () => {
  beforeEach(() => MetadataContext.reset());

  @Entity()
  class ProfileQB {
    @PrimaryGeneratedColumn() id!: number;
    @Column() secret!: string;
    @OneToMany(() => AccountQB, { mappedBy: "profile" }) accounts!: AccountQB[];
  }

  @Entity()
  class AccountQB {
    @PrimaryGeneratedColumn() id!: number;
    @Column() name!: string;
    @Column({ type: "int", nullable: true }) profileId!: number | null;
    @ManyToOne(() => ProfileQB, (p: any) => p.accounts, {
      joinColumn: "profileId",
      createForeignKeyConstraints: false,
    })
    profile!: ProfileQB | null;
  }

  async function seedPoisonedFk(em: EntityManager): Promise<void> {
    await MetadataContext.run("acme", async () => {
      const p: any = await em.save(ProfileQB, { secret: "acme-secret" });
      await MetadataContext.run("globex", async () => {
        await em.save(AccountQB, { name: "globex-acct", profileId: p.id });
      });
    });
  }

  it("leftJoinRelationAndSelect: cross-tenant FK hydrates as null", async () => {
    const em = await makeEm([ProfileQB, AccountQB]);
    try {
      await seedPoisonedFk(em);

      await MetadataContext.run("globex", async () => {
        const rows: any[] = await em
          .createQueryBuilder(AccountQB, "a")
          .leftJoinRelationAndSelect("profile", "p")
          .getMany();
        expect(rows.length).toBe(1);
        expect(rows[0].profile ?? null).toBeNull();
      });
    } finally {
      await em.propagateShutdown({ closeConnections: true });
    }
  });

  it("innerJoinRelation: cross-tenant FK no longer matches (0 rows)", async () => {
    const em = await makeEm([ProfileQB, AccountQB]);
    try {
      await seedPoisonedFk(em);

      await MetadataContext.run("globex", async () => {
        const rows: any[] = await em
          .createQueryBuilder(AccountQB, "a")
          .innerJoinRelation("profile", "p")
          .getMany();
        expect(rows.length).toBe(0);
      });
    } finally {
      await em.propagateShutdown({ closeConnections: true });
    }
  });

  it("entity-aware leftJoinAndSelect: joined columns come back null for cross-tenant rows", async () => {
    const em = await makeEm([ProfileQB, AccountQB]);
    try {
      await seedPoisonedFk(em);

      await MetadataContext.run("globex", async () => {
        const rows: any[] = await em
          .createQueryBuilder(AccountQB, "a")
          .leftJoinAndSelect(ProfileQB, "p", (j: any) =>
            j.on("a.profileId", "=", "p.id"),
          )
          .getRawMany();
        expect(rows.length).toBe(1);
        expect(rows[0].p_secret ?? null).toBeNull();
      });
    } finally {
      await em.propagateShutdown({ closeConnections: true });
    }
  });

  it("predicate binds the EXECUTION-time tenant, not construction time", async () => {
    const em = await makeEm([ProfileQB, AccountQB]);
    try {
      await seedPoisonedFk(em);

      // Built with no tenant context active at all.
      const qb = em
        .createQueryBuilder(AccountQB, "a")
        .leftJoinRelationAndSelect("profile", "p");

      await MetadataContext.run("globex", async () => {
        const rows: any[] = await qb.getMany();
        expect(rows.length).toBe(1);
        expect(rows[0].profile ?? null).toBeNull();
      });
    } finally {
      await em.propagateShutdown({ closeConnections: true });
    }
  });

  it("same-tenant FK still hydrates through relation join (sanity)", async () => {
    const em = await makeEm([ProfileQB, AccountQB]);
    try {
      await MetadataContext.run("acme", async () => {
        const p: any = await em.save(ProfileQB, { secret: "acme-secret" });
        await em.save(AccountQB, { name: "acme-acct", profileId: p.id });
      });

      await MetadataContext.run("acme", async () => {
        const rows: any[] = await em
          .createQueryBuilder(AccountQB, "a")
          .leftJoinRelationAndSelect("profile", "p")
          .getMany();
        expect(rows.length).toBe(1);
        expect(rows[0].profile?.secret).toBe("acme-secret");
      });
    } finally {
      await em.propagateShutdown({ closeConnections: true });
    }
  });

  it("withoutTenantScope() keeps the join unscoped (escape hatch)", async () => {
    const em = await makeEm([ProfileQB, AccountQB]);
    try {
      await seedPoisonedFk(em);

      await MetadataContext.run("globex", async () => {
        const rows: any[] = await em
          .createQueryBuilder(AccountQB, "a")
          .withoutTenantScope()
          .leftJoinRelationAndSelect("profile", "p")
          .getMany();
        expect(rows.length).toBe(1);
        expect(rows[0].profile?.secret).toBe("acme-secret");
      });
    } finally {
      await em.propagateShutdown({ closeConnections: true });
    }
  });
});
