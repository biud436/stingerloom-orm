import {
  MetadataLayer,
  deepCloneMetadata,
} from "../../src/metadata/MetadataLayer";

/**
 * `MetadataLayer.clone()` is the copy-on-write primitive of the layered
 * (OverlayFS-style) metadata model. A tenant overlay cloned from the public
 * layer must NOT share mutable state with it — otherwise an in-place mutation
 * of nested metadata (e.g. `meta.columns.push(...)`) on one layer leaks into
 * the other and breaks tenant isolation.
 *
 * The clone must also preserve class constructors / functions BY REFERENCE,
 * because the resolver and scanners compare them with `===` (cloning a class
 * ref would break relation `target` identity checks).
 */
describe("MetadataLayer.clone() — copy-on-write isolation", () => {
  it("does not leak in-place mutation of a nested array back to the source", () => {
    const layer = new MetadataLayer("public");
    layer.set("User", { columns: ["id", "name"], indexes: [] });

    const cloned = layer.clone("tenant_a");
    const clonedMeta = cloned.get<{ columns: string[] }>("User")!;
    clonedMeta.columns.push("email");

    // Source layer is untouched — isolation holds.
    expect(layer.get<{ columns: string[] }>("User")!.columns).toEqual([
      "id",
      "name",
    ]);
    expect(clonedMeta.columns).toEqual(["id", "name", "email"]);
  });

  it("does not leak in-place mutation of a nested object", () => {
    const layer = new MetadataLayer("public");
    layer.set("User", { options: { nullable: false } });

    const cloned = layer.clone("tenant_a");
    cloned.get<{ options: { nullable: boolean } }>("User")!.options.nullable =
      true;

    expect(
      layer.get<{ options: { nullable: boolean } }>("User")!.options.nullable,
    ).toBe(false);
  });

  it("gives the clone fresh container instances (not shared references)", () => {
    const layer = new MetadataLayer("public");
    const cols: string[] = ["id"];
    layer.set("User", { columns: cols });

    const cloned = layer.clone("tenant_a");
    const clonedCols = cloned.get<{ columns: string[] }>("User")!.columns;

    expect(clonedCols).toEqual(["id"]); // structurally equal
    expect(clonedCols).not.toBe(cols); // but a different array
  });

  it("preserves class constructors and functions by reference", () => {
    class TargetEntity {}
    const getMappingEntity = () => TargetEntity;

    const layer = new MetadataLayer("public");
    layer.set("rel", {
      target: TargetEntity,
      getMappingEntity,
      columnName: "owner",
      nested: { also: TargetEntity },
    });

    const cloned = layer
      .clone("tenant_a")
      .get<{
        target: unknown;
        getMappingEntity: unknown;
        nested: { also: unknown };
      }>("rel")!;

    // Identity-critical refs are shared, not cloned.
    expect(cloned.target).toBe(TargetEntity);
    expect(cloned.getMappingEntity).toBe(getMappingEntity);
    expect(cloned.nested.also).toBe(TargetEntity);
  });

  it("keeps the existing deep-equality contract for cloned values", () => {
    const layer = new MetadataLayer("public");
    layer.set("key1", { nested: "value" });

    const cloned = layer.clone("cloned-layer");
    expect(cloned.get("key1")).toEqual({ nested: "value" });
  });
});

describe("deepCloneMetadata()", () => {
  it("returns primitives, null, undefined, and symbols unchanged", () => {
    const sym = Symbol("x");
    expect(deepCloneMetadata(42)).toBe(42);
    expect(deepCloneMetadata("s")).toBe("s");
    expect(deepCloneMetadata(true)).toBe(true);
    expect(deepCloneMetadata(null)).toBe(null);
    expect(deepCloneMetadata(undefined)).toBe(undefined);
    expect(deepCloneMetadata(sym)).toBe(sym);
  });

  it("returns functions and class constructors by reference", () => {
    const fn = () => 1;
    class C {}
    expect(deepCloneMetadata(fn)).toBe(fn);
    expect(deepCloneMetadata(C)).toBe(C);
  });

  it("clones Date and RegExp into independent equal instances", () => {
    const d = new Date(123456789);
    const clonedDate = deepCloneMetadata(d);
    expect(clonedDate).not.toBe(d);
    expect(clonedDate.getTime()).toBe(123456789);

    const re = /abc/gi;
    const clonedRe = deepCloneMetadata(re);
    expect(clonedRe).not.toBe(re);
    expect(clonedRe.source).toBe("abc");
    expect(clonedRe.flags).toBe("gi");
  });

  it("deep-clones Map values while keeping key identity", () => {
    const key = { id: 1 };
    const map = new Map<object, { tag: string }>([[key, { tag: "a" }]]);

    const cloned = deepCloneMetadata(map);
    expect(cloned).not.toBe(map);
    expect(cloned.has(key)).toBe(true); // same key identity
    expect(cloned.get(key)).not.toBe(map.get(key)); // cloned value
    cloned.get(key)!.tag = "b";
    expect(map.get(key)!.tag).toBe("a"); // source untouched
  });

  it("deep-clones Set members", () => {
    const member = { tag: "a" };
    const set = new Set([member]);
    const cloned = deepCloneMetadata(set);
    expect(cloned).not.toBe(set);
    expect(cloned.has(member)).toBe(false); // member was cloned, not shared
    expect([...cloned][0]).toEqual({ tag: "a" });
  });

  it("shares non-plain class instances by reference (preserves behavior)", () => {
    class Box {
      constructor(public v: number) {}
      double() {
        return this.v * 2;
      }
    }
    const box = new Box(21);
    const wrapper = deepCloneMetadata({ box });
    expect(wrapper.box).toBe(box); // shared
    expect(wrapper.box.double()).toBe(42); // behavior intact
  });

  it("is cycle-safe and preserves intra-value shared references", () => {
    const shared = { v: 1 };
    const root: any = { a: shared, b: shared };
    root.self = root;

    const cloned = deepCloneMetadata(root);
    expect(cloned.self).toBe(cloned); // cycle handled
    expect(cloned.a).toBe(cloned.b); // shared ref preserved as a single clone
    expect(cloned.a).not.toBe(shared); // but cloned, not the original
  });
});
