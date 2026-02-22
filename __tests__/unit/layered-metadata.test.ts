import {
  LayeredMetadataStore,
  MetadataLayer,
  MetadataPath,
  LayeredEntityScanner,
  LayeredColumnScanner,
} from "../../src/metadata";

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
    // public 레이어에 기본 스키마 추가 (public은 읽기 전용이므로 work 레이어 필요)
    store.addLayer("public_work", false);
    store.setContext("public_work");
    store.set("user_entity", { name: "User", columns: ["id", "name"] });

    // tenant_1에서 스키마 수정
    store.addLayer("tenant_1", false);
    store.setContext("tenant_1");
    store.set("user_entity", {
      name: "User",
      columns: ["id", "name", "email"],
    });

    // tenant_1에서 읽으면 수정된 스키마가 보임
    expect(store.get("user_entity")).toEqual({
      name: "User",
      columns: ["id", "name", "email"],
    });

    // public_work에서 읽으면 원본 스키마가 유지됨
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
    store.addLayer("public_work", false);
    store.setContext("public_work");
    store.set("entity1", { name: "Entity1" });
    store.set("entity2", { name: "Entity2" });

    store.addLayer("tenant_1", false);
    store.setContext("tenant_1");
    store.set("entity2", { name: "Entity2_Modified" }); // 덮어쓰기
    store.set("entity3", { name: "Entity3" }); // 추가

    const allData = store.getAllInContext();
    expect(allData.size).toBe(3);
    expect(allData.get("entity1")).toEqual({ name: "Entity1" });
    expect(allData.get("entity2")).toEqual({ name: "Entity2_Modified" }); // 상위 레이어 우선
    expect(allData.get("entity3")).toEqual({ name: "Entity3" });
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

    // tenant_1에 엔티티 등록
    entityScanner.switchContext("tenant_1");
    entityScanner.set("User", { name: "User_T1" });

    // tenant_2에 다른 엔티티 등록
    entityScanner.switchContext("tenant_2");
    entityScanner.set("User", { name: "User_T2" });

    // tenant_1에서 읽기
    entityScanner.switchContext("tenant_1");
    expect(entityScanner.get("User")).toEqual({ name: "User_T1" });

    // tenant_2에서 읽기
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
    // 1. public 스키마 설정 (lower layer)
    store.addLayer("public_work", false);
    store.setContext("public_work");
    store.set("entities/User", {
      name: "User",
      columns: [
        { name: "id", type: "int" },
        { name: "name", type: "varchar" },
      ],
    });

    // 2. tenant_1 생성 및 스키마 수정
    store.copyLayer("public_work", "tenant_1");
    store.setContext("tenant_1");

    // tenant_1에서 User 엔티티에 email 컬럼 추가
    store.set("entities/User", {
      name: "User",
      columns: [
        { name: "id", type: "int" },
        { name: "name", type: "varchar" },
        { name: "email", type: "varchar" }, // 추가
      ],
    });

    // 3. tenant_2 생성 (public 기반)
    store.copyLayer("public_work", "tenant_2");
    store.setContext("tenant_2");

    // 4. 각 테넌트에서 스키마 확인
    store.setContext("tenant_1");
    const tenant1Schema = store.get<any>("entities/User");
    expect(tenant1Schema.columns).toHaveLength(3);

    store.setContext("tenant_2");
    const tenant2Schema = store.get<any>("entities/User");
    expect(tenant2Schema.columns).toHaveLength(2); // public과 동일

    store.setContext("public_work");
    const publicSchema = store.get<any>("entities/User");
    expect(publicSchema.columns).toHaveLength(2); // 원본 유지
  });
});
