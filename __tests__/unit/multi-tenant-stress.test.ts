/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { MetadataScanner, MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";
import { MetadataContext } from "../../src/metadata/MetadataContext";

class StressScanner extends MetadataScanner {
  constructor() {
    super("stress");
  }
}

describe("Multi-tenant stress tests (#82)", () => {
  let scanner: StressScanner;

  beforeEach(() => {
    MetadataLayerRegistry.reset();
    scanner = new StressScanner();
  });

  it("10 concurrent tenants — no cross-tenant metadata leakage", async () => {
    const tenantCount = 10;
    const registry = MetadataLayerRegistry.getInstance();

    // Seed public metadata
    scanner.set("shared", { value: "public-shared" });

    // Run 10 tenants concurrently via MetadataContext.run
    await Promise.all(
      Array.from({ length: tenantCount }, (_, i) => {
        const tenantId = `tenant_${i}`;
        return MetadataContext.run(tenantId, async () => {
          // Each tenant writes its own metadata
          registry.setContext(tenantId);
          scanner.set(`key_${tenantId}`, { tenantId, value: `data_${i}` });

          // Small async delay to interleave with other tenants
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 10));

          // Verify: can see own data + public
          const all = scanner.allMetadata<any>();
          const ownData = all.find((m: any) => m.tenantId === tenantId);
          expect(ownData).toBeDefined();
          expect(ownData.value).toBe(`data_${i}`);

          // Verify: can see public shared data
          const shared = all.find((m: any) => m.value === "public-shared");
          expect(shared).toBeDefined();

          // Verify: cannot see other tenants' private data
          for (let j = 0; j < tenantCount; j++) {
            if (j === i) continue;
            const otherTenantId = `tenant_${j}`;
            const otherData = all.find((m: any) => m.tenantId === otherTenantId);
            expect(otherData).toBeUndefined();
          }
        });
      }),
    );
  });

  it("context correctness with interleaved async operations", async () => {
    const registry = MetadataLayerRegistry.getInstance();
    const results: string[] = [];

    // Interleave two tenants' async operations
    await Promise.all([
      MetadataContext.run("alpha", async () => {
        registry.setContext("alpha");
        scanner.set("val", { owner: "alpha" });
        await new Promise((resolve) => setTimeout(resolve, 5));

        // After await, context should still be "alpha"
        const ctx = MetadataContext.getCurrentTenant();
        results.push(`alpha-check:${ctx}`);

        const all = scanner.allMetadata<any>();
        const alphaVal = all.find((m: any) => m.owner === "alpha");
        expect(alphaVal).toBeDefined();
      }),
      MetadataContext.run("beta", async () => {
        registry.setContext("beta");
        scanner.set("val", { owner: "beta" });
        await new Promise((resolve) => setTimeout(resolve, 3));

        const ctx = MetadataContext.getCurrentTenant();
        results.push(`beta-check:${ctx}`);

        const all = scanner.allMetadata<any>();
        const betaVal = all.find((m: any) => m.owner === "beta");
        expect(betaVal).toBeDefined();
      }),
    ]);

    expect(results).toContain("alpha-check:alpha");
    expect(results).toContain("beta-check:beta");
  });

  it("high-volume writes under concurrent context switches", async () => {
    const registry = MetadataLayerRegistry.getInstance();
    const tenantCount = 5;
    const writesPerTenant = 20;

    await Promise.all(
      Array.from({ length: tenantCount }, (_, i) => {
        const tenantId = `write_tenant_${i}`;
        return MetadataContext.run(tenantId, async () => {
          registry.setContext(tenantId);
          for (let w = 0; w < writesPerTenant; w++) {
            scanner.set(`key_${tenantId}_${w}`, { tenantId, index: w });
            if (w % 5 === 0) {
              await new Promise((resolve) => setTimeout(resolve, 1));
            }
          }

          // Verify all writes are visible
          const all = scanner.allMetadata<any>();
          const ownEntries = all.filter((m: any) => m.tenantId === tenantId);
          expect(ownEntries).toHaveLength(writesPerTenant);
        });
      }),
    );
  });

  it("getByTarget works correctly under concurrent tenants", async () => {
    class EntityX {}
    class EntityY {}
    const registry = MetadataLayerRegistry.getInstance();

    // Public metadata for EntityX
    scanner.set("pub_x", { target: EntityX, scope: "public" });

    await Promise.all([
      MetadataContext.run("t1", async () => {
        registry.setContext("t1");
        scanner.set("t1_y", { target: EntityY, scope: "t1" });
        await new Promise((resolve) => setTimeout(resolve, 2));

        const xResults = scanner.getByTarget<any>(EntityX);
        expect(xResults).toHaveLength(1);
        expect(xResults[0].scope).toBe("public");

        const yResults = scanner.getByTarget<any>(EntityY);
        expect(yResults).toHaveLength(1);
        expect(yResults[0].scope).toBe("t1");
      }),
      MetadataContext.run("t2", async () => {
        registry.setContext("t2");
        scanner.set("t2_y", { target: EntityY, scope: "t2" });
        await new Promise((resolve) => setTimeout(resolve, 1));

        const xResults = scanner.getByTarget<any>(EntityX);
        expect(xResults).toHaveLength(1);
        expect(xResults[0].scope).toBe("public");

        const yResults = scanner.getByTarget<any>(EntityY);
        expect(yResults).toHaveLength(1);
        expect(yResults[0].scope).toBe("t2");
      }),
    ]);
  });

  it("resolveAll cache is invalidated correctly under concurrent mutations", async () => {
    const registry = MetadataLayerRegistry.getInstance();

    scanner.set("base", { value: "v1" });
    const map1 = registry.resolveAll();

    // Mutate in parallel
    await Promise.all([
      MetadataContext.run("cx1", async () => {
        registry.setContext("cx1");
        scanner.set("cx1_key", { value: "cx1" });
      }),
      MetadataContext.run("cx2", async () => {
        registry.setContext("cx2");
        scanner.set("cx2_key", { value: "cx2" });
      }),
    ]);

    // Public cache should still be valid (only tenant layers were modified)
    registry.setContext("public");
    const map2 = registry.resolveAll();
    expect(map2).toBe(map1);

    // Mutate public
    scanner.set("base2", { value: "v2" });
    const map3 = registry.resolveAll();
    expect(map3).not.toBe(map1);
  });
});
