/**
 * bigint runtime value path — unit pins.
 *
 * Covers the pieces the SQLite integration suite
 * (`__tests__/integration/sqlite/bigint-round-trip.test.ts`) exercises
 * end-to-end: the mode-bound value normalizer, decorator / builder
 * inference, cursor encoding, log serialization, the per-statement
 * safeIntegers plan for better-sqlite3 and the schema-diff affinity rule.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import {
  normalizeBigintValue,
  makeBigintColumnRead,
  aggregateToNumber,
} from "../../src/core/BigintColumnTransformer";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";
import { Column, COLUMN_TOKEN } from "../../src/decorators/Column";
import { Entity } from "../../src/decorators/Entity";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import type { ColumnMetadata } from "../../src/scanner/ColumnScanner";
import { defineEntity } from "../../src/schema/defineEntity";
import { t } from "../../src/schema/builders";
import {
  encodeCursor,
  decodeCursor,
  encodeCursorKey,
  decodeCursorKey,
} from "../../src/core/CursorPagination";
import { stringifyForLog } from "../../src/utils/stringifyForLog";
import {
  planSafeIntegers,
  normalizeSafeIntegerRows,
} from "../../src/dialects/sqlite/SqliteSafeIntegers";
import { SchemaDiff } from "../../src/core/generators/SchemaDiff";
import { ResultTransformerFactory } from "../../src/core/ResultTransformerFactory";
import Database from "better-sqlite3";

const UNSAFE = "9007199254740993";
const UNSAFE_BIG = 9007199254740993n;

function expectPrecisionLoss(fn: () => unknown): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(OrmError);
  expect((caught as OrmError).code).toBe(OrmErrorCode.BIGINT_PRECISION_LOSS);
  expect((caught as OrmError).message).toContain("bigintMode");
}

describe("normalizeBigintValue", () => {
  const where = "Acct.balance";

  it("passes null / undefined through in every mode", () => {
    for (const mode of ["number", "string", "bigint"] as const) {
      expect(normalizeBigintValue(null, mode, where)).toBeNull();
      expect(normalizeBigintValue(undefined, mode, where)).toBeUndefined();
    }
  });

  describe('mode "number"', () => {
    it("returns safe integers as numbers whatever shape the driver used", () => {
      expect(normalizeBigintValue(42, "number", where)).toBe(42);
      expect(normalizeBigintValue("42", "number", where)).toBe(42);
      expect(normalizeBigintValue(42n, "number", where)).toBe(42);
      expect(normalizeBigintValue("-9007199254740991", "number", where)).toBe(
        -9007199254740991,
      );
    });

    it("throws BIGINT_PRECISION_LOSS for out-of-range strings and BigInts", () => {
      expectPrecisionLoss(() => normalizeBigintValue(UNSAFE, "number", where));
      expectPrecisionLoss(() => normalizeBigintValue(UNSAFE_BIG, "number", where));
      expectPrecisionLoss(() => normalizeBigintValue(-UNSAFE_BIG, "number", where));
    });

    it("throws for an already-rounded unsafe number rather than trusting it", () => {
      expectPrecisionLoss(() => normalizeBigintValue(2 ** 60, "number", where));
    });

    it("names the column in the error", () => {
      try {
        normalizeBigintValue(UNSAFE, "number", where);
      } catch (e) {
        expect((e as Error).message).toContain(where);
        expect((e as Error).message).toContain(UNSAFE);
      }
    });

    it("leaves non-integer text alone", () => {
      expect(normalizeBigintValue("12.5", "number", where)).toBe("12.5");
      expect(normalizeBigintValue("abc", "number", where)).toBe("abc");
    });
  });

  describe('mode "string"', () => {
    it("renders numbers and BigInts as decimal digits", () => {
      expect(normalizeBigintValue(42, "string", where)).toBe("42");
      expect(normalizeBigintValue(UNSAFE_BIG, "string", where)).toBe(UNSAFE);
      expect(normalizeBigintValue(UNSAFE, "string", where)).toBe(UNSAFE);
      expect(normalizeBigintValue(-1n, "string", where)).toBe("-1");
    });
  });

  describe('mode "bigint"', () => {
    it("converts numbers and digit strings to BigInt", () => {
      expect(normalizeBigintValue(42, "bigint", where)).toBe(42n);
      expect(normalizeBigintValue(UNSAFE, "bigint", where)).toBe(UNSAFE_BIG);
      expect(normalizeBigintValue(UNSAFE_BIG, "bigint", where)).toBe(UNSAFE_BIG);
      expect(normalizeBigintValue("-7", "bigint", where)).toBe(-7n);
    });
  });

  it("makeBigintColumnRead binds mode and label", () => {
    const read = makeBigintColumnRead("string", "Acct", "balance");
    expect(read(5)).toBe("5");
    const strict = makeBigintColumnRead("number", "Acct", "balance");
    expect(() => strict(UNSAFE)).toThrow(/Acct\.balance/);
  });
});

describe("aggregateToNumber", () => {
  it("keeps fractional results and safe integers as numbers", () => {
    expect(aggregateToNumber(12.5, "AVG(x)")).toBe(12.5);
    expect(aggregateToNumber("12.5000000000000000", "AVG(x)")).toBe(12.5);
    expect(aggregateToNumber("42", "SUM(x)")).toBe(42);
    expect(aggregateToNumber(42n, "SUM(x)")).toBe(42);
  });

  it("refuses to round an integer beyond 2^53", () => {
    expectPrecisionLoss(() => aggregateToNumber(UNSAFE, "SUM(x)"));
    expectPrecisionLoss(() => aggregateToNumber(UNSAFE_BIG, "MAX(x)"));
  });
});

describe("@Column inference", () => {
  function columnOf(cls: Function, key: string): ColumnMetadata {
    const cols: ColumnMetadata[] = Reflect.getMetadata(COLUMN_TOKEN, cls.prototype);
    return cols.find((c) => c.propertyKey === key)!;
  }

  it("maps a `bigint` property type to a bigint column in BigInt mode", () => {
    @Entity()
    class Inferred {
      @PrimaryGeneratedColumn() id!: number;
      @Column() big!: bigint;
      @Column({ type: "bigint" }) asNumber!: number;
      @Column({ type: "bigint", bigintMode: "string" }) asString!: string;
      @Column({ bigintMode: "string" }) inferredString!: bigint;
    }
    expect(columnOf(Inferred, "big").options?.type).toBe("bigint");
    expect(columnOf(Inferred, "big").options?.bigintMode).toBe("bigint");
    expect(columnOf(Inferred, "big").options?.nullable).toBe(false);
    // Explicit type on a number property: default mode (undefined → "number").
    expect(columnOf(Inferred, "asNumber").options?.bigintMode).toBeUndefined();
    expect(columnOf(Inferred, "asString").options?.bigintMode).toBe("string");
    // An explicit mode wins over the BigInt design type.
    expect(columnOf(Inferred, "inferredString").options?.type).toBe("bigint");
    expect(columnOf(Inferred, "inferredString").options?.bigintMode).toBe("string");
  });
});

describe("t.bigint({ mode })", () => {
  it("records the mode on the column definition", () => {
    expect(t.bigint()._def).toEqual({ type: "bigint" });
    expect(t.bigint({ mode: "string" })._def).toEqual({
      type: "bigint",
      bigintMode: "string",
    });
    expect(t.bigint({ mode: "bigint" })._def.bigintMode).toBe("bigint");
  });

  it("reaches the registered column metadata through defineEntity", () => {
    const Ledger = defineEntity("bi_unit_ledger", {
      id: t.int().primary().generated(),
      hits: t.bigint({ mode: "string" }),
      total: t.bigint(),
    });
    const cols: ColumnMetadata[] = Reflect.getMetadata(COLUMN_TOKEN, Ledger.prototype);
    expect(cols.find((c) => c.propertyKey === "hits")?.options?.bigintMode).toBe("string");
    expect(cols.find((c) => c.propertyKey === "total")?.options?.type).toBe("bigint");
    expect(cols.find((c) => c.propertyKey === "total")?.options?.bigintMode).toBeUndefined();
  });
});

describe("ResultTransformer bigint hydration", () => {
  it("applies the column mode to driver values of any shape", () => {
    @Entity()
    class Wallet {
      @PrimaryGeneratedColumn() id!: number;
      @Column({ type: "bigint", bigintMode: "string" }) cents!: string;
      @Column({ type: "bigint", bigintMode: "bigint" }) units!: bigint;
      @Column({ type: "bigint" }) plain!: number;
    }
    const rows = ResultTransformerFactory.create().toEntities(Wallet, {
      results: [
        // pg shape (strings), mysql2 / sqlite shape (numbers), mixed
        { id: 1, cents: UNSAFE, units: "7", plain: "12" },
        { id: 2, cents: 5, units: 9n, plain: 3 },
      ],
      fields: [],
    } as any);
    expect(rows[0].cents).toBe(UNSAFE);
    expect(rows[0].units).toBe(7n);
    expect(rows[0].plain).toBe(12);
    expect(rows[1].cents).toBe("5");
    expect(rows[1].units).toBe(9n);
    expect(rows[1].plain).toBe(3);
  });

  it("throws on read when the default mode cannot hold the stored value", () => {
    @Entity()
    class Strict {
      @PrimaryGeneratedColumn() id!: number;
      @Column({ type: "bigint" }) big!: number;
    }
    expectPrecisionLoss(() =>
      ResultTransformerFactory.create().toEntities(Strict, {
        results: [{ id: 1, big: UNSAFE }],
        fields: [],
      } as any),
    );
  });
});

describe("cursor encoding with BigInt", () => {
  it("round-trips a BigInt scalar cursor", () => {
    expect(decodeCursor(encodeCursor(UNSAFE_BIG))).toBe(UNSAFE_BIG);
  });

  it("round-trips BigInt order and PK values in a keyset cursor", () => {
    const decoded = decodeCursorKey(encodeCursorKey(UNSAFE_BIG, 3n));
    expect(decoded).toEqual({ order: UNSAFE_BIG, pk: 3n });
  });

  it("leaves numbers, strings, null and legacy cursors untouched", () => {
    expect(decodeCursor(encodeCursor(42))).toBe(42);
    expect(decodeCursor(encodeCursor("abc"))).toBe("abc");
    expect(decodeCursorKey(encodeCursorKey(null, 1))).toEqual({ order: null, pk: 1 });
    const legacy = Buffer.from(JSON.stringify({ v: 7 })).toString("base64");
    expect(decodeCursorKey(legacy)).toEqual({ order: 7, pk: undefined });
  });
});

describe("stringifyForLog", () => {
  it("renders BigInt parameters instead of throwing", () => {
    expect(stringifyForLog([1n, "a", UNSAFE_BIG])).toBe(`[\"1\",\"a\",\"${UNSAFE}\"]`);
    expect(stringifyForLog({ v: 2n }, 2)).toBe('{\n  "v": "2"\n}');
  });

  it("falls back to String() for unserializable input", () => {
    const cyclic: any = {};
    cyclic.self = cyclic;
    expect(stringifyForLog(cyclic)).toBe("[object Object]");
  });
});

describe("SqliteSafeIntegers plan", () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(":memory:");
    db.exec(
      'CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, small INTEGER, big BIGINT, label TEXT)',
    );
    db.prepare("INSERT INTO t (small, big, label) VALUES (?, ?, ?)").run(1, UNSAFE_BIG, "x");
    db.prepare("INSERT INTO t (small, big, label) VALUES (?, ?, ?)").run(2, 5n, "y");
  });

  afterAll(() => db.close());

  it("skips statements whose columns all carry a non-BIGINT declared type", () => {
    const stmt = db.prepare("SELECT id, small, label FROM t");
    expect(planSafeIntegers(stmt)).toBeNull();
    expect(typeof (stmt.get() as any).id).toBe("number");
  });

  it("enables safeIntegers for a BIGINT column and normalizes every integer cell", () => {
    const stmt = db.prepare("SELECT id, small, big, label FROM t ORDER BY id");
    const plan = planSafeIntegers(stmt);
    expect(plan).toEqual({ keys: ["id", "small", "big", "label"] });
    const rows = normalizeSafeIntegerRows(stmt.all() as any[], plan!);
    expect(rows[0]).toEqual({ id: 1, small: 1, big: UNSAFE, label: "x" });
    expect(rows[1]).toEqual({ id: 2, small: 2, big: 5, label: "y" });
  });

  it("covers expression columns, which have no declared type", () => {
    const stmt = db.prepare("SELECT MAX(big) AS m, COUNT(*) AS c FROM t");
    const plan = planSafeIntegers(stmt);
    expect(plan).not.toBeNull();
    const rows = normalizeSafeIntegerRows(stmt.all() as any[], plan!);
    expect(rows[0]).toEqual({ m: UNSAFE, c: 2 });
  });

  it("handles raw(true) array rows", () => {
    const stmt = db.prepare("SELECT big FROM t ORDER BY id");
    const plan = planSafeIntegers(stmt)!;
    stmt.raw(true);
    const rows = normalizeSafeIntegerRows(stmt.all() as any[], plan);
    expect(rows).toEqual([[UNSAFE], [5]]);
  });

  it("caches the decision per statement and ignores non-reader statements", () => {
    const stmt = db.prepare("SELECT big FROM t");
    expect(planSafeIntegers(stmt)).toBe(planSafeIntegers(stmt));
    const write = db.prepare("UPDATE t SET small = small WHERE id = 0");
    expect(planSafeIntegers(write)).toBeNull();
    expect(typeof write.run().lastInsertRowid).toBe("number");
  });
});

describe("SchemaDiff — SQLite bigint declared type", () => {
  it("does not report an INTEGER-declared bigint column as a type change", async () => {
    @Entity({ name: "bi_diff_legacy" })
    class Legacy {
      @PrimaryGeneratedColumn() id!: number;
      @Column({ type: "bigint" }) big!: number;
    }
    const runner = {
      query: jest.fn((sqlInput: string) =>
        Promise.resolve(
          sqlInput.includes("bi_diff_legacy")
            ? [
                { cid: 0, name: "id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 1 },
                { cid: 1, name: "big", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
              ]
            : [],
        ),
      ),
    };
    const result = await new SchemaDiff().diff([Legacy], runner as any, "sqlite");
    expect(result.alterColumns).toHaveLength(0);
    expect(result.addColumns).toHaveLength(0);
  });
});
