import "reflect-metadata";
import {
  StinglerloomOrmService,
  STINGERLOOM_ORM_SERVICE_TOKEN,
  getOrmServiceToken,
} from "../../src/integration/nestjs/stingerloom-orm.service";

describe("StinglerloomOrmService", () => {
  let service: StinglerloomOrmService;
  let mockEntityManager: any;

  beforeEach(() => {
    jest.clearAllMocks();
    StinglerloomOrmService.captured = {} as any;

    mockEntityManager = {
      propagateShutdown: jest.fn().mockResolvedValue(undefined),
      getRepository: jest.fn().mockReturnValue({ find: jest.fn() }),
    };

    service = new StinglerloomOrmService(mockEntityManager);
  });

  describe("getOrmServiceToken()", () => {
    it("should return StinglerloomOrmService class for default connection", () => {
      const token = getOrmServiceToken();
      expect(token).toBe(StinglerloomOrmService);
    });

    it("should return StinglerloomOrmService class for explicit 'default'", () => {
      const token = getOrmServiceToken("default");
      expect(token).toBe(StinglerloomOrmService);
    });

    it("should return named string token for non-default connection", () => {
      const token = getOrmServiceToken("secondary");
      expect(token).toBe("STINGERLOOM_ORM_SERVICE_secondary");
    });

    it("should return different tokens for different connection names", () => {
      const token1 = getOrmServiceToken("db1");
      const token2 = getOrmServiceToken("db2");
      expect(token1).not.toBe(token2);
    });
  });

  describe("STINGERLOOM_ORM_SERVICE_TOKEN", () => {
    it("should be a Symbol", () => {
      expect(typeof STINGERLOOM_ORM_SERVICE_TOKEN).toBe("symbol");
    });
  });

  describe("onModuleInit()", () => {
    it("should warn when forRoot was not called", async () => {
      // captured is empty → forRoot was not called
      await service.onModuleInit();
      // Should not throw, just warn
    });

    it("should initialize when forRoot was called", async () => {
      StinglerloomOrmService.captured[STINGERLOOM_ORM_SERVICE_TOKEN] = true;

      await service.onModuleInit();
      // Should complete without error
    });
  });

  describe("onApplicationShutdown()", () => {
    it("should propagate shutdown to entity manager", async () => {
      await service.onApplicationShutdown();

      expect(mockEntityManager.propagateShutdown).toHaveBeenCalled();
    });
  });

  describe("getRepository()", () => {
    it("should return repository for entity class", () => {
      class User {}
      const repo = service.getRepository(User);
      expect(repo).toBeDefined();
      expect(mockEntityManager.getRepository).toHaveBeenCalledWith(User);
    });

    it("should throw when entity manager is not initialized", () => {
      const badService = new StinglerloomOrmService(null as any);
      class User {}
      expect(() => badService.getRepository(User)).toThrow(
        /EntityManager not initialized/,
      );
    });
  });

  describe("getEntityManager()", () => {
    it("should return the entity manager", () => {
      const em = service.getEntityManager();
      expect(em).toBe(mockEntityManager);
    });

    it("should throw when entity manager is not initialized", () => {
      const badService = new StinglerloomOrmService(null as any);
      expect(() => badService.getEntityManager()).toThrow(
        /EntityManager not initialized/,
      );
    });
  });
});
