import {
  LayeredMetadataStore,
  MetadataLayer,
  MetadataPath,
  LayeredEntityScanner,
  LayeredColumnScanner,
} from "../../src/metadata";
import { MetadataContext } from "../../src/metadata/MetadataContext";

describe("MetadataLayer", () => {
  let layer: MetadataLayer;

  beforeEach(() => {
    layer = new MetadataLayer("test-layer", false);
  });

  it("should create a layer with name", () => {
    expect(layer.getName()).toBe("test-layer");
    expect(layer.isReadOnlyLayer()).toBe(false);
  });

  it("should store and retrieve metadata", () => {
    layer.set("key1", { value: "test" });
    expect(layer.get("key1")).toEqual({ value: "test" });
  });

  it("should not allow modifications to read-only layer", () => {
    const readOnlyLayer = new MetadataLayer("readonly", true);
    expect(() => {
      readOnlyLayer.set("key1", "value");
    }).toThrow(/read-only/);
  });

  it("should check key existence", () => {
    layer.set("key1", "value");
    expect(layer.has("key1")).toBe(true);
    expect(layer.has("key2")).toBe(false);
  });

  it("should return all keys and values", () => {
    layer.set("key1", "value1");
    layer.set("key2", "value2");

    expect(layer.keys()).toContain("key1");
    expect(layer.keys()).toContain("key2");
    expect(layer.values()).toContain("value1");
    expect(layer.values()).toContain("value2");
  });

  it("should clone layer", () => {
    layer.set("key1", { nested: "value" });
    const cloned = layer.clone("cloned-layer");

    expect(cloned.getName()).toBe("cloned-layer");
    expect(cloned.get("key1")).toEqual({ nested: "value" });
  });
});

describe("MetadataPath (Trie)", () => {
  let trie: MetadataPath;

  beforeEach(() => {
    trie = new MetadataPath();
  });

  it("should insert and search paths", () => {
    trie.insert("public/users", { type: "entity" });
    expect(trie.search("public/users")).toEqual({ type: "entity" });
  });

  it("should handle nested paths", () => {
    trie.insert("tenant_1/schema_v2/posts", { type: "entity" });
    expect(trie.search("tenant_1/schema_v2/posts")).toEqual({ type: "entity" });
  });

  it("should find by prefix", () => {
    trie.insert("public/users", { name: "users" });
    trie.insert("public/posts", { name: "posts" });
    trie.insert("tenant_1/users", { name: "users_v2" });

    const publicPaths = trie.findByPrefix("public");
    expect(publicPaths).toHaveLength(2);
    expect(publicPaths.map((p) => p.value.name)).toContain("users");
    expect(publicPaths.map((p) => p.value.name)).toContain("posts");
  });

  it("should delete paths", () => {
    trie.insert("public/users", { name: "users" });
    expect(trie.has("public/users")).toBe(true);

    trie.delete("public/users");
    expect(trie.has("public/users")).toBe(false);
  });

  it("should normalize paths", () => {
    trie.insert("/public//users/", { name: "users" });
    expect(trie.search("public/users")).toEqual({ name: "users" });
  });
});

