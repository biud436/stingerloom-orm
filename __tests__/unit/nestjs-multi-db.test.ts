import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { MultiTenantEntityManager } from "../../src/core/MultiTenantEntityManager";
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
      expect(token.description).toContain(`${INJECT_REPOSITORIES_TOKEN}_User`);
      // Remediation rides in the description so Nest's unresolved-dependency
      // error names the fix by itself.
      expect(token.description).toContain(
        "StingerloomOrmModule.forFeature([User])",
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
      expect(token.description).toContain(
        `${INJECT_REPOSITORIES_TOKEN}_Event_analytics`,
      );
      expect(token.description).toContain(
        'StingerloomOrmModule.forFeature([Event], "analytics")',
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

  // ────────────────────────────────────────────────────────────
  // forRootAsync MTEM sentinel runtime behavior (#295)
  //
  // The static wiring tests above only assert the inject array shape — they
  // never invoke useFactory. The misuse-sentinel Proxy and the EM-requires-MTEM
  // throw are exactly the kind of regressions that pass shape checks while
  // silently breaking runtime behavior (e.g. someone swaps Reflect.get and
  // forgets the set trap, accidental @InjectMultiTenantEntityManager() on a
  // non-database connection silently returns an empty object). These tests
  // exercise both useFactory paths so removing either guard fails the suite.
  // ────────────────────────────────────────────────────────────
  describe("forRootAsync MTEM sentinel runtime behavior (#295)", () => {
    /**
     * Pulls the MTEM and EM useFactory functions plus the MTEM token out of
     * a freshly-built module so each test runs against an isolated wiring.
     */
    function buildModule(connectionName?: string) {
      const sample: DatabaseClientOptions = {
        type: "mysql",
        host: "localhost",
        port: 3306,
        database: "test",
        username: "root",
        password: "",
        entities: [],
      };
      const mod = StingerloomOrmCoreModule.forRootAsync({
        useFactory: () => sample,
        connectionName,
      });
      const providers = mod.providers as Array<{
        provide: unknown;
        useFactory?: (...args: unknown[]) => unknown;
        inject?: unknown[];
      }>;
      const mtemToken = getMultiTenantEntityManagerToken(connectionName);
      const emToken = connectionName && connectionName !== "default"
        ? `STINGERLOOM_ENTITY_MANAGER_${connectionName}`
        : EntityManager;
      const mtemProvider = providers.find((p) => p.provide === mtemToken)!;
      const emProvider = providers.find((p) => p.provide === emToken)!;
      return {
        mtemFactory: mtemProvider.useFactory! as (
          options: DatabaseClientOptions,
        ) => Promise<unknown>,
        emFactory: emProvider.useFactory! as (
          options: DatabaseClientOptions,
          mtem?: unknown,
        ) => Promise<unknown>,
      };
    }

    it("MTEM useFactory returns a sentinel proxy when tenantStrategy is not 'database'", async () => {
      const { mtemFactory } = buildModule("analytics");
      const sentinel = await mtemFactory({
        type: "mysql",
        host: "localhost",
        port: 3306,
        database: "test",
        username: "root",
        password: "",
        entities: [],
        // tenantStrategy intentionally absent — equivalent to a non-database
        // connection that should never receive @InjectMultiTenantEntityManager().
      });

      // Calling any of MTEM's real public methods on the sentinel throws
      // an actionable error mentioning the connection name. Hitting a
      // generic `undefined is not a function` here would mean the misuse
      // guard regressed and the user lost the helpful message.
      expect(() => (sentinel as any).query()).toThrow(/analytics/);
      expect(() => (sentinel as any).register()).toThrow(
        /tenantStrategy is "database"/,
      );
      // Arbitrary property access (which framework introspection does
      // unconditionally on every resolved provider value) must NOT throw —
      // it's not user code calling MTEM, so it has to flow through as a
      // normal `undefined` so module bootstrap can complete.
      expect(() => (sentinel as any).somethingThatIsNotMtemAtAll).not.toThrow();
      expect((sentinel as any).somethingThatIsNotMtemAtAll).toBeUndefined();
    });

    it("MTEM sentinel does not throw on framework / runtime symbol probes", () => {
      // Regression: NestJS lifecycle-hook detection, util.inspect, and Node
      // 23's `using`-style resource management probe well-known symbols on
      // every resolved provider instance. Throwing on those probes crashed
      // module bootstrap on connections that intentionally don't use the
      // database strategy (the misuse error fired before any user code ever
      // accessed MTEM). Symbol-keyed access must therefore return `undefined`
      // and only string-keyed access (real method calls) should trigger the
      // guard.
      const { mtemFactory } = buildModule("symbol-probe");
      return mtemFactory({
        type: "mysql",
        host: "localhost",
        port: 3306,
        database: "test",
        username: "root",
        password: "",
        entities: [],
      }).then((sentinel) => {
        const probes: (symbol | undefined)[] = [
          Symbol.toPrimitive,
          Symbol.toStringTag,
          Symbol.iterator,
          Symbol.asyncIterator,
          Symbol.hasInstance,
          (Symbol as unknown as { dispose?: symbol }).dispose,
          (Symbol as unknown as { asyncDispose?: symbol }).asyncDispose,
          Symbol.for("nodejs.util.inspect.custom"),
        ];
        for (const probe of probes) {
          if (probe === undefined) continue;
          expect(() =>
            (sentinel as unknown as Record<symbol, unknown>)[probe],
          ).not.toThrow();
          expect(
            (sentinel as unknown as Record<symbol, unknown>)[probe],
          ).toBeUndefined();
        }
      });
    });

    it("MTEM useFactory builds a real MultiTenantEntityManager under tenantStrategy: 'database'", async () => {
      const { mtemFactory } = buildModule();

      // Mock register() so we don't open a real pool — the unit-level
      // contract is "factory constructs MTEM and runs register()", nothing
      // beyond that.
      const registerSpy = jest
        .spyOn(MultiTenantEntityManager.prototype, "register")
        .mockResolvedValue(undefined as unknown as void);

      try {
        const mtem = await mtemFactory({
          type: "mysql",
          host: "localhost",
          port: 3306,
          database: "admin",
          username: "root",
          password: "",
          entities: [],
          tenantStrategy: "database",
          tenantDatabaseResolver: () => "tenant-db",
        });
        expect(mtem).toBeInstanceOf(MultiTenantEntityManager);
        expect(registerSpy).toHaveBeenCalledTimes(1);
      } finally {
        registerSpy.mockRestore();
      }
    });

    it("EM useFactory throws when tenantStrategy='database' but the MTEM is a sentinel", async () => {
      const { mtemFactory, emFactory } = buildModule();
      const sentinel = await mtemFactory({
        type: "mysql",
        host: "localhost",
        port: 3306,
        database: "test",
        username: "root",
        password: "",
        entities: [],
      });

      await expect(
        emFactory(
          {
            type: "mysql",
            host: "localhost",
            port: 3306,
            database: "admin",
            username: "root",
            password: "",
            entities: [],
            tenantStrategy: "database",
          },
          sentinel,
        ),
      ).rejects.toThrow(/MultiTenantEntityManager provider is required/);
    });

    it("EM useFactory throws when tenantStrategy='database' but the MTEM is undefined", async () => {
      const { emFactory } = buildModule();

      await expect(
        emFactory(
          {
            type: "mysql",
            host: "localhost",
            port: 3306,
            database: "admin",
            username: "root",
            password: "",
            entities: [],
            tenantStrategy: "database",
          },
          undefined,
        ),
      ).rejects.toThrow(/MultiTenantEntityManager provider is required/);
    });

    it("EM useFactory ignores the sentinel and returns a fresh EntityManager when tenantStrategy is not 'database'", async () => {
      const { mtemFactory, emFactory } = buildModule("misuse");
      const sentinel = await mtemFactory({
        type: "mysql",
        host: "localhost",
        port: 3306,
        database: "test",
        username: "root",
        password: "",
        entities: [],
      });

      const registerSpy = jest
        .spyOn(EntityManager.prototype, "register")
        .mockResolvedValue(undefined as unknown as void);

      try {
        const em = await emFactory(
          {
            type: "mysql",
            host: "localhost",
            port: 3306,
            database: "test",
            username: "root",
            password: "",
            entities: [],
            // tenantStrategy intentionally absent — sentinel must be ignored.
          },
          sentinel,
        );
        expect(em).toBeInstanceOf(EntityManager);
        expect(registerSpy).toHaveBeenCalledTimes(1);
      } finally {
        registerSpy.mockRestore();
      }
    });

    it("sentinel symbol round-trips: real MTEM, sentinel, null all return the right truth value", async () => {
      const { mtemFactory } = buildModule("rt");
      const sentinel = await mtemFactory({
        type: "mysql",
        host: "localhost",
        port: 3306,
        database: "test",
        username: "root",
        password: "",
        entities: [],
      });
      const real = new MultiTenantEntityManager();
      const symbolKey = Symbol.for("stingerloom.mtem.misuse-sentinel");

      // The sentinel exposes the marker symbol as `true`; a real MTEM does not.
      expect((sentinel as Record<symbol, unknown>)[symbolKey]).toBe(true);
      expect((real as unknown as Record<symbol, unknown>)[symbolKey]).toBeUndefined();

      // The internal `isMtemMisuseSentinel` helper is exercised by the EM
      // factory tests above — its `null`/`undefined` robustness is also
      // implicit there (the "MTEM is undefined" case).
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
    // The EntityManager is injected as optional so a connectionName typo
    // reaches the factory (which raises an actionable OrmError) instead of
    // dying in Nest's resolver with a generic unresolved-dependency error.
    it("should optionally inject from default EntityManager when no connectionName", () => {
      const mod = StingerloomOrmModule.forFeature([User, Post]);

      const providers = mod.providers as Array<{
        provide: symbol;
        inject: Array<{ token: unknown; optional: boolean }>;
      }>;
      expect(providers).toHaveLength(2);
      for (const p of providers) {
        expect(p.inject).toEqual([{ token: EntityManager, optional: true }]);
      }
    });

    it("should optionally inject from named EntityManager for named connection", () => {
      const mod = StingerloomOrmModule.forFeature([Event], "analytics");

      const providers = mod.providers as Array<{
        provide: symbol;
        inject: Array<{ token: unknown; optional: boolean }>;
      }>;
      expect(providers).toHaveLength(1);
      expect(providers[0].inject).toEqual([
        { token: "STINGERLOOM_ENTITY_MANAGER_analytics", optional: true },
      ]);
    });
  });
});
