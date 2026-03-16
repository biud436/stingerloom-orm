/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { MetadataScanner, MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";

class TestScanner extends MetadataScanner {
  constructor() {
    super("test");
  }
}

class EntityA {}
class EntityB {}
class EntityC {}

describe("MetadataScanner.getByTarget() — O(1) target index (#77)", () => {
  let scanner: TestScanner;

  beforeEach(() => {
    MetadataLayerRegistry.reset();
    scanner = new TestScanner();
  });

  it("returns empty array when no metadata exists", () => {
    expect(scanner.getByTarget(EntityA)).toEqual([]);
  });

  it("returns matching entries by target", () => {
    scanner.set("k1", { target: EntityA, name: "a1" });
    scanner.set("k2", { target: EntityA, name: "a2" });
    scanner.set("k3", { target: EntityB, name: "b1" });

    const resultsA = scanner.getByTarget<{ target: Function; name: string }>(EntityA);
    expect(resultsA).toHaveLength(2);
    expect(resultsA.map((r) => r.name).sort()).toEqual(["a1", "a2"]);

    const resultsB = scanner.getByTarget<{ target: Function; name: string }>(EntityB);
    expect(resultsB).toHaveLength(1);
    expect(resultsB[0].name).toBe("b1");

    expect(scanner.getByTarget(EntityC)).toEqual([]);
  });

  it("rebuilds index when new metadata is added", () => {
    scanner.set("k1", { target: EntityA, name: "a1" });
    expect(scanner.getByTarget(EntityA)).toHaveLength(1);

    scanner.set("k2", { target: EntityA, name: "a2" });
    expect(scanner.getByTarget(EntityA)).toHaveLength(2);
  });

  it("isolates entries from different scanners", () => {
    const scanner2 = new (class extends MetadataScanner {
      constructor() {
        super("other");
      }
    })();

    scanner.set("k1", { target: EntityA, name: "test-a" });
    scanner2.set("k1", { target: EntityA, name: "other-a" });

    const testResults = scanner.getByTarget<{ target: Function; name: string }>(EntityA);
    expect(testResults).toHaveLength(1);
    expect(testResults[0].name).toBe("test-a");

    const otherResults = scanner2.getByTarget<{ target: Function; name: string }>(EntityA);
    expect(otherResults).toHaveLength(1);
    expect(otherResults[0].name).toBe("other-a");
  });

  it("works with multi-tenant context", () => {
    scanner.set("k1", { target: EntityA, name: "public-a" });

    const registry = MetadataLayerRegistry.getInstance();
    registry.setContext("tenant1");
    scanner.set("k2", { target: EntityA, name: "tenant1-a" });
    scanner.set("k3", { target: EntityB, name: "tenant1-b" });

    // In tenant1 context: merged view = public + tenant1
    const resultsA = scanner.getByTarget<{ target: Function; name: string }>(EntityA);
    expect(resultsA).toHaveLength(2);

    const resultsB = scanner.getByTarget<{ target: Function; name: string }>(EntityB);
    expect(resultsB).toHaveLength(1);

    // Switch back to public: only public entries
    registry.setContext("public");
    expect(scanner.getByTarget(EntityA)).toHaveLength(1);
    expect(scanner.getByTarget(EntityB)).toHaveLength(0);
  });

  it("returns O(1) lookup on repeated calls (same reference)", () => {
    scanner.set("k1", { target: EntityA, name: "a1" });
    scanner.set("k2", { target: EntityB, name: "b1" });

    const first = scanner.getByTarget(EntityA);
    const second = scanner.getByTarget(EntityA);
    // Same array reference (index wasn't rebuilt)
    expect(first).toBe(second);
  });
});
