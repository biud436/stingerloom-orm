/**
 * SQLite integration test for the bigint runtime value path.
 *
 * A `bigint` column used to lose precision silently: better-sqlite3 returns
 * every INTEGER as a JS number unless `safeIntegers` is enabled, so
 * 2^53 + 1 (9007199254740993) came back as 9007199254740992 with no warning.
 * The driver now keeps values beyond ±2^53 lossless (as decimal strings on
 * every driver's raw path) and the column's `bigintMode` decides the entity
 * type: `"number"` (default — throws instead of rounding when the value is
 * unsafe), `"string"` and `"bigint"`.
 *
 * Guarded like its siblings: only runs under INTEGRATION_TEST=true.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  PrimaryColumn,
  OrmError,
  OrmErrorCode,
  defineEntity,
  t,
  type InferEntity,
} from "../../../src";
import { sql, raw } from "../../../src/utils/sqlTag";

const suffix = String(Date.now()).slice(-6);

const UNSAFE = "9007199254740993"; // 2^53 + 1
const UNSAFE_BIG = 9007199254740993n;
const SAFE = 9007199254740991; // 2^53 - 1

describe("[Integration] SQLite In-Memory: bigint round trip beyond 2^53", () => {
  let conn: TestConnectionResult;

  type NumRow = { id: number; big: number; plain: number };
  type StrRow = { id: number; big: string };
  type BigRow = { id: number; big: bigint; inferred: bigint };
  type PkRow = { id: bigint; label: string };

  let NumEntity: new () => NumRow;
  let StrEntity: new () => StrRow;
  let BigEntity: new () => BigRow;
  let PkEntity: new () => PkRow;

  // defineEntity must run inside the factory: createTestConnection resets
  // the metadata store before invoking it.
  const buildCounter = () =>
    defineEntity(`bi_counter_${suffix}`, {
      id: t.int().primary().generated(),
      hits: t.bigint({ mode: "string" }),
      total: t.bigint({ mode: "bigint" }),
      plain: t.bigint(),
    });
  type Counter = InferEntity<ReturnType<typeof buildCounter>>;
  let Counter: ReturnType<typeof buildCounter>;

  beforeAll(async () => {
    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
      },
      () => {
        @Entity({ name: `bi_num_${suffix}` })
        class BiNumEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column({ type: "bigint" }) big!: number;
          @Column({ type: "int" }) plain!: number;
        }
        @Entity({ name: `bi_str_${suffix}` })
        class BiStrEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column({ type: "bigint", bigintMode: "string" }) big!: string;
        }
        @Entity({ name: `bi_big_${suffix}` })
        class BiBigEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column({ type: "bigint", bigintMode: "bigint" }) big!: bigint;
          // No explicit type: design:type is BigInt, which must infer a
          // `bigint` column in native BigInt mode.
          @Column() inferred!: bigint;
        }
        @Entity({ name: `bi_pk_${suffix}` })
        class BiPkEntity {
          @PrimaryColumn({ type: "bigint", bigintMode: "bigint" }) id!: bigint;
          @Column({ type: "varchar", length: 20 }) label!: string;
        }
        NumEntity = BiNumEntity as unknown as new () => NumRow;
        StrEntity = BiStrEntity as unknown as new () => StrRow;
        BigEntity = BiBigEntity as unknown as new () => BigRow;
        PkEntity = BiPkEntity as unknown as new () => PkRow;
        Counter = buildCounter();
        return {
          entities: [BiNumEntity, BiStrEntity, BiBigEntity, BiPkEntity, Counter],
        };
      },
    );
  }, 30000);

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

  describe("DDL", () => {
    it("declares bigint columns as BIGINT so the driver can tell them apart", async () => {
      const cols = await conn.em.query<{ name: string; type: string }>(
        sql`SELECT name, type FROM pragma_table_xinfo(${`bi_num_${suffix}`})`,
      );
      const byName = Object.fromEntries(cols.map((c) => [c.name, c.type]));
      expect(byName.big).toBe("BIGINT");
      expect(byName.plain).toBe("INTEGER");
      // Auto-increment PKs must stay INTEGER PRIMARY KEY (rowid alias).
      expect(byName.id).toBe("INTEGER");
    });
  });

  describe('bigintMode: "number" (default)', () => {
    it("keeps safe integers as plain numbers, and int siblings untouched", async () => {
      const saved = await conn.em.save(NumEntity, { big: SAFE, plain: 7 } as any);
      const found = await conn.em.findOne(NumEntity, { where: { id: saved.id } });
      expect(found!.big).toBe(SAFE);
      expect(typeof found!.big).toBe("number");
      expect(found!.plain).toBe(7);
      expect(typeof found!.plain).toBe("number");
      expect(typeof found!.id).toBe("number");
    });

    it("throws BIGINT_PRECISION_LOSS instead of rounding an unsafe value", async () => {
      await conn.em.query(
        sql`INSERT INTO ${raw(`"bi_num_${suffix}"`)} ("big", "plain") VALUES (${UNSAFE_BIG as unknown as number}, 1)`,
      );
      let caught: unknown;
      try {
        await conn.em.find(NumEntity, { where: { plain: 1 } });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(OrmError);
      expect((caught as OrmError).code).toBe(OrmErrorCode.BIGINT_PRECISION_LOSS);
      expect((caught as OrmError).message).toContain("bigintMode");
    });
  });

  describe('bigintMode: "string"', () => {
    it("round-trips 2^53 + 1 losslessly as a decimal string", async () => {
      const saved = await conn.em.save(StrEntity, { big: UNSAFE } as any);
      const found = await conn.em.findOne(StrEntity, { where: { id: saved.id } });
      expect(found!.big).toBe(UNSAFE);
    });

    it("returns small values as strings too (one type per column)", async () => {
      const saved = await conn.em.save(StrEntity, { big: "42" } as any);
      const found = await conn.em.findOne(StrEntity, { where: { id: saved.id } });
      expect(found!.big).toBe("42");
    });

    it("filters by the exact unsafe value", async () => {
      const rows = await conn.em.find(StrEntity, { where: { big: UNSAFE } as any });
      expect(rows).toHaveLength(1);
      expect(rows[0].big).toBe(UNSAFE);
      const none = await conn.em.find(StrEntity, {
        where: { big: "9007199254740992" } as any,
      });
      expect(none).toHaveLength(0);
    });
  });

  describe('bigintMode: "bigint"', () => {
    it("round-trips a native BigInt through save/findOne", async () => {
      const saved = await conn.em.save(BigEntity, {
        big: UNSAFE_BIG,
        inferred: 5n,
      } as any);
      const found = await conn.em.findOne(BigEntity, { where: { id: saved.id } });
      expect(found!.big).toBe(UNSAFE_BIG);
      expect(typeof found!.big).toBe("bigint");
    });

    it("infers a bigint column in BigInt mode from a `bigint` property type", async () => {
      const cols = await conn.em.query<{ name: string; type: string }>(
        sql`SELECT name, type FROM pragma_table_xinfo(${`bi_big_${suffix}`})`,
      );
      expect(cols.find((c) => c.name === "inferred")?.type).toBe("BIGINT");
      const found = await conn.em.findOne(BigEntity, { where: { inferred: 5n } as any });
      expect(found!.inferred).toBe(5n);
    });

    it("accepts a BigInt in where and orderBy", async () => {
      await conn.em.save(BigEntity, { big: 1n, inferred: 6n } as any);
      const rows = await conn.em.find(BigEntity, {
        where: { big: UNSAFE_BIG } as any,
        orderBy: { big: "DESC" } as any,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].big).toBe(UNSAFE_BIG);
    });

    it("re-reads batch inserts by an unsafe bigint primary key", async () => {
      const rows = await conn.em.saveMany(PkEntity, [
        { id: UNSAFE_BIG, label: "a" },
        { id: UNSAFE_BIG + 1n, label: "b" },
      ] as any);
      expect(rows.map((r) => r.id)).toEqual([UNSAFE_BIG, UNSAFE_BIG + 1n]);
      const found = await conn.em.findOne(PkEntity, {
        where: { id: UNSAFE_BIG + 1n } as any,
      });
      expect(found!.label).toBe("b");
    });
  });

  describe("defineEntity t.bigint({ mode })", () => {
    it("infers number / string / bigint from the mode", () => {
      const typed: Counter = { id: 1, hits: "1", total: 1n, plain: 1 };
      // @ts-expect-error hits is a string column
      const wrongHits: Counter = { id: 1, hits: 1, total: 1n, plain: 1 };
      // @ts-expect-error total is a bigint column
      const wrongTotal: Counter = { id: 1, hits: "1", total: 1, plain: 1 };
      expect([typed, wrongHits, wrongTotal]).toHaveLength(3);
    });

    it("hydrates each column in its own mode", async () => {
      const saved = await conn.em.save(Counter as any, {
        hits: UNSAFE,
        total: UNSAFE_BIG,
        plain: 3,
      } as any);
      const found = (await conn.em.findOne(Counter as any, {
        where: { id: (saved as any).id },
      })) as Counter;
      expect(found.hits).toBe(UNSAFE);
      expect(found.total).toBe(UNSAFE_BIG);
      expect(found.plain).toBe(3);
    });
  });

  describe("raw path", () => {
    it("surfaces an unsafe BIGINT as a decimal string, safe ones as numbers", async () => {
      const rows = await conn.em.query<{ big: unknown; id: unknown }>(
        sql`SELECT "id", "big" FROM ${raw(`"bi_str_${suffix}"`)} ORDER BY "id"`,
      );
      expect(rows[0].big).toBe(UNSAFE);
      expect(typeof rows[0].id).toBe("number");
      expect(rows[1].big).toBe(42);
    });

    it("keeps MAX() over a bigint column lossless", async () => {
      const rows = await conn.em.query<{ m: unknown }>(
        sql`SELECT MAX("big") AS m FROM ${raw(`"bi_str_${suffix}"`)}`,
      );
      expect(rows[0].m).toBe(UNSAFE);
    });
  });

  describe("aggregates", () => {
    it("max()/sum() throw BIGINT_PRECISION_LOSS instead of rounding", async () => {
      await expect(conn.em.max(StrEntity, "big" as any)).rejects.toMatchObject({
        code: OrmErrorCode.BIGINT_PRECISION_LOSS,
      });
      await expect(
        conn.em.createQueryBuilder(StrEntity, "s").getSum("big" as any),
      ).rejects.toMatchObject({ code: OrmErrorCode.BIGINT_PRECISION_LOSS });
    });

    it("returns plain numbers for safe results", async () => {
      const m = await conn.em.max(NumEntity, "plain" as any);
      expect(m).toBe(7);
      const c = await conn.em.count(StrEntity);
      expect(c).toBe(2);
    });
  });

  describe("cursor pagination", () => {
    it("encodes a BigInt order value and resumes after it", async () => {
      const page1 = await conn.em.findWithCursor(BigEntity, {
        orderBy: "big" as any,
        take: 1,
        direction: "ASC",
      } as any);
      expect(page1.data).toHaveLength(1);
      expect(page1.data[0].big).toBe(1n);
      expect(page1.hasNextPage).toBe(true);
      const page2 = await conn.em.findWithCursor(BigEntity, {
        orderBy: "big" as any,
        take: 1,
        direction: "ASC",
        cursor: page1.nextCursor!,
      } as any);
      expect(page2.data[0].big).toBe(UNSAFE_BIG);
    });
  });
});
