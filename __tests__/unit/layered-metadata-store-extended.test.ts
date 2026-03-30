import {
  LayeredMetadataStore,
  MetadataLayer,
} from "../../src/metadata";
import { MetadataContext } from "../../src/metadata/MetadataContext";

describe("LayeredMetadataStore (extended coverage)", () => {
  let store: LayeredMetadataStore;

  beforeEach(() => {
    store = new LayeredMetadataStore();
  });

  // ─── addLayer ──────────────────────────────────────────────────

  describe("addLayer()", () => {
    it("should throw when adding duplicate layer", () => {
      store.addLayer("tenant_1");
      expect(() => store.addLayer("tenant_1")).toThrow(/already exists/);
    });

    it("should throw when adding public layer again", () => {
      expect(() => store.addLayer("public")).toThrow(/already exists/);
    });

    it("should create read-only layer", () => {
      const layer = store.addLayer("readonly_layer", true);
      expect(layer.isReadOnlyLayer()).toBe(true);
    });

    it("should create writable layer by default", () => {
      const layer = store.addLayer("writable_layer");
      expect(layer.isReadOnlyLayer()).toBe(false);
    });
  });

  // ─── getLayer ──────────────────────────────────────────────────

  describe("getLayer()", () => {
    it("should return public layer", () => {
      const layer = store.getLayer("public");
      expect(layer).toBeDefined();
      expect(layer!.getName()).toBe("public");
    });

    it("should return undefined for non-existent layer", () => {
      expect(store.getLayer("ghost")).toBeUndefined();
    });
  });

  // ─── set/get with context ──────────────────────────────────────

  describe("set/get with contexts", () => {
    it("should write to public layer directly", () => {
      store.set("key1", "value1");
      expect(store.get("key1")).toBe("value1");
    });

    it("should auto-create tenant layer on write", () => {
      store.setContext("tenant_1");
      store.set("key1", "tenant_value");

      expect(store.getLayer("tenant_1")).toBeDefined();
      expect(store.get("key1")).toBe("tenant_value");
    });

    it("should fallback to public layer from tenant context", () => {
      store.set("shared_key", "public_val");

      store.setContext("tenant_1");
      expect(store.get("shared_key")).toBe("public_val");
    });

    it("should override public value in tenant context", () => {
      store.set("key", "public");

      store.setContext("tenant_1");
      store.set("key", "tenant");

      expect(store.get("key")).toBe("tenant");

      store.setContext("public");
      expect(store.get("key")).toBe("public");
    });

    it("should return undefined for non-existent key", () => {
      expect(store.get("nonexistent")).toBeUndefined();
    });

    it("should return undefined for non-existent key in tenant context", () => {
      store.setContext("tenant_1");
      expect(store.get("nonexistent")).toBeUndefined();
    });
  });

  // ─── has() ─────────────────────────────────────────────────────

  describe("has()", () => {
    it("should return true for existing key", () => {
      store.set("existing", 42);
      expect(store.has("existing")).toBe(true);
    });

    it("should return false for missing key", () => {
      expect(store.has("missing")).toBe(false);
    });

    it("should find key in public layer from tenant context", () => {
      store.set("shared", "val");
      store.setContext("tenant_x");
      expect(store.has("shared")).toBe(true);
    });
  });

  // ─── getAllInContext() ──────────────────────────────────────────

  describe("getAllInContext()", () => {
    it("should return public data only in public context", () => {
      store.set("a", 1);
      store.set("b", 2);

      const all = store.getAllInContext("public");
      expect(all.size).toBe(2);
    });

    it("should merge public + tenant data", () => {
      store.set("shared", "public");
      store.setContext("tenant_1");
      store.set("tenant_only", "value");

      const all = store.getAllInContext("tenant_1");
      expect(all.get("shared")).toBe("public");
      expect(all.get("tenant_only")).toBe("value");
    });

    it("should override public keys with tenant values", () => {
      store.set("key", "public");
      store.setContext("tenant_1");
      store.set("key", "tenant");

      const all = store.getAllInContext("tenant_1");
      expect(all.get("key")).toBe("tenant");
    });

    it("should isolate tenants from each other", () => {
      store.setContext("tenant_1");
      store.set("t1_key", "t1_value");

      store.setContext("tenant_2");
      store.set("t2_key", "t2_value");

      const t1Data = store.getAllInContext("tenant_1");
      const t2Data = store.getAllInContext("tenant_2");

      expect(t1Data.has("t1_key")).toBe(true);
      expect(t1Data.has("t2_key")).toBe(false);
      expect(t2Data.has("t2_key")).toBe(true);
      expect(t2Data.has("t1_key")).toBe(false);
    });

    it("should use current context when no argument provided", () => {
      store.set("pub_key", "pub_val");
      store.setContext("tenant_1");
      store.set("t_key", "t_val");

      const all = store.getAllInContext();
      expect(all.has("pub_key")).toBe(true);
      expect(all.has("t_key")).toBe(true);
    });
  });

  // ─── copyLayer() ──────────────────────────────────────────────

  describe("copyLayer()", () => {
    it("should copy public layer to new tenant", () => {
      store.set("entity_1", { name: "User" });
      store.set("entity_2", { name: "Post" });

      const cloned = store.copyLayer("public", "new_tenant");
      expect(cloned).toBeDefined();
      expect(cloned.getName()).toBe("new_tenant");
      expect(cloned.isReadOnlyLayer()).toBe(false);
    });

    it("should throw for non-existent source", () => {
      expect(() => store.copyLayer("ghost", "target")).toThrow(/not found/);
    });

    it("should throw for duplicate target", () => {
      store.addLayer("existing");
      expect(() => store.copyLayer("public", "existing")).toThrow(/already exists/);
    });

    it("should make copied data accessible via getAllInContext", () => {
      store.set("key", "value");
      store.copyLayer("public", "copy");

      store.setContext("copy");
      expect(store.get("key")).toBe("value");
    });
  });

  // ─── mergeLayer() ─────────────────────────────────────────────

  describe("mergeLayer()", () => {
    it("should merge tenant data into public layer", () => {
      store.setContext("tenant_1");
      store.set("new_entity", { name: "TenantEntity" });

      store.setContext("public");
      store.mergeLayer("tenant_1", "public");

      expect(store.get("new_entity")).toEqual({ name: "TenantEntity" });
    });

    it("should merge between writable layers", () => {
      store.addLayer("source", false);
      store.addLayer("target", false);

      store.setContext("source");
      store.set("key", "from_source");

      store.setContext("public");
      store.mergeLayer("source", "target");

      store.setContext("target");
      expect(store.get("key")).toBe("from_source");
    });

    it("should throw for non-existent source", () => {
      expect(() => store.mergeLayer("ghost", "public")).toThrow(/not found/);
    });

    it("should throw for non-existent target", () => {
      store.addLayer("source");
      expect(() => store.mergeLayer("source", "ghost")).toThrow(/not found/);
    });
  });

  // ─── clearLayer() ─────────────────────────────────────────────

  describe("clearLayer()", () => {
    it("should clear all data in a layer", () => {
      store.setContext("tenant_1");
      store.set("a", 1);
      store.set("b", 2);

      store.clearLayer("tenant_1");

      // After clearing, tenant should fallback to public
      expect(store.get("a")).toBeUndefined();
      expect(store.get("b")).toBeUndefined();
    });

    it("should throw for non-existent layer", () => {
      expect(() => store.clearLayer("ghost")).toThrow(/not found/);
    });

    it("should not affect other layers", () => {
      store.set("public_key", "public_val");
      store.setContext("tenant_1");
      store.set("tenant_key", "tenant_val");

      store.clearLayer("tenant_1");

      store.setContext("public");
      expect(store.get("public_key")).toBe("public_val");
    });
  });

  // ─── removeLayer() ────────────────────────────────────────────

  describe("removeLayer()", () => {
    it("should remove a tenant layer", () => {
      store.addLayer("removable");
      expect(store.getLayer("removable")).toBeDefined();

      const result = store.removeLayer("removable");
      expect(result).toBe(true);
      expect(store.getLayer("removable")).toBeUndefined();
    });

    it("should return false for non-existent layer", () => {
      expect(store.removeLayer("ghost")).toBe(false);
    });

    it("should throw when trying to remove public layer", () => {
      expect(() => store.removeLayer("public")).toThrow(/Cannot remove/);
    });

    it("should clean up trie entries on removal", () => {
      store.setContext("tenant_1");
      store.set("key", "val");

      store.removeLayer("tenant_1");

      // After removal, data should not be accessible
      const all = store.getAllInContext("tenant_1");
      expect(all.has("key")).toBe(false);
    });
  });

  // ─── getLayersInfo() ──────────────────────────────────────────

  describe("getLayersInfo()", () => {
    it("should return info for all layers", () => {
      store.addLayer("tenant_1");
      store.addLayer("tenant_2");

      const info = store.getLayersInfo();
      expect(info).toHaveLength(3); // public + 2 tenants
    });
  });

  // ─── findByPrefix() ──────────────────────────────────────────

  describe("findByPrefix()", () => {
    it("should find entries by prefix in current context", () => {
      store.set("entities/User", { name: "users" });
      store.set("entities/Post", { name: "posts" });
      store.set("columns/id", { type: "int" });

      const entities = store.findByPrefix("entities");
      expect(entities.length).toBeGreaterThanOrEqual(2);
    });

    it("should return empty for non-existent prefix", () => {
      const result = store.findByPrefix("nonexistent");
      expect(result).toEqual([]);
    });
  });

  // ─── AsyncLocalStorage integration ────────────────────────────

  describe("resolveContext() with AsyncLocalStorage", () => {
    it("should use AsyncLocalStorage context when active", async () => {
      store.set("pub_key", "public_value");

      store.addLayer("als_tenant", false);
      store.setContext("als_tenant");
      store.set("pub_key", "tenant_value");
      store.setContext("public");

      await MetadataContext.run("als_tenant", async () => {
        expect(store.getContext()).toBe("als_tenant");
        expect(store.get("pub_key")).toBe("tenant_value");
      });

      // Outside the ALS context, should be back to instance state
      expect(store.getContext()).toBe("public");
      expect(store.get("pub_key")).toBe("public_value");
    });

    it("should write to ALS-resolved context", async () => {
      await MetadataContext.run("dynamic_tenant", async () => {
        store.set("dynamic_key", "dynamic_value");
      });

      store.setContext("dynamic_tenant");
      expect(store.get("dynamic_key")).toBe("dynamic_value");
    });
  });
});
