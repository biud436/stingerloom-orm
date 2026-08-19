/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Integration test — NestJS shutdown actually releases connection pools
 * (V4-T2-2).
 *
 * `StingerloomOrmService.onApplicationShutdown()` called
 * `propagateShutdown()` with no arguments, and `closeConnections` defaults to
 * false — so plugins, listeners and trackers were torn down while the pool
 * stayed open, under a log line that read "Stingerloom ORM disconnected".
 * Under `tenantStrategy: "database"` it was worse: the service only ever saw
 * the admin EntityManager, so every tenant pool the router had provisioned
 * outlived the application with no path left to close it.
 *
 * The assertions read `DatabaseClient.hasConnection()`, which is only true
 * while a connector is registered — `close()` removes it.
 *
 * Runs only under INTEGRATION_TEST=true.
 */
import "reflect-metadata";
import { Injectable, Module } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { MetadataContext } from "../../../src/metadata/MetadataContext";
import { DatabaseClient } from "../../../src/DatabaseClient";
import { EntityManager } from "../../../src/core/EntityManager";
import { MultiTenantEntityManager } from "../../../src/core/MultiTenantEntityManager";
import { StingerloomOrmModule } from "../../../src/integration/nestjs/stingerloom-orm.module";
import { InjectMultiTenantEntityManager } from "../../../src/integration/nestjs/inject-multi-tenant-entity-manager.decorator";
import { getEntityManagerToken } from "../../../src/integration/nestjs/stingerloom-orm.module";

@Entity({ name: "nsp_user" })
class UserE {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
}

const client = () => DatabaseClient.getInstance();

const singleOpts = () => ({
  type: "sqlite" as const,
  database: ":memory:",
  entities: [UserE],
  synchronize: true as const,
});

const tenantOpts = () => ({
  ...singleOpts(),
  tenantStrategy: "database" as const,
  publicTenantBehavior: "default" as const,
  tenantDatabaseResolver: () => ({
    type: "sqlite" as const,
    database: ":memory:",
    entities: [UserE],
    synchronize: true as const,
  }),
});

@Injectable()
class TenantService {
  constructor(
    @InjectMultiTenantEntityManager()
    public readonly em: MultiTenantEntityManager,
  ) {}

  create(name: string) {
    return this.em.save(UserE, { name });
  }
}

async function boot(imports: any[], providers: any[] = []): Promise<TestingModule> {
  @Module({ imports, providers })
  class AppModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  await moduleRef.init();
  return moduleRef;
}

afterEach(async () => {
  MetadataContext.reset();
  await DatabaseClient.getInstance().close();
});

describe("[Integration] NestJS shutdown releases connection pools", () => {
  it("closes the pool the module registered", async () => {
    const moduleRef = await boot([StingerloomOrmModule.forRoot(singleOpts())]);
    expect(client().hasConnection("default")).toBe(true);

    await moduleRef.close();

    expect(client().hasConnection("default")).toBe(false);
  });

  it("closes every named connection of a multi-database app", async () => {
    const moduleRef = await boot([
      StingerloomOrmModule.forRoot(singleOpts()),
      StingerloomOrmModule.forRoot(singleOpts(), "analytics"),
    ]);
    expect(client().hasConnection("default")).toBe(true);
    expect(client().hasConnection("analytics")).toBe(true);

    await moduleRef.close();

    expect(client().hasConnection("default")).toBe(false);
    expect(client().hasConnection("analytics")).toBe(false);
  });

  it("closes the pool registered through forRootAsync", async () => {
    const moduleRef = await boot([
      StingerloomOrmModule.forRootAsync({ useFactory: () => singleOpts() }),
    ]);
    expect(client().hasConnection("default")).toBe(true);

    await moduleRef.close();

    expect(client().hasConnection("default")).toBe(false);
  });

  it("closes every tenant pool under tenantStrategy: 'database'", async () => {
    const moduleRef = await boot(
      [StingerloomOrmModule.forRoot(tenantOpts())],
      [TenantService],
    );
    const service = moduleRef.get(TenantService);

    await MetadataContext.run("acme", () => service.create("alice"));
    await MetadataContext.run("globex", () => service.create("bob"));

    const mtem = moduleRef.get(MultiTenantEntityManager);
    const tenantConnections: string[] = (mtem as any).router
      .getAll()
      .map((entry: { em: EntityManager }) => entry.em.getConnectionName());

    expect(tenantConnections).toHaveLength(2);
    for (const name of tenantConnections) {
      expect(client().hasConnection(name)).toBe(true);
    }
    expect(client().hasConnection("default")).toBe(true);

    await moduleRef.close();

    // The tenant pools are the ones the old shutdown could not reach at all:
    // the service was handed the admin EntityManager, and nothing else held a
    // reference to the router.
    for (const name of tenantConnections) {
      expect(client().hasConnection(name)).toBe(false);
    }
    expect(client().hasConnection("default")).toBe(false);
  });

  it("closes tenant pools of a named 'database'-strategy connection", async () => {
    const moduleRef = await boot([
      StingerloomOrmModule.forRoot(tenantOpts(), "tenants"),
    ]);

    const mtem = moduleRef.get<MultiTenantEntityManager>(
      "STINGERLOOM_MULTI_TENANT_ENTITY_MANAGER_tenants",
    );
    await MetadataContext.run("acme", () => mtem.save(UserE, { name: "alice" }));

    const tenantConnection = (mtem as any).router
      .getAll()[0]
      .em.getConnectionName();
    expect(client().hasConnection(tenantConnection)).toBe(true);
    expect(client().hasConnection("tenants__admin")).toBe(true);

    await moduleRef.close();

    expect(client().hasConnection(tenantConnection)).toBe(false);
    expect(client().hasConnection("tenants__admin")).toBe(false);
  });

  it("leaves the EntityManager usable until shutdown runs", async () => {
    const moduleRef = await boot([StingerloomOrmModule.forRoot(singleOpts())]);
    const em = moduleRef.get<EntityManager>(getEntityManagerToken() as any);

    await em.save(UserE, { name: "alice" });
    expect((await em.find(UserE)).map((u) => u.name)).toEqual(["alice"]);

    await moduleRef.close();

    expect(client().hasConnection("default")).toBe(false);
  });
});
