/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  createPersistentCollection,
  isPersistentCollection,
} from "../../src/core/plugin/buffer/PersistentCollection";

describe("PersistentCollection", () => {

  // ── createPersistentCollection ───────────────────────────────

  describe("createPersistentCollection()", () => {
    let onChange: jest.Mock;
    let arr: number[];

    beforeEach(() => {
      onChange = jest.fn();
      arr = createPersistentCollection([1, 2, 3], onChange);
    });

    it("push() should trigger onChange", () => {
      arr.push(4);
      expect(onChange).toHaveBeenCalled();
      expect(arr).toContain(4);
    });

    it("splice() should trigger onChange", () => {
      arr.splice(1, 1);
      expect(onChange).toHaveBeenCalled();
      expect(arr).toEqual([1, 3]);
    });

    it("pop() should trigger onChange", () => {
      const val = arr.pop();
      expect(onChange).toHaveBeenCalled();
      expect(val).toBe(3);
    });

    it("shift() should trigger onChange", () => {
      const val = arr.shift();
      expect(onChange).toHaveBeenCalled();
      expect(val).toBe(1);
    });

    it("unshift() should trigger onChange", () => {
      arr.unshift(0);
      expect(onChange).toHaveBeenCalled();
      expect(arr[0]).toBe(0);
    });

    it("sort() should trigger onChange", () => {
      const unsorted = createPersistentCollection([3, 1, 2], onChange);
      onChange.mockClear();
      unsorted.sort();
      expect(onChange).toHaveBeenCalled();
      expect([...unsorted]).toEqual([1, 2, 3]);
    });

    it("reverse() should trigger onChange", () => {
      arr.reverse();
      expect(onChange).toHaveBeenCalled();
      expect([...arr]).toEqual([3, 2, 1]);
    });

    it("index assignment should trigger onChange", () => {
      arr[0] = 99;
      expect(onChange).toHaveBeenCalled();
      expect(arr[0]).toBe(99);
    });

    it("length modification should trigger onChange", () => {
      onChange.mockClear();
      arr.length = 1;
      expect(onChange).toHaveBeenCalled();
      expect(arr).toEqual([1]);
    });

    it("read access (map) should NOT trigger onChange", () => {
      const mapped = arr.map(x => x * 2);
      expect(onChange).not.toHaveBeenCalled();
      expect(mapped).toEqual([2, 4, 6]);
    });

    it("read access (filter) should NOT trigger onChange", () => {
      const filtered = arr.filter(x => x > 1);
      expect(onChange).not.toHaveBeenCalled();
      expect(filtered).toEqual([2, 3]);
    });

    it("read access (forEach) should NOT trigger onChange", () => {
      const collected: number[] = [];
      arr.forEach(x => collected.push(x));
      expect(onChange).not.toHaveBeenCalled();
      expect(collected).toEqual([1, 2, 3]);
    });

    it("Array.isArray() should return true", () => {
      expect(Array.isArray(arr)).toBe(true);
    });
  });

  // ── isPersistentCollection ───────────────────────────────────

  describe("isPersistentCollection()", () => {
    it("should return true for a proxied array", () => {
      const arr = createPersistentCollection([1, 2], () => {});
      expect(isPersistentCollection(arr)).toBe(true);
    });

    it("should return false for a plain array", () => {
      expect(isPersistentCollection([1, 2, 3])).toBe(false);
    });

    it("should return false for non-array values", () => {
      expect(isPersistentCollection("hello")).toBe(false);
      expect(isPersistentCollection(42)).toBe(false);
      expect(isPersistentCollection(null)).toBe(false);
      expect(isPersistentCollection(undefined)).toBe(false);
      expect(isPersistentCollection({ length: 0 })).toBe(false);
    });
  });
});
