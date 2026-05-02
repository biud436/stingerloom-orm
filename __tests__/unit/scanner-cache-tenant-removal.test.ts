/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Regression test for issue #279.
 *
 * MetadataLayerRegistry correctly drops a layer and its `resolveAllCache`
 * entry on `removeLayer()`, but per-instance caches inside every
 * `MetadataScanner` (`lastResolvedMap` + `targetIndexMap`) used to keep the
 * stale merged map alive. In a long-running multi-tenant process this is an
 * unbounded memory leak — every offboarded tenant leaks proportional to its
 * column/relation count, multiplied across every scanner singleton.
 *
 * The fix: scanners self-register with the registry, and `removeLayer()`
 * (plus `TenantConnectionRouter.release()`) calls `invalidateScannerCaches()`.
 */

import "reflect-metadata";
import {
  MetadataScanner,
  MetadataLayerRegistry,
} from "../../src/scanner/MetadataScanner";
import { TenantConnectionRouter } from "../../src/core/TenantConnectionRouter";
import { DatabaseClient } from "../../src/DatabaseClient";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";

class TestScanner extends MetadataScanner {
  constructor() {
    super("test");
  }

  // Test-only readers for the private indexes we want to assert on.
  get _lastResolvedMap(): Map<string, any> | null {
    return (this as any).lastResolvedMap;
  }
  get _targetIndexMap(): Map<Function, any[]> {
    return (this as any).targetIndexMap;
  }
}

describe("MetadataScanner cache invalidation on tenant removal (#279)", () => {
  let scanner: TestScanner;
  let registry: MetadataLayerRegistry;

  beforeEach(() => {
    MetadataLayerRegistry.reset();
    registry = MetadataLayerRegistry.getInstance();
    scanner = new TestScanner();
  });

  it("registers itself with the registry on construction", () => {
    // The scanner must appear in the registry's invalidation set so a future
    // removeLayer() can drop its caches without an explicit registration call.
    const scanners = (registry as any).scanners as Set<MetadataScanner>;
    expect(scanners.has(scanner)).toBe(true);
  });

  it("clears lastResolvedMap and targetIndexMap when a layer is removed", () => {
    class TenantOnlyEntity {}

    registry.setContext("acme");
    scanner.set("k1", { target: TenantOnlyEntity, name: "acme_only" });

    // Warm the cache: getByTarget populates lastResolvedMap + targetIndexMap.
    const before = scanner.getByTarget(TenantOnlyEntity);
    expect(before).toHaveLength(1);
    expect(scanner._lastResolvedMap).not.toBeNull();
    expect(scanner._targetIndexMap.has(TenantOnlyEntity)).toBe(true);

    // Drop the tenant layer — caches must be invalidated synchronously so
    // the entity-class reference stops being held by the scanner index.
    registry.setContext("public");
    expect(registry.removeLayer("acme")).toBe(true);

    expect(scanner._lastResolvedMap).toBeNull();
    expect(scanner._targetIndexMap.size).toBe(0);
  });

  it("invalidates every registered scanner, not just one", () => {
    const a = new (class extends MetadataScanner {
      constructor() {
        super("a");
      }
    })();
    const b = new (class extends MetadataScanner {
      constructor() {
        super("b");
      }
    })();

    class E {}
    registry.setContext("t1");
    a.set("x", { target: E, name: "ax" });
    b.set("x", { target: E, name: "bx" });
    a.getByTarget(E);
    b.getByTarget(E);

    expect((a as any).lastResolvedMap).not.toBeNull();
    expect((b as any).lastResolvedMap).not.toBeNull();

    registry.setContext("public");
    registry.removeLayer("t1");

    expect((a as any).lastResolvedMap).toBeNull();
    expect((b as any).lastResolvedMap).toBeNull();
  });

  it("does not retain entity-class references after rapid tenant churn", () => {
    // Simulate a SaaS workload where tenants come and go. Without the fix,
    // each cycle would grow `targetIndexMap` (or hold a stale lastResolvedMap
    // pointing to a merged view that contains the removed tenant's classes).
    // With the fix, the index size stays bounded by what the *current*
    // context exposes — which is just public after every removeLayer.

    const tenantClasses: Function[] = [];
    for (let i = 0; i < 100; i++) {
      const tenantId = `tenant_${i}`;
      const entityClass = class {
        static readonly tag = tenantId;
      };
      tenantClasses.push(entityClass);

      registry.setContext(tenantId);
      scanner.set(`k_${i}`, { target: entityClass, name: tenantId });
      // Force the scanner to populate its index from the merged view.
      scanner.getByTarget(entityClass);

      registry.setContext("public");
      registry.removeLayer(tenantId);
    }

    // Final state: the only thing the scanner should be willing to
    // re-materialize on demand is from the public layer (empty in this test).
    // Both private caches must be cleared.
    expect(scanner._lastResolvedMap).toBeNull();
    expect(scanner._targetIndexMap.size).toBe(0);

    // Verifying via getByTarget against any of the dropped tenant classes:
    // the scanner must NOT return the stale entries.
    for (const cls of tenantClasses) {
      expect(scanner.getByTarget(cls)).toEqual([]);
    }
  });

  it("invalidateScannerCaches() is idempotent with no registered layers", () => {
    // Public-only state — no tenant layers ever existed. Invalidate must not
    // throw even when there's nothing to clean up.
    expect(() => registry.invalidateScannerCaches()).not.toThrow();
    expect(scanner._lastResolvedMap).toBeNull();
    expect(scanner._targetIndexMap.size).toBe(0);
  });

  it("removeLayer on a non-existent layer does NOT trigger invalidation", () => {
    class E {}
    scanner.set("k", { target: E, name: "pub" });
    scanner.getByTarget(E);

    const beforeMap = scanner._lastResolvedMap;
    expect(beforeMap).not.toBeNull();

    // The layer never existed. The registry returns false and does NOT
    // invalidate scanner caches — they remain warm.
    expect(registry.removeLayer("never_existed")).toBe(false);
    expect(scanner._lastResolvedMap).toBe(beforeMap);
  });
});

