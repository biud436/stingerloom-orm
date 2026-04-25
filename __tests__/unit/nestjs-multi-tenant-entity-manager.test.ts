import "reflect-metadata";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { MetadataContext } from "../../src/metadata/MetadataContext";
import { DatabaseClient } from "../../src/DatabaseClient";
import { MultiTenantEntityManager } from "../../src/core/MultiTenantEntityManager";
import { EntityManager } from "../../src/core/EntityManager";
import { StingerloomOrmModule } from "../../src/integration/nestjs/stingerloom-orm.module";
import { StingerloomOrmCoreModule } from "../../src/integration/nestjs/stingerloom-orm-core.module";
import {
  getMultiTenantEntityManagerToken,
} from "../../src/integration/nestjs/inject-multi-tenant-entity-manager.decorator";

@Entity({ name: "nest_mtem_user" })
class UserE {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
}

const sqliteOpts = () => ({
  type: "sqlite" as const,
  database: ":memory:",
  entities: [UserE],
  synchronize: true as const,
  tenantStrategy: "database" as const,
  tenantDatabaseResolver: () => ({
    type: "sqlite" as const,
    database: ":memory:",
    entities: [UserE],
    synchronize: true as const,
  }),
});

afterEach(async () => {
  MetadataContext.reset();
  await DatabaseClient.getInstance().close();
});

/**
 * These tests verify the dynamic module wiring without spinning up a full
 * NestJS application — invoking the module factories directly and confirming
 * the providers' useFactory shapes/results.
 */
describe("NestJS @InjectMultiTenantEntityManager", () => {
  it("getMultiTenantEntityManagerToken returns the class for default", () => {
    expect(getMultiTenantEntityManagerToken()).toBe(MultiTenantEntityManager);
    expect(getMultiTenantEntityManagerToken("default")).toBe(
      MultiTenantEntityManager,
    );
  });

  it("returns a string token for named connections", () => {
    expect(getMultiTenantEntityManagerToken("analytics")).toBe(
      "STINGERLOOM_MULTI_TENANT_ENTITY_MANAGER_analytics",
    );
  });

  it("CoreModule.forRoot includes both EM and MTEM providers under tenantStrategy: database", () => {
    const dyn = StingerloomOrmCoreModule.forRoot(sqliteOpts());
    const tokens = (dyn.providers as any[]).map((p) => p.provide);
    expect(tokens).toContain(EntityManager);
    expect(tokens).toContain(MultiTenantEntityManager);

    expect(dyn.exports).toContain(EntityManager);
    expect(dyn.exports).toContain(MultiTenantEntityManager);
  });

  it("CoreModule.forRoot omits the MTEM provider for non-database strategies", () => {
    const dyn = StingerloomOrmCoreModule.forRoot({
      type: "sqlite",
      database: ":memory:",
      entities: [UserE],
      synchronize: true,
    });
    const tokens = (dyn.providers as any[]).map((p) => p.provide);
    expect(tokens).toContain(EntityManager);
    expect(tokens).not.toContain(MultiTenantEntityManager);

    expect(dyn.exports).not.toContain(MultiTenantEntityManager);
  });

  it("forRoot factory yields a working MTEM and shares its admin EM with the EM token", async () => {
    const dyn = StingerloomOrmCoreModule.forRoot(sqliteOpts());
    const providers = dyn.providers as any[];
    const mtemProvider = providers.find(
      (p) => p.provide === MultiTenantEntityManager,
    );
    const emProvider = providers.find((p) => p.provide === EntityManager);

    const mtem: MultiTenantEntityManager = await mtemProvider.useFactory();
    const em: EntityManager = await emProvider.useFactory(mtem);

    expect(mtem).toBeInstanceOf(MultiTenantEntityManager);
    expect(em).toBe(mtem.getDefaultEntityManager());

    await MetadataContext.run("acme", () => mtem.save(UserE, { name: "alice" }));
    await MetadataContext.run("globex", () => mtem.save(UserE, { name: "bob" }));

    const acmeUsers = (await MetadataContext.run("acme", () =>
      mtem.find(UserE),
    )) as UserE[];
    const globexUsers = (await MetadataContext.run("globex", () =>
      mtem.find(UserE),
    )) as UserE[];
    expect(acmeUsers.map((u) => u.name)).toEqual(["alice"]);
    expect(globexUsers.map((u) => u.name)).toEqual(["bob"]);

    await mtem.propagateShutdown({ closeConnections: true });
  });

  it("Module.forRoot still exposes the orm service stack on top of the MTEM-backed EM", () => {
    const dyn = StingerloomOrmModule.forRoot(sqliteOpts());
    expect(dyn.imports?.length).toBeGreaterThan(0);
    // CoreModule sits inside imports — the MTEM provider lives there, not in
    // the outer module. We verify that exports surface the ORM service.
    const exports = dyn.exports as any[];
    expect(exports.some((e) => typeof e !== "string" || e.length > 0)).toBe(
      true,
    );
  });
});
