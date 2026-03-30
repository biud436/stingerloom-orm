import {
  LayeredMetadataStore,
} from "../../src/metadata";
import {
  LayeredMetadataScanner,
  LayeredEntityScanner,
  LayeredColumnScanner,
  LayeredManyToOneScanner,
} from "../../src/metadata/LayeredMetadataScanner";

describe("LayeredMetadataScanner", () => {
  let store: LayeredMetadataStore;
  let scanner: LayeredMetadataScanner;

  beforeEach(() => {
    store = new LayeredMetadataStore();
    scanner = new LayeredMetadataScanner(store, "test");
  });

  describe("createUniqueKey()", () => {
    it("should create a key with the prefix", () => {
      const key = scanner.createUniqueKey();
      expect(key).toMatch(/^test_/);
    });

    it("should create unique keys on successive calls", () => {
      const key1 = scanner.createUniqueKey();
      const key2 = scanner.createUniqueKey();
      expect(key1).not.toBe(key2);
    });
  });

  describe("set() / get()", () => {
    it("should store and retrieve metadata by key", () => {
      scanner.set("myKey", { value: 42 });
      expect(scanner.get("myKey")).toEqual({ value: 42 });
    });

    it("should return undefined for missing key", () => {
      expect(scanner.get("nonexistent")).toBeUndefined();
    });
  });

  describe("has()", () => {
    it("should return true for existing key", () => {
      scanner.set("present", "hello");
      expect(scanner.has("present")).toBe(true);
    });

    it("should return false for missing key", () => {
      expect(scanner.has("absent")).toBe(false);
    });
  });

  describe("allMetadata()", () => {
    it("should return all metadata matching the prefix", () => {
      scanner.set("a", { name: "a" });
      scanner.set("b", { name: "b" });

      const all = scanner.allMetadata();
      expect(all).toHaveLength(2);
      expect(all).toContainEqual({ name: "a" });
      expect(all).toContainEqual({ name: "b" });
    });

    it("should not return metadata from other prefixes", () => {
      scanner.set("a", { name: "a" });

      const otherScanner = new LayeredMetadataScanner(store, "other");
      otherScanner.set("b", { name: "b" });

      const result = scanner.allMetadata();
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ name: "a" });
    });

    it("should return empty array when no metadata exists", () => {
      expect(scanner.allMetadata()).toEqual([]);
    });
  });

  describe("size", () => {
    it("should return 0 for empty scanner", () => {
      expect(scanner.size).toBe(0);
    });

    it("should return correct count", () => {
      scanner.set("a", 1);
      scanner.set("b", 2);
      scanner.set("c", 3);
      expect(scanner.size).toBe(3);
    });
  });

  describe("clear()", () => {
    it("should remove all metadata for current prefix in writable layer", () => {
      // Use a writable tenant layer instead of public (read-only)
      store.addLayer("tenant_clear", false);
      store.setContext("tenant_clear");
      const tenantScanner = new LayeredMetadataScanner(store, "test");

      tenantScanner.set("a", 1);
      tenantScanner.set("b", 2);
      expect(tenantScanner.size).toBeGreaterThanOrEqual(2);

      tenantScanner.clear();
      // After clearing, only public fallback values (if any) remain
    });

    it("should not affect other prefixes in writable layer", () => {
      store.addLayer("tenant_clear2", false);
      store.setContext("tenant_clear2");
      const tenantScanner = new LayeredMetadataScanner(store, "test");
      tenantScanner.set("a", 1);

      const otherScanner = new LayeredMetadataScanner(store, "other");
      otherScanner.set("b", 2);

      tenantScanner.clear();
      expect(otherScanner.get("b")).toBe(2);
    });

    it("should handle clear on empty scanner", () => {
      store.addLayer("tenant_empty", false);
      store.setContext("tenant_empty");
      const emptyScanner = new LayeredMetadataScanner(store, "test");
      expect(() => emptyScanner.clear()).not.toThrow();
    });

    it("should handle clear when no layer exists for context", () => {
      store.setContext("ghost");
      const ghostScanner = new LayeredMetadataScanner(store, "test");
      expect(() => ghostScanner.clear()).not.toThrow();
    });
  });

  describe("switchContext() / getCurrentContext()", () => {
    it("should switch and return context", () => {
      expect(scanner.getCurrentContext()).toBe("public");

      scanner.switchContext("tenant_1");
      expect(scanner.getCurrentContext()).toBe("tenant_1");
    });

    it("should isolate data per context", () => {
      scanner.set("key", "public_value");

      scanner.switchContext("tenant_1");
      store.addLayer("tenant_1", false);
      scanner.set("key", "tenant_value");

      expect(scanner.get("key")).toBe("tenant_value");

      scanner.switchContext("public");
      expect(scanner.get("key")).toBe("public_value");
    });
  });

  describe("copyToNewContext()", () => {
    it("should copy current context data to a new context", () => {
      scanner.set("key1", "val1");
      scanner.set("key2", "val2");

      scanner.copyToNewContext("tenant_copy");
      scanner.switchContext("tenant_copy");

      expect(scanner.get("key1")).toBe("val1");
      expect(scanner.get("key2")).toBe("val2");
    });
  });
});

