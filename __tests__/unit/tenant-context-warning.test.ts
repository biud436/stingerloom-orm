import "reflect-metadata";
import { MetadataContext } from "../../src/metadata/MetadataContext";

jest.mock("../../src/DatabaseClient", () => {
  return {
    DatabaseClient: {
      getInstance: jest.fn().mockReturnValue({
        type: "postgres",
        getType: jest.fn().mockReturnValue("postgres"),
        getConnection: jest.fn(),
        getOptions: jest.fn().mockReturnValue({ synchronize: false }),
        connect: jest.fn(),
      }),
    },
  };
});

import { EntityManager } from "../../src/core/EntityManager";
import { Logger } from "../../src/utils/Logger";

describe("assertTenantContext", () => {
  let em: EntityManager;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    em = new EntityManager();
    warnSpy = jest.spyOn((em as any).logger as Logger, "warn");
    MetadataContext.reset();
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("should return false and warn when no tenant context is active", () => {
    const result = em.assertTenantContext();

    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[multi-tenancy]"),
    );
  });

  it("should return true and not warn inside MetadataContext.run()", () => {
    MetadataContext.run("tenant_1", () => {
      const result = em.assertTenantContext();

      expect(result).toBe(true);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  it("should warn on every call (user controls call frequency)", () => {
    em.assertTenantContext();
    em.assertTenantContext();
    em.assertTenantContext();

    expect(warnSpy).toHaveBeenCalledTimes(3);
  });
});
