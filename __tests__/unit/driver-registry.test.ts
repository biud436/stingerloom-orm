import { DriverRegistry, DriverFactory } from "../../src/dialects/DriverRegistry";

describe("DriverRegistry (#229)", () => {
  beforeEach(() => {
    DriverRegistry.clear();
  });

  const mockFactory: DriverFactory = {
    createDriver: jest.fn().mockReturnValue({ hasTable: jest.fn() }),
    createDataSource: jest.fn().mockReturnValue({ createConnection: jest.fn() }),
  };

  it("should register and retrieve a driver factory", () => {
    DriverRegistry.register("oracle", mockFactory);

    expect(DriverRegistry.has("oracle")).toBe(true);
    expect(DriverRegistry.get("oracle")).toBe(mockFactory);
  });

  it("should return undefined for unregistered type", () => {
    expect(DriverRegistry.has("oracle")).toBe(false);
    expect(DriverRegistry.get("oracle")).toBeUndefined();
  });

  it("should unregister a driver factory", () => {
    DriverRegistry.register("oracle", mockFactory);
    DriverRegistry.unregister("oracle");

    expect(DriverRegistry.has("oracle")).toBe(false);
  });

  it("should list all registered types", () => {
    DriverRegistry.register("oracle", mockFactory);
    DriverRegistry.register("cockroach", mockFactory);

    const types = DriverRegistry.getRegisteredTypes();
    expect(types).toContain("oracle");
    expect(types).toContain("cockroach");
    expect(types).toHaveLength(2);
  });

  it("should overwrite existing registration", () => {
    const factory2: DriverFactory = {
      createDriver: jest.fn(),
      createDataSource: jest.fn(),
    };

    DriverRegistry.register("oracle", mockFactory);
    DriverRegistry.register("oracle", factory2);

    expect(DriverRegistry.get("oracle")).toBe(factory2);
  });

  it("should clear all registrations", () => {
    DriverRegistry.register("oracle", mockFactory);
    DriverRegistry.register("cockroach", mockFactory);
    DriverRegistry.clear();

    expect(DriverRegistry.getRegisteredTypes()).toHaveLength(0);
  });
});