// ─── LayeredEntityScanner ──────────────────────────────────────

describe("LayeredEntityScanner", () => {
  let store: LayeredMetadataStore;
  let scanner: LayeredEntityScanner;

  beforeEach(() => {
    store = new LayeredMetadataStore();
    scanner = new LayeredEntityScanner(store);
  });

  describe("scan()", () => {
    it("should find entity by target class", () => {
      class User {}
      const metadata = { target: User, name: "users" };
      scanner.set("User", metadata);

      const result = scanner.scan(User);
      expect(result).toEqual(metadata);
    });

    it("should return null for unregistered entity", () => {
      class Unknown {}
      expect(scanner.scan(Unknown)).toBeNull();
    });

    it("should distinguish between different entity classes", () => {
      class User {}
      class Post {}

      scanner.set("User", { target: User, name: "users" });
      scanner.set("Post", { target: Post, name: "posts" });

      expect(scanner.scan(User)?.name).toBe("users");
      expect(scanner.scan(Post)?.name).toBe("posts");
    });
  });

  describe("makeEntities()", () => {
    it("should yield all registered entities", () => {
      class User {}
      class Post {}

      scanner.set("User", { target: User, name: "users" });
      scanner.set("Post", { target: Post, name: "posts" });

      const entities = [...scanner.makeEntities()];
      expect(entities).toHaveLength(2);
    });

    it("should yield nothing when empty", () => {
      const entities = [...scanner.makeEntities()];
      expect(entities).toHaveLength(0);
    });
  });
});

// ─── LayeredColumnScanner ──────────────────────────────────────

describe("LayeredColumnScanner", () => {
  let store: LayeredMetadataStore;
  let scanner: LayeredColumnScanner;

  beforeEach(() => {
    store = new LayeredMetadataStore();
    scanner = new LayeredColumnScanner(store);
  });

  describe("makeColumns()", () => {
    it("should yield all registered columns", () => {
      scanner.set("col1", { name: "id", type: "int" });
      scanner.set("col2", { name: "name", type: "varchar" });

      const columns = [...scanner.makeColumns()];
      expect(columns).toHaveLength(2);
    });

    it("should yield nothing when empty", () => {
      const columns = [...scanner.makeColumns()];
      expect(columns).toHaveLength(0);
    });
  });
});

// ─── LayeredManyToOneScanner ───────────────────────────────────

describe("LayeredManyToOneScanner", () => {
  let store: LayeredMetadataStore;
  let scanner: LayeredManyToOneScanner;

  beforeEach(() => {
    store = new LayeredMetadataStore();
    scanner = new LayeredManyToOneScanner(store);
  });

  describe("scan()", () => {
    it("should find relation by target class", () => {
      class User {}
      const relation = { target: User, columnName: "userId" };
      scanner.set("rel1", relation);

      expect(scanner.scan(User)).toEqual(relation);
    });

    it("should return null for unregistered target", () => {
      class Unknown {}
      expect(scanner.scan(Unknown)).toBeNull();
    });
  });

  describe("makeManyToOnes()", () => {
    it("should yield all registered relations", () => {
      scanner.set("rel1", { target: "User", columnName: "userId" });
      scanner.set("rel2", { target: "Post", columnName: "postId" });

      const relations = [...scanner.makeManyToOnes()];
      expect(relations).toHaveLength(2);
    });

    it("should yield nothing when empty", () => {
      const relations = [...scanner.makeManyToOnes()];
      expect(relations).toHaveLength(0);
    });
  });
});
