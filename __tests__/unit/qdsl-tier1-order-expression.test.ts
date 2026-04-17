import {
  OrderExpression,
  isOrderExpression,
} from "../../src/core/expressions/OrderExpression";

describe("OrderExpression (QueryDSL Tier 1)", () => {
  describe("construction", () => {
    it("stores direction and ref", () => {
      const o = new OrderExpression("u.name", "ASC");
      expect(o.ref).toBe("u.name");
      expect(o.direction).toBe("ASC");
      expect(o.nulls).toBeUndefined();
      expect(o.isRaw).toBe(false);
    });

    it("carries isRaw through for pre-rendered fragments", () => {
      const o = new OrderExpression("COUNT(\"u\".\"id\")", "DESC", undefined, true);
      expect(o.isRaw).toBe(true);
    });
  });

  describe("nullsFirst() / nullsLast()", () => {
    it("returns a new OrderExpression with NULLS FIRST", () => {
      const base = new OrderExpression("u.created_at", "DESC");
      const o = base.nullsFirst();
      expect(o.nulls).toBe("FIRST");
      // immutable — base unchanged
      expect(base.nulls).toBeUndefined();
      expect(o).not.toBe(base);
    });

    it("returns a new OrderExpression with NULLS LAST", () => {
      const base = new OrderExpression("u.created_at", "ASC");
      const o = base.nullsLast();
      expect(o.nulls).toBe("LAST");
      expect(base.nulls).toBeUndefined();
    });

    it("preserves direction and ref when setting nulls", () => {
      const o = new OrderExpression("u.name", "DESC").nullsLast();
      expect(o.direction).toBe("DESC");
      expect(o.ref).toBe("u.name");
    });

    it("preserves isRaw when setting nulls", () => {
      const o = new OrderExpression("COUNT(*)", "DESC", undefined, true).nullsLast();
      expect(o.isRaw).toBe(true);
    });

    it("allows overriding nulls position via a second chain", () => {
      const o = new OrderExpression("u.name", "ASC").nullsFirst().nullsLast();
      expect(o.nulls).toBe("LAST");
    });
  });

  describe("isOrderExpression type guard", () => {
    it("recognizes an OrderExpression", () => {
      expect(isOrderExpression(new OrderExpression("x", "ASC"))).toBe(true);
    });

    it("rejects plain objects", () => {
      expect(isOrderExpression({ ref: "x", direction: "ASC" })).toBe(false);
    });

    it("rejects null/undefined/primitives", () => {
      expect(isOrderExpression(null)).toBe(false);
      expect(isOrderExpression(undefined)).toBe(false);
      expect(isOrderExpression("x")).toBe(false);
      expect(isOrderExpression(42)).toBe(false);
    });

    it("rejects objects with mismatched marker", () => {
      expect(isOrderExpression({ __isOrderExpression: false })).toBe(false);
      expect(isOrderExpression({ __isOrderExpression: "yes" })).toBe(false);
    });
  });
});