describe("LayeredMetadataStore", () => {
  let store: LayeredMetadataStore;

  beforeEach(() => {
    store = new LayeredMetadataStore();
  });

  it("should create with public layer by default", () => {
    const layers = store.getLayersInfo();
    expect(layers).toHaveLength(1);
    expect(layers[0].name).toBe("public");
    expect(layers[0].isReadOnly).toBe(true);
  });

  it("should add new layers", () => {
    store.addLayer("tenant_1", false);
    expect(store.getLayer("tenant_1")).toBeDefined();
  });

  it("should set and get metadata in current context", () => {
    store.setContext("public");
    store.addLayer("public_work", false);
    store.setContext("public_work");

    store.set("user_entity", { name: "User" });
    expect(store.get("user_entity")).toEqual({ name: "User" });
  });

  it("should implement Copy-on-Write (병합된 뷰)", () => {
    // Add the base schema to the public layer (public is read-only, so a work layer is needed)
    store.addLayer("public_work", false);
    store.setContext("public_work");
    store.set("user_entity", { name: "User", columns: ["id", "name"] });

    // Modify the schema in tenant_1
    store.addLayer("tenant_1", false);
    store.setContext("tenant_1");
    store.set("user_entity", {
      name: "User",
      columns: ["id", "name", "email"],
    });

    // Reading from tenant_1 returns the modified schema
    expect(store.get("user_entity")).toEqual({
      name: "User",
      columns: ["id", "name", "email"],
    });

    // Reading from public_work returns the original schema
    store.setContext("public_work");
    expect(store.get("user_entity")).toEqual({
      name: "User",
      columns: ["id", "name"],
    });
  });

  it("should copy layer", () => {
    store.addLayer("source", false);
    store.setContext("source");
    store.set("entity1", { name: "Entity1" });

    store.copyLayer("source", "target");
    store.setContext("target");

    expect(store.get("entity1")).toEqual({ name: "Entity1" });
  });

  it("should merge layers", () => {
    store.addLayer("layer1", false);
    store.setContext("layer1");
    store.set("key1", "value1");

    store.addLayer("layer2", false);
    store.setContext("layer2");
    store.set("key2", "value2");

    store.mergeLayer("layer2", "layer1");
    store.setContext("layer1");

    expect(store.get("key1")).toBe("value1");
    expect(store.get("key2")).toBe("value2");
  });

  it("should not allow removing public layer", () => {
    expect(() => {
      store.removeLayer("public");
    }).toThrow(/public/);
  });

  it("should get all metadata in context (merged view)", () => {
    // Seed data directly on the public (lower) layer
    const publicLayer = store.getLayer("public")!;
    (publicLayer as any).store = (publicLayer as any).store || publicLayer;
    // public is read-only, so access its internal Map directly
    publicLayer["metadata"].set("entity1", { name: "Entity1" });
    publicLayer["metadata"].set("entity2", { name: "Entity2" });

    store.addLayer("tenant_1", false);
    store.setContext("tenant_1");
    store.set("entity2", { name: "Entity2_Modified" }); // Override
    store.set("entity3", { name: "Entity3" }); // Add

    const allData = store.getAllInContext();
    expect(allData.size).toBe(3);
    expect(allData.get("entity1")).toEqual({ name: "Entity1" }); // public fallback
    expect(allData.get("entity2")).toEqual({ name: "Entity2_Modified" }); // Upper layer wins
    expect(allData.get("entity3")).toEqual({ name: "Entity3" });
  });

  it("should isolate tenant metadata — tenant_2 must NOT see tenant_1 data", () => {
    // Shared data on the public (lower) layer
    const publicLayer = store.getLayer("public")!;
    publicLayer["metadata"].set("shared_entity", { name: "Shared" });

    // tenant_1 data
    store.addLayer("tenant_1", false);
    store.setContext("tenant_1");
    store.set("tenant1_only", { name: "T1_Only" });
    store.set("shared_entity", { name: "Shared_Modified_T1" });

    // tenant_2 data
    store.addLayer("tenant_2", false);
    store.setContext("tenant_2");
    store.set("tenant2_only", { name: "T2_Only" });

    // tenant_1 context: must see only public + tenant_1
    const t1Data = store.getAllInContext("tenant_1");
    expect(t1Data.get("shared_entity")).toEqual({ name: "Shared_Modified_T1" });
    expect(t1Data.get("tenant1_only")).toEqual({ name: "T1_Only" });
    expect(t1Data.has("tenant2_only")).toBe(false); // tenant_2 data is isolated

    // tenant_2 context: must see only public + tenant_2
    const t2Data = store.getAllInContext("tenant_2");
    expect(t2Data.get("shared_entity")).toEqual({ name: "Shared" }); // public original
    expect(t2Data.get("tenant2_only")).toEqual({ name: "T2_Only" });
    expect(t2Data.has("tenant1_only")).toBe(false); // tenant_1 data is isolated

    // public context: must see only public
    const publicData = store.getAllInContext("public");
    expect(publicData.get("shared_entity")).toEqual({ name: "Shared" });
    expect(publicData.has("tenant1_only")).toBe(false);
    expect(publicData.has("tenant2_only")).toBe(false);
  });
});

describe("LayeredMetadataScanner", () => {
  let store: LayeredMetadataStore;
  let entityScanner: LayeredEntityScanner;
  let columnScanner: LayeredColumnScanner;

  beforeEach(() => {
    store = new LayeredMetadataStore();
    entityScanner = new LayeredEntityScanner(store);
    columnScanner = new LayeredColumnScanner(store);
  });

  it("should create unique keys", () => {
    const key1 = entityScanner.createUniqueKey();
    const key2 = entityScanner.createUniqueKey();
    expect(key1).not.toBe(key2);
  });

  it("should set and get metadata with prefix", () => {
    store.addLayer("test_layer", false);
    store.setContext("test_layer");

    entityScanner.set("User", { name: "User", type: "entity" });
    const result = entityScanner.get("User");

    expect(result).toEqual({ name: "User", type: "entity" });
  });

  it("should return all metadata with filtering by prefix", () => {
    store.addLayer("test_layer", false);
    store.setContext("test_layer");

    entityScanner.set("User", { name: "User" });
    entityScanner.set("Post", { name: "Post" });
    columnScanner.set("id", { name: "id", type: "int" });

    const entities = entityScanner.allMetadata();
    const columns = columnScanner.allMetadata();

    expect(entities).toHaveLength(2);
    expect(columns).toHaveLength(1);
  });

  it("should scan entities (기존 API 호환)", () => {
    class User {}
    class Post {}

    store.addLayer("test_layer", false);
    store.setContext("test_layer");

    entityScanner.set("User", { target: User, name: "users" });
    entityScanner.set("Post", { target: Post, name: "posts" });

    const userMetadata = entityScanner.scan(User);
    expect(userMetadata).toEqual({ target: User, name: "users" });

    const postMetadata = entityScanner.scan(Post);
    expect(postMetadata).toEqual({ target: Post, name: "posts" });
  });

  it("should switch context and maintain isolation", () => {
    store.addLayer("tenant_1", false);
    store.addLayer("tenant_2", false);

    // Register an entity in tenant_1
    entityScanner.switchContext("tenant_1");
    entityScanner.set("User", { name: "User_T1" });

    // Register a different entity in tenant_2
    entityScanner.switchContext("tenant_2");
    entityScanner.set("User", { name: "User_T2" });

    // Read from tenant_1
    entityScanner.switchContext("tenant_1");
    expect(entityScanner.get("User")).toEqual({ name: "User_T1" });

    // Read from tenant_2
    entityScanner.switchContext("tenant_2");
    expect(entityScanner.get("User")).toEqual({ name: "User_T2" });
  });
});