// ────────────────────────────────────────────────────────────────────────
// TenantConnectionRouter.release() must also invalidate scanner caches
// even when no metadata layer was ever created for the tenant (the typical
// case for the "database" strategy where decorator metadata lives on the
// public layer).
// ────────────────────────────────────────────────────────────────────────

@Entity({ name: "rt_cache_user" })
class RtCacheUserEntity {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
}

const sqliteOpts = () => ({
  type: "sqlite" as const,
  database: ":memory:",
  entities: [RtCacheUserEntity],
  synchronize: true as const,
});

describe("TenantConnectionRouter.release() metadata cleanup (#279)", () => {
  afterEach(async () => {
    await DatabaseClient.getInstance().close();
    MetadataLayerRegistry.reset();
  });

  it("invalidates scanner caches when releasing a router-owned tenant", async () => {
    const router = new TenantConnectionRouter({
      resolver: async () => sqliteOpts(),
      entities: [RtCacheUserEntity],
    });

    await router.resolve("globex");

    // Warm a scanner cache directly so we can observe invalidation.
    const registry = MetadataLayerRegistry.getInstance();
    const probe = new (class extends MetadataScanner {
      constructor() {
        super("probe_279");
      }
    })();
    class Probed {}
    registry.setContext("public");
    probe.set("p", { target: Probed, name: "p" });
    probe.getByTarget(Probed);
    expect((probe as any).lastResolvedMap).not.toBeNull();

    await router.release("globex");

    // release() should have invoked invalidateScannerCaches() — even though
    // no "globex" metadata layer existed.
    expect((probe as any).lastResolvedMap).toBeNull();
    expect((probe as any).targetIndexMap.size).toBe(0);
  });

  it("drops a per-tenant metadata layer if one was created during the tenant's lifetime", async () => {
    const router = new TenantConnectionRouter({
      resolver: async () => sqliteOpts(),
      entities: [RtCacheUserEntity],
    });

    await router.resolve("acme");

    // Manually create a tenant layer to mimic a code path that wrote
    // metadata under MetadataContext.run("acme", ...).
    const registry = MetadataLayerRegistry.getInstance();
    registry.setContext("acme");
    registry.getCurrentLayer().set("entities::AcmeOnly", { name: "acme" });
    registry.setContext("public");

    expect(registry.getLayer("acme")).toBeDefined();

    await router.release("acme");

    expect(registry.getLayer("acme")).toBeUndefined();
  });
});
