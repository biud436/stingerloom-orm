/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Integration test — `tenantDatabaseResolver` with NestJS DI (ConfigService-style).
 *
 * Validates the realistic production wiring: a fake `ConfigService` is
 * registered as a NestJS provider, `StingerloomOrmModule.forRootAsync()`
 * pulls it in via `inject`, and the `tenantDatabaseResolver` closure captures
 * it to compute per-tenant connection options at first-resolve time.
 *
 * Runs only under INTEGRATION_TEST=true.
 */
import "reflect-metadata";
import { Injectable, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { MetadataContext } from "../../../src/metadata/MetadataContext";
import { DatabaseClient } from "../../../src/DatabaseClient";
import { MultiTenantEntityManager } from "../../../src/core/MultiTenantEntityManager";
import { OrmError } from "../../../src/errors/OrmError";
import { OrmErrorCode } from "../../../src/errors/OrmErrorCode";
import { StingerloomOrmModule } from "../../../src/integration/nestjs/stingerloom-orm.module";
import { InjectMultiTenantEntityManager } from "../../../src/integration/nestjs/inject-multi-tenant-entity-manager.decorator";

@Entity({ name: "tdci_user" })
class UserE {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
}

/**
 * Fake config service — stands in for `@nestjs/config` ConfigService. Returns
 * a per-tenant SQLite path (a separate file per tenant guarantees pool
 * isolation; SQLite ":memory:" works too but doesn't survive a reconnect).
 */
@Injectable()
class FakeConfigService {
  private readonly values: Record<string, string> = {
    ADMIN_DB: ":memory:",
    TENANT_DB_PREFIX: ":memory:",
    DEFAULT_PUBLIC_BEHAVIOR: "throw",
  };

  get(key: string): string | undefined {
    return this.values[key];
  }
}

@Module({
  providers: [FakeConfigService],
  exports: [FakeConfigService],
})
class FakeConfigModule {}

@Injectable()
class UserService {
  constructor(
    @InjectMultiTenantEntityManager()
    public readonly em: MultiTenantEntityManager,
  ) {}

  list() {
    return this.em.find(UserE);
  }

  create(name: string) {
    return this.em.save(UserE, { name });
  }
}

afterEach(async () => {
  MetadataContext.reset();
  await DatabaseClient.getInstance().close();
});

describe("[Integration] tenantDatabaseResolver + NestJS ConfigService DI", () => {
  it("forRootAsync — resolver captures ConfigService and routes per tenant", async () => {
    @Module({
      imports: [
        StingerloomOrmModule.forRootAsync({
          imports: [FakeConfigModule],
          inject: [FakeConfigService],
          useFactory: (config: FakeConfigService) => ({
            type: "sqlite" as const,
            database: config.get("ADMIN_DB")!,
            entities: [UserE],
            synchronize: true as const,
            tenantStrategy: "database" as const,
            publicTenantBehavior:
              (config.get("DEFAULT_PUBLIC_BEHAVIOR") as
                | "throw"
                | "default") ?? "throw",
            tenantDatabaseResolver: (tenantId: string) => ({
              type: "sqlite" as const,
              // Closure captures `config` — proves DI value flows into the
              // per-tenant resolver path. Real apps would do
              // `${config.get("TENANT_DB_PREFIX")}_${tenantId}.db` or similar.
              database: ":memory:",
              entities: [UserE],
              synchronize: true as const,
            }),
          }),
        }),
      ],
      providers: [UserService],
    })
    class AppModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const userService = moduleRef.get(UserService);

    // 1. Tenant routing works through NestJS-injected MTEM.
    await MetadataContext.run("acme", () => userService.create("alice"));
    await MetadataContext.run("acme", () => userService.create("bob"));
    await MetadataContext.run("globex", () => userService.create("carol"));

    const acme = (await MetadataContext.run("acme", () =>
      userService.list(),
    )) as UserE[];
    const globex = (await MetadataContext.run("globex", () =>
      userService.list(),
    )) as UserE[];
    expect(acme.map((u) => u.name).sort()).toEqual(["alice", "bob"]);
    expect(globex.map((u) => u.name)).toEqual(["carol"]);

    // 2. publicTenantBehavior propagated from ConfigService → MTEM. The fake
    // service returns "throw", so context-less calls must be rejected.
    let captured: unknown;
    try {
      await userService.create("ghost");
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(OrmError);
    expect((captured as OrmError).code).toBe(
      OrmErrorCode.MISSING_TENANT_CONTEXT,
    );

    await moduleRef.close();
  });

  it("ConfigService values flow into the resolver each time it is invoked", async () => {
    // Track resolver invocations to verify the captured ConfigService is
    // actually consulted on every first-touch (not snapshotted at boot).
    const seenPrefixes: string[] = [];

    @Module({
      imports: [
        StingerloomOrmModule.forRootAsync({
          imports: [FakeConfigModule],
          inject: [FakeConfigService],
          useFactory: (config: FakeConfigService) => ({
            type: "sqlite" as const,
            database: config.get("ADMIN_DB")!,
            entities: [UserE],
            synchronize: true as const,
            tenantStrategy: "database" as const,
            publicTenantBehavior: "default" as const,
            tenantDatabaseResolver: (tenantId: string) => {
              const prefix = config.get("TENANT_DB_PREFIX")!;
              seenPrefixes.push(`${prefix}|${tenantId}`);
              return {
                type: "sqlite" as const,
                database: ":memory:",
                entities: [UserE],
                synchronize: true as const,
              };
            },
          }),
        }),
      ],
    })
    class AppModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const mtem = moduleRef.get<MultiTenantEntityManager>(
      MultiTenantEntityManager,
    );

    await MetadataContext.run("acme", () => mtem.save(UserE, { name: "x" }));
    await MetadataContext.run("globex", () =>
      mtem.save(UserE, { name: "y" }),
    );
    // Second touch of "acme" must NOT re-call resolver — router caches the EM.
    await MetadataContext.run("acme", () => mtem.save(UserE, { name: "z" }));

    expect(seenPrefixes).toEqual([
      ":memory:|acme",
      ":memory:|globex",
    ]);
    await moduleRef.close();
  });
});