describe("MultiTenant Integration Scenario", () => {
  let store: LayeredMetadataStore;

  beforeEach(() => {
    store = new LayeredMetadataStore();
  });

  it("should handle complete multi-tenant workflow", () => {
    // 1. Set up the public schema (lower layer)
    store.addLayer("public_work", false);
    store.setContext("public_work");
    store.set("entities/User", {
      name: "User",
      columns: [
        { name: "id", type: "int" },
        { name: "name", type: "varchar" },
      ],
    });

    // 2. Create tenant_1 and modify its schema
    store.copyLayer("public_work", "tenant_1");
    store.setContext("tenant_1");

    // Add an email column to the User entity in tenant_1
    store.set("entities/User", {
      name: "User",
      columns: [
        { name: "id", type: "int" },
        { name: "name", type: "varchar" },
        { name: "email", type: "varchar" }, // Added
      ],
    });

    // 3. Create tenant_2 (based on public)
    store.copyLayer("public_work", "tenant_2");
    store.setContext("tenant_2");

    // 4. Verify the schema from each tenant
    store.setContext("tenant_1");
    const tenant1Schema = store.get<any>("entities/User");
    expect(tenant1Schema.columns).toHaveLength(3);

    store.setContext("tenant_2");
    const tenant2Schema = store.get<any>("entities/User");
    expect(tenant2Schema.columns).toHaveLength(2); // Same as public

    store.setContext("public_work");
    const publicSchema = store.get<any>("entities/User");
    expect(publicSchema.columns).toHaveLength(2); // Original preserved
  });
});

describe("AsyncLocalStorage Concurrency Safety", () => {
  let store: LayeredMetadataStore;

  beforeEach(() => {
    store = new LayeredMetadataStore();
    MetadataContext.reset();
  });

  it("should prefer AsyncLocalStorage context over setContext()", () => {
    // Base data on the public layer
    const publicLayer = store.getLayer("public")!;
    publicLayer["metadata"].set("entity", { name: "Public" });

    // tenant_1 layer
    store.addLayer("tenant_1", false);
    store.setContext("tenant_1");
    store.set("entity", { name: "Tenant1" });

    // tenant_2 layer
    store.addLayer("tenant_2", false);
    store.setContext("tenant_2");
    store.set("entity", { name: "Tenant2" });

    // setContext is tenant_2, but AsyncLocalStorage is tenant_1
    MetadataContext.run("tenant_1", () => {
      // resolveContext() must return tenant_1 from ALS
      expect(store.getContext()).toBe("tenant_1");
      expect(store.get("entity")).toEqual({ name: "Tenant1" });
    });
  });

  it("should handle concurrent tenant access without cross-contamination", async () => {
    const publicLayer = store.getLayer("public")!;
    publicLayer["metadata"].set("config", { theme: "default" });

    store.addLayer("tenant_a", false);
    store.addLayer("tenant_b", false);

    // Seed tenant_a data (via setContext)
    store.setContext("tenant_a");
    store.set("config", { theme: "dark" });

    store.setContext("tenant_b");
    store.set("config", { theme: "light" });

    // Simulate concurrent requests: isolate via ALS
    const results: string[] = [];

    await Promise.all([
      MetadataContext.run("tenant_a", async () => {
        await new Promise((r) => setTimeout(r, 10)); // async delay
        const config = store.get<any>("config");
        results.push(`a:${config.theme}`);
      }),
      MetadataContext.run("tenant_b", async () => {
        await new Promise((r) => setTimeout(r, 5)); // different timing
        const config = store.get<any>("config");
        results.push(`b:${config.theme}`);
      }),
    ]);

    expect(results).toContain("a:dark");
    expect(results).toContain("b:light");
    expect(results).toHaveLength(2);
  });

  it("should fall back to setContext() when ALS is not active", () => {
    store.addLayer("fallback_tenant", false);
    store.setContext("fallback_tenant");
    store.set("key", { value: "test" });

    // ALS not active → fall back to setContext's fallback_tenant
    expect(store.getContext()).toBe("fallback_tenant");
    expect(store.get("key")).toEqual({ value: "test" });
  });
});
