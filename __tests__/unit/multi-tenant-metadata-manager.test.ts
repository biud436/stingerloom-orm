import {
  MultiTenantMetadataManager,
  getGlobalMetadataManager,
  resetGlobalMetadataManager,
} from "../../src/metadata/MultiTenantMetadataManager";

describe("MultiTenantMetadataManager", () => {
  let manager: MultiTenantMetadataManager;

  beforeEach(() => {
    manager = new MultiTenantMetadataManager();
  });

  describe("constructor", () => {
    it("should initialize with public tenant", () => {
      expect(manager.getCurrentTenant()).toBe("public");
    });

    it("should have public layer by default", () => {
      const layers = manager.getLayersInfo();
      expect(layers).toHaveLength(1);
      expect(layers[0].name).toBe("public");
    });
  });

  describe("switchTenant", () => {
    it("should switch current tenant", () => {
      manager.createTenant("tenant_1");
      manager.switchTenant("tenant_1");

      expect(manager.getCurrentTenant()).toBe("tenant_1");
    });
  });

  describe("createTenant", () => {
    it("should create a new tenant layer", () => {
      // public layer needs a writable work layer first
      const store = manager.getStore();
      store.addLayer("public_work", false);
      store.setContext("public_work");

      manager.createTenant("tenant_1", "public_work");

      const layers = manager.getLayersInfo();
      const layerNames = layers.map((l) => l.name);
      expect(layerNames).toContain("tenant_1");
    });

    it("should throw when copying from non-existent layer", () => {
      expect(() => {
        manager.createTenant("tenant_1", "non_existent");
      }).toThrow();
    });
  });

  describe("registerEntity / getAllEntities", () => {
    it("should register and retrieve entities in current context", () => {
      const store = manager.getStore();
      store.addLayer("work", false);
      store.setContext("work");

      manager.switchTenant("work");
      manager.registerEntity({ name: "User", columns: [] });
      manager.registerEntity({ name: "Post", columns: [] });

      const entities = manager.getAllEntities();
      expect(entities).toHaveLength(2);
    });
  });

  describe("registerColumn", () => {
    it("should register column metadata in current context", () => {
      const store = manager.getStore();
      store.addLayer("work", false);
      store.setContext("work");

      manager.switchTenant("work");
      manager.registerColumn({ name: "id", type: "int" });

      const columns = manager.getColumnScanner().allMetadata();
      expect(columns).toHaveLength(1);
    });
  });

  describe("getEntity", () => {
    it("should scan for entity by target class", () => {
      class User {}

      const store = manager.getStore();
      store.addLayer("work", false);
      store.setContext("work");

      const entityScanner = manager.getEntityScanner();
      entityScanner.set("User", { target: User, name: "users" });

      const result = manager.getEntity(User);
      expect(result).toEqual({ target: User, name: "users" });
    });

    it("should return null for unregistered entity", () => {
      class Unknown {}

      const store = manager.getStore();
      store.addLayer("work", false);
      store.setContext("work");

      const result = manager.getEntity(Unknown);
      expect(result).toBeNull();
    });
  });

  describe("removeTenant", () => {
    it("should remove a tenant layer", () => {
      const store = manager.getStore();
      store.addLayer("tenant_1", false);

      manager.removeTenant("tenant_1");

      const layers = manager.getLayersInfo();
      const layerNames = layers.map((l) => l.name);
      expect(layerNames).not.toContain("tenant_1");
    });

    it("should throw when trying to remove public tenant", () => {
      expect(() => {
        manager.removeTenant("public");
      }).toThrow(/public/);
    });
  });

  describe("getEntityScanner / getColumnScanner / getStore", () => {
    it("should return scanner and store instances", () => {
      expect(manager.getEntityScanner()).toBeDefined();
      expect(manager.getColumnScanner()).toBeDefined();
      expect(manager.getStore()).toBeDefined();
    });
  });
});

describe("Global MetadataManager", () => {
  beforeEach(() => {
    resetGlobalMetadataManager();
  });

  it("should return a singleton instance", () => {
    const instance1 = getGlobalMetadataManager();
    const instance2 = getGlobalMetadataManager();

    expect(instance1).toBe(instance2);
  });

  it("should return a fresh instance after reset", () => {
    const instance1 = getGlobalMetadataManager();
    resetGlobalMetadataManager();
    const instance2 = getGlobalMetadataManager();

    expect(instance1).not.toBe(instance2);
  });

  it("should start with public tenant after reset", () => {
    const instance = getGlobalMetadataManager();
    expect(instance.getCurrentTenant()).toBe("public");
  });
});
