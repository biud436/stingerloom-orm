/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { getScannerInstance } from "../../src/scanner/ScannerContainer";
import { EntityScanner, ColumnScanner } from "../../src/scanner";
import {
  ColumnBuilder,
  defineRow,
  isRowShape,
  t,
  type InferRow,
  type RowShape,
} from "../../src/schema";
import { readRowsWithShape } from "../../src/core/RowShapeReader";
import { ColumnTypeRegistry } from "../../src/core/ColumnTypeRegistry";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";

/** Read rows through a shape the way `em.query(shape)` does. */
function read<Row>(shape: RowShape<Row>, rows: Record<string, unknown>[]): Row[] {
  return readRowsWithShape(shape, rows);
}

function catchError(fn: () => unknown): OrmError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(OrmError);
    return err as OrmError;
  }
  throw new Error("expected the call to throw");
}

describe("defineRow — definition", () => {
  it("returns a frozen shape recognized by isRowShape", () => {
    const shape = defineRow({ id: t.int() });
    expect(isRowShape(shape)).toBe(true);
    expect(Object.isFrozen(shape)).toBe(true);
    expect(shape.name).toBe("row");
    expect(defineRow({ id: t.int() }, { name: "CachedLocation" }).name).toBe(
      "CachedLocation",
    );
  });

  it("is not confused with plain objects, strings or Sql fragments", () => {
    expect(isRowShape({ name: "row" })).toBe(false);
    expect(isRowShape("SELECT 1")).toBe(false);
    expect(isRowShape(null)).toBe(false);
    expect(isRowShape(undefined)).toBe(false);
  });

  it("registers nothing with the ORM — no entity or column metadata", () => {
    const entities = getScannerInstance(EntityScanner);
    const columns = getScannerInstance(ColumnScanner);
    const entityCount = [...entities.makeEntities()].length;
    const columnCount = [...columns.makeColumns()].length;

    defineRow({
      id: t.int().primary().generated(),
      label: t.varchar(64).unique().index().default("x"),
      seenAt: t.datetime().createTimestamp(),
    });

    expect([...entities.makeEntities()].length).toBe(entityCount);
    expect([...columns.makeColumns()].length).toBe(columnCount);
  });

  it("rejects a relation builder and suggests selecting the FK column", () => {
    const Owner = class {};
    const err = catchError(() =>
      defineRow({ id: t.int(), owner: t.manyToOne(() => Owner) as any }),
    );
    expect(err.code).toBe(OrmErrorCode.SCHEMA_ERROR);
    expect(err.message).toMatch(/field "owner".*relation builder/);
    expect(err.suggestion).toContain("ownerId: t.int()");
  });

  it("rejects a computed-column builder and suggests declaring the result type", () => {
    const err = catchError(() =>
      defineRow({ id: t.int(), total: t.computed("a + b") as any }),
    );
    expect(err.message).toMatch(/field "total".*computed-column builder/);
    expect(err.suggestion).toContain("total: t.double()");
  });

  it("rejects an uncalled factory and an undefined field like defineEntity does", () => {
    expect(() => defineRow({ id: t.int as any })).toThrow(
      /field "id".*uncalled builder factory/s,
    );
    expect(() => defineRow({ id: undefined as any })).toThrow(
      /field "id".*got undefined.*import cycle/s,
    );
  });

  it("rejects two fields reading the same result column", () => {
    const err = catchError(() =>
      defineRow({ createdAt: t.datetime().name("ts"), ts: t.varchar() }),
    );
    expect(err.message).toContain('fields "createdAt" and "ts" both read the result column "ts"');
  });

  it("infers the row type from the column builders", () => {
    const Shape = defineRow({
      id: t.int(),
      label: t.varchar().nullable(),
      hot: t.boolean(),
      seenAt: t.datetime(),
      meta: t.json<{ zone: string }>().nullable(),
      hits: t.bigint({ mode: "string" }),
      kind: t.enum(["a", "b"]),
    });
    type Row = InferRow<typeof Shape>;

    const row: Row = {
      id: 1,
      label: null,
      hot: true,
      seenAt: new Date(),
      meta: { zone: "z1" },
      hits: "9007199254740993",
      kind: "a",
    };
    const _id: number = row.id;
    const _label: string | null = row.label;
    const _hits: string = row.hits;
    const _zone: string | undefined = row.meta?.zone;
    void [_id, _label, _hits, _zone];

    // @ts-expect-error — `kind` only accepts the enum literal union.
    const _badKind: Row["kind"] = "c";
    // @ts-expect-error — every declared field is required.
    const _missing: Row = { id: 1 };
    const _rejectsRelation = () =>
      // @ts-expect-error — relations are not columns of a flat row.
      defineRow({ owner: t.manyToOne(() => class {}) });
    void [_badKind, _missing, _rejectsRelation];
    expect(row.id).toBe(1);
  });
});

