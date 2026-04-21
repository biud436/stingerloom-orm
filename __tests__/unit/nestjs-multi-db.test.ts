import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import {
  makeInjectRepositoryToken,
  getEntityManagerToken,
  StingerloomOrmModule,
  INJECT_REPOSITORIES_TOKEN,
} from "../../src/integration/nestjs/stingerloom-orm.module";
import { StingerloomOrmCoreModule } from "../../src/integration/nestjs/stingerloom-orm-core.module";
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
