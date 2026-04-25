import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import {
  makeInjectRepositoryToken,
  getEntityManagerToken,
  StingerloomOrmModule,
  INJECT_REPOSITORIES_TOKEN,
} from "../../src/integration/nestjs/stingerloom-orm.module";
import {
  StingerloomOrmCoreModule,
  getOrmOptionsToken,
  type StingerloomOrmOptionsFactory,
} from "../../src/integration/nestjs/stingerloom-orm-core.module";
import { getMultiTenantEntityManagerToken } from "../../src/integration/nestjs/inject-multi-tenant-entity-manager.decorator";
import type { DatabaseClientOptions } from "../../src/core/DatabaseClientOptions";
import {
  getOrmServiceToken,
  StingerloomOrmService,
} from "../../src/integration/nestjs/stingerloom-orm.service";

class User {}
class Post {}
class Event {}

describe("NestJS Multi-DB Support", () => {
  describe("getEntityManagerToken", () => {
    it("should return EntityManager class for default connection", () => {
      expect(getEntityManagerToken()).toBe(EntityManager);
      expect(getEntityManagerToken("default")).toBe(EntityManager);
    });

    it("should return string token for named connection", () => {
      const token = getEntityManagerToken("analytics");
      expect(typeof token).toBe("string");
      expect(token).toBe("STINGERLOOM_ENTITY_MANAGER_analytics");
    });

    it("should return different tokens for different connections", () => {
      const t1 = getEntityManagerToken("analytics");
      const t2 = getEntityManagerToken("reporting");
      expect(t1).not.toBe(t2);
    });
  });

  describe("getOrmServiceToken", () => {
    it("should return StingerloomOrmService class for default connection", () => {
      expect(getOrmServiceToken()).toBe(StingerloomOrmService);
      expect(getOrmServiceToken("default")).toBe(StingerloomOrmService);
    });

    it("should return string token for named connection", () => {
      const token = getOrmServiceToken("analytics");
      expect(typeof token).toBe("string");
      expect(token).toBe("STINGERLOOM_ORM_SERVICE_analytics");
    });
  });

  describe("makeInjectRepositoryToken", () => {
    it("should return a symbol for default connection", () => {
      const token = makeInjectRepositoryToken(User);
      expect(typeof token).toBe("symbol");
      expect(token.description).toBe(
        `${INJECT_REPOSITORIES_TOKEN}_User`,
      );
    });

    it("should return idempotent token for same entity and connection", () => {
      const t1 = makeInjectRepositoryToken(Post, "default");
      const t2 = makeInjectRepositoryToken(Post, "default");
      expect(t1).toBe(t2);
    });

    it("should return different tokens for same entity on different connections", () => {
      const t1 = makeInjectRepositoryToken(Event, "default");
      const t2 = makeInjectRepositoryToken(Event, "analytics");
      expect(t1).not.toBe(t2);
    });

    it("should include connection name in symbol description for named connection", () => {
      const token = makeInjectRepositoryToken(Event, "analytics");
      expect(token.description).toBe(
        `${INJECT_REPOSITORIES_TOKEN}_Event_analytics`,
      );
    });

    it("should be idempotent for named connections", () => {
      const t1 = makeInjectRepositoryToken(User, "reporting");
      const t2 = makeInjectRepositoryToken(User, "reporting");
      expect(t1).toBe(t2);
    });

    it("should be backward compatible — no connectionName equals default", () => {
      const t1 = makeInjectRepositoryToken(User);
      const t2 = makeInjectRepositoryToken(User, "default");
      expect(t1).toBe(t2);
    });
  });

  describe("StingerloomOrmCoreModule.forRoot", () => {
    it("should use EntityManager class as provider token for default", () => {
      const mod = StingerloomOrmCoreModule.forRoot({
        type: "mysql",
        host: "localhost",
        port: 3306,
        database: "test",
        username: "root",
        password: "",
        entities: [],
      });

      const provider = mod.providers![0] as { provide: unknown };
      expect(provider.provide).toBe(EntityManager);
      expect(mod.exports).toContain(EntityManager);
    });

    it("should use string token for named connection", () => {
      const mod = StingerloomOrmCoreModule.forRoot(
        {
          type: "postgres",
          host: "localhost",
          port: 5432,
          database: "analytics",
          username: "root",
          password: "",
          entities: [],
        },
        "analytics",
      );

      const provider = mod.providers![0] as { provide: unknown };
      expect(provider.provide).toBe("STINGERLOOM_ENTITY_MANAGER_analytics");
      expect(mod.exports).toContain(
        "STINGERLOOM_ENTITY_MANAGER_analytics",
      );
    });
  });

  describe("StingerloomOrmModule.forRoot", () => {
    it("should use class tokens for default connection (backward compat)", () => {
      const mod = StingerloomOrmModule.forRoot({
        type: "mysql",
        host: "localhost",
        port: 3306,
        database: "test",
        username: "root",
        password: "",
        entities: [],
      });

      const serviceProvider = mod.providers![0] as {
        provide: unknown;
        inject: unknown[];
      };
      expect(serviceProvider.provide).toBe(StingerloomOrmService);
      expect(serviceProvider.inject).toContain(EntityManager);
      expect(mod.exports).toContain(StingerloomOrmService);
    });

    it("should use string tokens for named connection", () => {
      const mod = StingerloomOrmModule.forRoot(
        {
          type: "postgres",
          host: "localhost",
          port: 5432,
          database: "analytics",
          username: "root",
          password: "",
          entities: [],
        },
        "analytics",
      );

      const serviceProvider = mod.providers![0] as {
        provide: unknown;
        inject: unknown[];
      };
      expect(serviceProvider.provide).toBe(
        "STINGERLOOM_ORM_SERVICE_analytics",
      );
      expect(serviceProvider.inject).toContain(
        "STINGERLOOM_ENTITY_MANAGER_analytics",
      );
      expect(mod.exports).toContain("STINGERLOOM_ORM_SERVICE_analytics");
    });
  });

  describe("getOrmOptionsToken", () => {
    it("should return fixed token for default connection", () => {
      expect(getOrmOptionsToken()).toBe("STINGERLOOM_ORM_OPTIONS");
      expect(getOrmOptionsToken("default")).toBe("STINGERLOOM_ORM_OPTIONS");
    });

    it("should return per-connection token for named connection", () => {
      expect(getOrmOptionsToken("analytics")).toBe(
        "STINGERLOOM_ORM_OPTIONS_analytics",
      );
    });
  });

  describe("StingerloomOrmCoreModule.forRootAsync", () => {
    const sampleOptions: DatabaseClientOptions = {
      type: "mysql",
      host: "localhost",
      port: 3306,
      database: "test",
      username: "root",
      password: "",
      entities: [],
    };

    it("useFactory: wires options provider with inject and em provider", () => {
      class ConfigService {}
      const mod = StingerloomOrmCoreModule.forRootAsync({
        imports: [],
        useFactory: () => sampleOptions,
        inject: [ConfigService],
      });

      const providers = mod.providers as Array<{
        provide: unknown;
        inject?: unknown[];
      }>;
      const optsProvider = providers.find(
        (p) => p.provide === "STINGERLOOM_ORM_OPTIONS",
      )!;
      const emProvider = providers.find((p) => p.provide === EntityManager)!;

      expect(optsProvider).toBeDefined();
      expect(optsProvider.inject).toEqual([ConfigService]);
      // EM provider must inject (in this exact order) the options token plus
      // the MultiTenantEntityManager token. The MTEM value is a misuse-
      // sentinel when tenantStrategy != "database", but the wiring contract
      // — both tokens, in this order — has to hold either way. Testing only
      // the first element would let an accidental drop of the MTEM token
      // through, which is exactly the regression Copilot caught.
      expect(emProvider.inject).toEqual([
        "STINGERLOOM_ORM_OPTIONS",
        getMultiTenantEntityManagerToken(),
      ]);
      expect(mod.exports).toContain(EntityManager);
    });

    it("useFactory: named connection uses per-connection options token", () => {
      const mod = StingerloomOrmCoreModule.forRootAsync({
        useFactory: () => sampleOptions,
        connectionName: "analytics",
      });

      const providers = mod.providers as Array<{
        provide: unknown;
        inject?: unknown[];
      }>;
      const emProvider = providers.find(
        (p) => p.provide === "STINGERLOOM_ENTITY_MANAGER_analytics",
      )!;

      expect(emProvider).toBeDefined();
      // Same wiring contract as the default-connection test, scoped to the
      // analytics connection name.
      expect(emProvider.inject).toEqual([
        "STINGERLOOM_ORM_OPTIONS_analytics",
        getMultiTenantEntityManagerToken("analytics"),
      ]);
      expect(mod.exports).toContain("STINGERLOOM_ENTITY_MANAGER_analytics");
    });

    it("useClass: registers the factory class as a provider and binds options", () => {
      class OrmOptionsFactory implements StingerloomOrmOptionsFactory {
        createStingerloomOrmOptions(): DatabaseClientOptions {
          return sampleOptions;
        }
      }

      const mod = StingerloomOrmCoreModule.forRootAsync({
        useClass: OrmOptionsFactory,
      });

      const providers = mod.providers as Array<{
        provide: unknown;
        useClass?: unknown;
        inject?: unknown[];
      }>;

      const classProvider = providers.find(
        (p) => p.provide === OrmOptionsFactory,
      )!;
      const optsProvider = providers.find(
        (p) => p.provide === "STINGERLOOM_ORM_OPTIONS",
      )!;

      expect(classProvider.useClass).toBe(OrmOptionsFactory);
      expect(optsProvider.inject).toEqual([OrmOptionsFactory]);
    });

    it("useExisting: does NOT register the class and reuses an external one", () => {
      class ExistingFactory implements StingerloomOrmOptionsFactory {
        createStingerloomOrmOptions(): DatabaseClientOptions {
          return sampleOptions;
        }
      }

      const mod = StingerloomOrmCoreModule.forRootAsync({
        useExisting: ExistingFactory,
      });

      const providers = mod.providers as Array<{
        provide: unknown;
        useClass?: unknown;
        inject?: unknown[];
      }>;

      const classProvider = providers.find(
        (p) => p.provide === ExistingFactory,
      );
      const optsProvider = providers.find(
        (p) => p.provide === "STINGERLOOM_ORM_OPTIONS",
      )!;

      expect(classProvider).toBeUndefined();
      expect(optsProvider.inject).toEqual([ExistingFactory]);
    });

    it("throws when none of useFactory/useClass/useExisting provided", () => {
      expect(() =>
        StingerloomOrmCoreModule.forRootAsync({}),
      ).toThrow(/useFactory, useClass, or useExisting/);
    });

    it("useFactory: resolves options asynchronously", async () => {
      const mod = StingerloomOrmCoreModule.forRootAsync({
        useFactory: async () => sampleOptions,
      });

      const providers = mod.providers as Array<{
        provide: unknown;
        useFactory?: (...args: unknown[]) => unknown;
      }>;
      const optsProvider = providers.find(
        (p) => p.provide === "STINGERLOOM_ORM_OPTIONS",
      )!;

      const resolved = await optsProvider.useFactory!();
      expect(resolved).toBe(sampleOptions);
    });
  });

  describe("StingerloomOrmModule.forRootAsync", () => {
    it("wires service provider over the async core module", () => {
      class ConfigService {}
      const mod = StingerloomOrmModule.forRootAsync({
        useFactory: (_cfg: ConfigService) => ({
          type: "mysql",
          host: "localhost",
          port: 3306,
          database: "test",
          username: "root",
          password: "",
          entities: [],
        }),
        inject: [ConfigService],
      });

      const serviceProvider = mod.providers![0] as {
        provide: unknown;
        inject: unknown[];
      };
      expect(serviceProvider.provide).toBe(StingerloomOrmService);
      expect(serviceProvider.inject).toContain(EntityManager);
      expect(mod.exports).toContain(StingerloomOrmService);
      expect(mod.global).toBe(true);
    });

    it("named connection: service + em tokens are per-connection", () => {
      const mod = StingerloomOrmModule.forRootAsync({
        connectionName: "analytics",
        useFactory: () => ({
          type: "postgres",
          host: "localhost",
          port: 5432,
          database: "analytics",
          username: "root",
          password: "",
          entities: [],
        }),
      });

      const serviceProvider = mod.providers![0] as {
        provide: unknown;
        inject: unknown[];
      };
      expect(serviceProvider.provide).toBe(
        "STINGERLOOM_ORM_SERVICE_analytics",
      );
      expect(serviceProvider.inject).toContain(
        "STINGERLOOM_ENTITY_MANAGER_analytics",
      );
    });
  });

  describe("StingerloomOrmModule.forFeature", () => {
    it("should inject from default EntityManager when no connectionName", () => {
      const mod = StingerloomOrmModule.forFeature([User, Post]);

      const providers = mod.providers as Array<{
        provide: symbol;
        inject: unknown[];
      }>;
      expect(providers).toHaveLength(2);
      for (const p of providers) {
        expect(p.inject).toContain(EntityManager);
      }
    });

    it("should inject from named EntityManager for named connection", () => {
      const mod = StingerloomOrmModule.forFeature([Event], "analytics");

      const providers = mod.providers as Array<{
        provide: symbol;
        inject: unknown[];
      }>;
      expect(providers).toHaveLength(1);
      expect(providers[0].inject).toContain(
        "STINGERLOOM_ENTITY_MANAGER_analytics",
      );
    });
  });
});