describe("defineRow — reading raw rows", () => {
  it("converts each declared column the way an entity column of that type reads", () => {
    const Shape = defineRow({
      hot: t.boolean(),
      seenAt: t.datetime(),
      seenOn: t.date(),
      meta: t.json<{ zone: string }>(),
      tags: t.array<string>(),
      hits: t.bigint(),
      hitsText: t.bigint({ mode: "string" }),
      hitsBig: t.bigint({ mode: "bigint" }),
    });
    const [row] = read(Shape, [
      {
        hot: 1,
        seenAt: "2026-10-24 09:30:00",
        seenOn: "2026-10-24",
        meta: '{"zone":"z1"}',
        tags: '["a","b"]',
        hits: "42",
        hitsText: 42,
        hitsBig: "9007199254740993",
      },
    ]);

    expect(row.hot).toBe(true);
    expect(row.seenAt.getTime()).toBe(new Date(2026, 9, 24, 9, 30, 0).getTime());
    expect(row.seenOn.getTime()).toBe(new Date(2026, 9, 24).getTime());
    expect(row.meta).toEqual({ zone: "z1" });
    expect(row.tags).toEqual(["a", "b"]);
    expect(row.hits).toBe(42);
    expect(row.hitsText).toBe("42");
    expect(row.hitsBig).toBe(9007199254740993n);
  });

  it("leaves already-converted driver values as they are (pg / mysql2 output)", () => {
    const seenAt = new Date("2026-10-24T00:00:00.000Z");
    const Shape = defineRow({
      hot: t.boolean(),
      seenAt: t.datetime(),
      meta: t.jsonb<{ zone: string }>(),
      x: t.double(),
    });
    const [row] = read(Shape, [{ hot: false, seenAt, meta: { zone: "z" }, x: 1.5 }]);
    expect(row.hot).toBe(false);
    expect(row.seenAt).toBe(seenAt);
    expect(row.meta).toEqual({ zone: "z" });
    expect(row.x).toBe(1.5);
  });

  it("reads numeric strings from expressions as numbers (COUNT int8, NUMERIC, DECIMAL)", () => {
    const Shape = defineRow({
      total: t.int(),
      avgPrice: t.decimal(10, 2),
      ratio: t.double(),
      share: t.float(),
    });
    const [row] = read(Shape, [
      { total: "3", avgPrice: "12.50", ratio: "-0.25", share: 4n },
    ]);
    expect(row).toEqual({ total: 3, avgPrice: 12.5, ratio: -0.25, share: 4 });
  });

  it("throws BIGINT_PRECISION_LOSS instead of rounding an integer beyond ±2^53", () => {
    const Shape = defineRow({ total: t.int() }, { name: "Stats" });
    const err = catchError(() => read(Shape, [{ total: "9007199254740993" }]));
    expect(err.code).toBe(OrmErrorCode.BIGINT_PRECISION_LOSS);
    expect(err.message).toContain("Stats.total holds 9007199254740993");
    expect(err.suggestion).toContain('t.bigint({ mode: "string" })');
  });

  it("passes non-numeric text in a numeric column through instead of producing NaN", () => {
    const Shape = defineRow({ n: t.int() });
    expect(read(Shape, [{ n: "n/a" }])[0].n).toBe("n/a");
    expect(read(Shape, [{ n: "" }])[0].n).toBe("");
  });

  it("keeps SQL NULL as null for every type, including boolean", () => {
    const Shape = defineRow({
      hot: t.boolean().nullable(),
      seenAt: t.datetime().nullable(),
      n: t.int().nullable(),
      meta: t.json().nullable(),
      custom: t
        .varchar()
        .nullable()
        .transformer({ from: () => "called" }),
    });
    const [row] = read(Shape, [
      { hot: null, seenAt: null, n: null, meta: null, custom: null },
    ]);
    expect(row).toEqual({ hot: null, seenAt: null, n: null, meta: null, custom: null });
  });

  it("applies a field transformer and a registered custom type's reader", () => {
    const registry = ColumnTypeRegistry.getInstance();
    registry.register("row_shape_point", {
      sqlite: "TEXT",
      transformer: { from: (raw: string) => raw.split(",").map(Number) },
    });
    try {
      const Shape = defineRow({
        point: t.varchar().transformer({ from: (raw: string) => raw.toUpperCase() }),
        pos: new ColumnBuilder<number[]>({ type: "row_shape_point" }),
      });
      const [row] = read(Shape, [{ point: "ab", pos: "1,2" }]);
      expect(row.point).toBe("AB");
      expect(row.pos).toEqual([1, 2]);
    } finally {
      registry.unregister("row_shape_point");
    }
  });

  it("types a transformed field as the value its transformer reads", () => {
    class Cents {
      constructor(readonly amount: number) {}
    }
    const Shape = defineRow({
      total: t.varchar().transformer({ from: (raw: string) => new Cents(Number(raw)) }),
      refund: t
        .varchar()
        .nullable()
        .transformer({ from: (raw: string) => new Cents(Number(raw)) }),
    });
    const [row] = read(Shape, [{ total: "250", refund: null }]);

    const _total: Cents = row.total;
    const _refund: Cents | null = row.refund;
    // @ts-expect-error — the field is the transformed value, not the stored string.
    const _stored: string = row.total;
    void [_total, _refund, _stored];
    expect(row.total).toBeInstanceOf(Cents);
    expect(row.total.amount).toBe(250);
    expect(row.refund).toBeNull();
  });

  it("reads a field from the column named by .name() and drops the column key", () => {
    const Shape = defineRow({ cachedAt: t.datetime().name("cached_at") });
    const [row] = read(Shape, [{ cached_at: "2026-10-24 00:00:00" }]);
    expect(row.cachedAt).toBeInstanceOf(Date);
    expect(row).not.toHaveProperty("cached_at");
  });

  it("passes undeclared columns through untouched", () => {
    const Shape = defineRow({ id: t.int() });
    const [row] = read(Shape, [{ id: 1, zone: "z1", raw_flag: 0 }]);
    expect(row).toEqual({ id: 1, zone: "z1", raw_flag: 0 });
  });

  it("does not let an undeclared column overwrite a field of the same name", () => {
    const Shape = defineRow({ cachedAt: t.datetime().name("cached_at") });
    const [row] = read(Shape, [
      { cached_at: "2026-10-24 00:00:00", cachedAt: "stale text" },
    ]);
    expect(row.cachedAt).toBeInstanceOf(Date);
  });

  it("handles fields whose column names are swapped", () => {
    const Shape = defineRow({
      title: t.varchar().name("name"),
      name: t.varchar().name("title"),
    });
    expect(read(Shape, [{ name: "N", title: "T" }])[0]).toEqual({
      title: "N",
      name: "T",
    });
  });

  it("throws when a declared column is missing from the result, listing what came back", () => {
    const Shape = defineRow(
      { id: t.int(), cachedAt: t.datetime().name("cached_at"), zone: t.varchar() },
      { name: "CachedLocation" },
    );
    const err = catchError(() => read(Shape, [{ id: 1 }]));
    expect(err.code).toBe(OrmErrorCode.QUERY_ERROR);
    expect(err.message).toContain(
      'em.query(CachedLocation): the result has no column "cached_at" (field "cachedAt"), "zone".',
    );
    expect(err.message).toContain("Result columns: id.");
  });

  it("points at PostgreSQL identifier folding when only the case differs", () => {
    const Shape = defineRow({ avgPrice: t.double() });
    const err = catchError(() => read(Shape, [{ avgprice: "1.5" }]));
    expect(err.suggestion).toContain('The result has "avgprice"');
    expect(err.suggestion).toContain('.name("avgprice")');
  });

  it("returns an empty array for an empty result without checking columns", () => {
    expect(read(defineRow({ id: t.int() }), [])).toEqual([]);
  });

  it("does not mutate the driver rows", () => {
    const Shape = defineRow({ hot: t.boolean(), at: t.datetime().name("at_col") });
    const input = { hot: 1, at_col: "2026-10-24 00:00:00", extra: true };
    const snapshot = { ...input };
    read(Shape, [input]);
    expect(input).toEqual(snapshot);
  });

  it("builds the read plan on first use and reuses it afterwards", () => {
    const spy = jest.spyOn(ColumnTypeRegistry.getInstance(), "getTransformer");
    try {
      const Shape = defineRow({ hot: t.boolean(), seenAt: t.datetime() });
      expect(spy).not.toHaveBeenCalled();

      read(Shape, [{ hot: 1, seenAt: "2026-10-24" }]);
      const callsAfterFirstRead = spy.mock.calls.length;
      expect(callsAfterFirstRead).toBeGreaterThan(0);

      read(Shape, [{ hot: 0, seenAt: "2026-10-25" }]);
      expect(spy.mock.calls.length).toBe(callsAfterFirstRead);
    } finally {
      spy.mockRestore();
    }
  });
});
