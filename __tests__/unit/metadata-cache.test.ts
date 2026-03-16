/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { MetadataScanner, MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";

class CacheTestScanner extends MetadataScanner {
  constructor() {
    super("cachetest");
  }
}

describe("MetadataLayerRegistry.resolveAll() cache (#80)", () => {
  let scanner: CacheTestScanner;
  let registry: MetadataLayerRegistry;

  beforeEach(() => {
    MetadataLayerRegistry.reset();
    scanner = new CacheTestScanner();
    registry = MetadataLayerRegistry.getInstance();
  });

  it("returns same Map reference on consecutive calls without mutations", () => {
    scanner.set("k1", { value: 1 });

    const first = registry.resolveAll();
    const second = registry.resolveAll();
    expect(first).toBe(second);
  });

  it("returns new Map reference after set() mutation", () => {
    scanner.set("k1", { value: 1 });
    const first = registry.resolveAll();

    scanner.set("k2", { value: 2 });
    const second = registry.resolveAll();
    expect(first).not.toBe(second);
  });

  it("returns new Map reference after clear() mutation", () => {
    scanner.set("k1", { value: 1 });
    const first = registry.resolveAll();

    scanner.clear();
    const second = registry.resolveAll();
    expect(first).not.toBe(second);
  });

  it("invalidates all tenant caches when public layer is modified", () => {
    scanner.set("k1", { value: "public-1" });

    registry.setContext("tenant1");
    scanner.set("k2", { value: "tenant1-1" });
    const tenant1Map = registry.resolveAll();

    registry.setContext("tenant2");
    scanner.set("k3", { value: "tenant2-1" });
    const tenant2Map = registry.resolveAll();

    // Modify public layer
    registry.setContext("public");
    scanner.set("k4", { value: "public-2" });

    // Both tenant caches should be invalidated
    registry.setContext("tenant1");
    const tenant1MapNew = registry.resolveAll();
    expect(tenant1MapNew).not.toBe(tenant1Map);

    registry.setContext("tenant2");
    const tenant2MapNew = registry.resolveAll();
    expect(tenant2MapNew).not.toBe(tenant2Map);
  });

  it("does not invalidate other tenant caches on tenant-specific mutation", () => {
    scanner.set("k1", { value: "public" });

    registry.setContext("tenant1");
    scanner.set("k2", { value: "t1" });
    registry.resolveAll(); // cache tenant1

    registry.setContext("tenant2");
    scanner.set("k3", { value: "t2" });
    const tenant2Map = registry.resolveAll(); // cache tenant2

    // Modify tenant1
    registry.setContext("tenant1");
    scanner.set("k4", { value: "t1-new" });

    // tenant2 cache should still be valid
    registry.setContext("tenant2");
    const tenant2MapAfter = registry.resolveAll();
    expect(tenant2MapAfter).toBe(tenant2Map);
  });

  it("cache survives context switching without mutations", () => {
    scanner.set("k1", { value: "public" });

    registry.setContext("tenant1");
    scanner.set("k2", { value: "t1" });
    const t1First = registry.resolveAll();

    registry.setContext("public");
    registry.resolveAll(); // cache public

    registry.setContext("tenant1");
    const t1Second = registry.resolveAll();
    expect(t1Second).toBe(t1First);
  });

  it("markDirty('public') clears all caches", () => {
    scanner.set("k1", { value: "public" });
    const publicMap = registry.resolveAll();

    registry.markDirty("public");
    const publicMapNew = registry.resolveAll();
    expect(publicMapNew).not.toBe(publicMap);
  });

  it("resolveAll reflects actual data after mutations", () => {
    scanner.set("k1", { value: 1 });
    const map1 = registry.resolveAll<{ value: number }>();
    expect(map1.get("cachetest::k1")).toEqual({ value: 1 });

    scanner.set("k1", { value: 2 });
    const map2 = registry.resolveAll<{ value: number }>();
    expect(map2.get("cachetest::k1")).toEqual({ value: 2 });
  });

  it("removeLayer cleans up cache for removed layer", () => {
    registry.setContext("tenant1");
    scanner.set("k1", { value: "t1" });
    registry.resolveAll(); // cache

    registry.removeLayer("tenant1");

    // After removing, resolveAll for tenant1 should still work (fresh compute)
    registry.setContext("tenant1");
    const result = registry.resolveAll();
    // Should only have public entries (tenant1 layer was removed)
    expect(result.has("cachetest::k1")).toBe(false);
  });
});
