/**
 * `em.query(defineRow(...))` against a table the ORM does not manage, on a
 * real better-sqlite3 connection.
 *
 * better-sqlite3 has no column types on the way out: temporal columns come
 * back as the stored TEXT, booleans as 0/1, JSON as text, and BIGINT values
 * beyond ±2^53 as decimal strings. A row shape declares the intended types
 * once and the rows come back converted — the same values `find()` yields
 * for an entity with the same column builders.
 */
import "reflect-metadata";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";
import { defineEntity, defineRow, t } from "../../../src/schema";
import { OrmErrorCode } from "../../../src/errors/OrmErrorCode";

const locationColumns = {
  id: t.int(),
  x: t.double(),
  zone: t.varchar(32),
  isHot: t.boolean().name("is_hot"),
  hits: t.bigint(),
  meta: t.json<{ tags: string[] }>().nullable(),
  cachedAt: t.datetime().name("cached_at"),
  cachedOn: t.date().name("cached_on"),
};

const CachedLocation = defineRow(locationColumns, { name: "CachedLocation" });

// The same builders as a mapped entity — used only to compare against find().
const CachedLocationEntity = defineEntity("rs_cached_location", {
  ...locationColumns,
  id: t.int().primary(),
});

describe("[SQLite] em.query(shape) on an unmapped table", () => {
  let em: EntityManager;

  beforeAll(async () => {
    em = await createTestEntityManager({
      entities: [CachedLocationEntity],
      synchronize: false,
    });
    // Created outside the ORM, the way another team's table would be.
    await em.query(`
      CREATE TABLE rs_cached_location (
        id INTEGER PRIMARY KEY,
        x REAL NOT NULL,
        zone TEXT NOT NULL,
        is_hot INTEGER NOT NULL,
        hits BIGINT NOT NULL,
        meta TEXT,
        cached_at TEXT NOT NULL,
        cached_on TEXT NOT NULL
      )`);
    await em.query(
      `INSERT INTO rs_cached_location VALUES
        (16, 12.5, 'north', 1, 42, '{"tags":["a","b"]}', '2026-10-24 09:30:00', '2026-10-24'),
        (17, -3.25, 'south', 0, 9007199254740993, NULL, '2026-10-25 18:00:00', '2026-10-25')`,
    );
  });

  afterAll(async () => {
    await (em as unknown as { destroy?: () => Promise<void> }).destroy?.();
  });

  it("reads the row typed and converted", async () => {
    const [loc] = await em.query(CachedLocation)`
      SELECT * FROM rs_cached_location AS a WHERE a.id = ${16}`;

    expect(loc).toEqual({
      id: 16,
      x: 12.5,
      zone: "north",
      isHot: true,
      hits: 42,
      meta: { tags: ["a", "b"] },
      cachedAt: new Date(2026, 9, 24, 9, 30, 0),
      cachedOn: new Date(2026, 9, 24),
    });
  });

  it("matches what find() returns for an entity with the same column builders", async () => {
    const [shaped] = await em.query(CachedLocation)`
      SELECT * FROM rs_cached_location WHERE id = ${16}`;
    const found = await em.findOne(CachedLocationEntity, { where: { id: 16 } });
    expect({ ...found }).toEqual(shaped);
  });

  it("reads a BIGINT beyond ±2^53 losslessly with t.bigint({ mode }) and refuses to round it", async () => {
    const Hits = defineRow({ hits: t.bigint({ mode: "string" }) });
    const [row] = await em.query(Hits)`
      SELECT hits FROM rs_cached_location WHERE id = ${17}`;
    expect(row.hits).toBe("9007199254740993");

    await expect(
      em.query(CachedLocation)`SELECT * FROM rs_cached_location WHERE id = ${17}`,
    ).rejects.toMatchObject({ code: OrmErrorCode.BIGINT_PRECISION_LOSS });
  });

  it("reads aggregate expressions through the declared types", async () => {
    const Stats = defineRow({
      total: t.int(),
      hotCount: t.int().name("hot_count"),
      latest: t.datetime(),
      anyHot: t.boolean().name("any_hot"),
    });
    const [stats] = await em.query(Stats)`
      SELECT COUNT(*) AS total,
             SUM(is_hot) AS hot_count,
             MAX(cached_at) AS latest,
             MAX(is_hot) AS any_hot
        FROM rs_cached_location`;
    expect(stats).toEqual({
      total: 2,
      hotCount: 1,
      latest: new Date(2026, 9, 25, 18, 0, 0),
      anyHot: true,
    });
  });

  it("supports the (shape, sql, params) form", async () => {
    const rows = await em.query(
      CachedLocation,
      "SELECT * FROM rs_cached_location WHERE zone = ? AND id = ?",
      ["north", 16],
    );
    expect(rows.map((r) => r.cachedAt instanceof Date)).toEqual([true]);
  });

  it("passes undeclared columns through and rejects a missing declared column", async () => {
    const Partial = defineRow({ id: t.int() });
    const [row] = await em.query(Partial)`
      SELECT id, zone FROM rs_cached_location WHERE id = ${16}`;
    expect(row).toEqual({ id: 16, zone: "north" });

    await expect(
      em.query(CachedLocation)`SELECT id FROM rs_cached_location`,
    ).rejects.toMatchObject({
      code: OrmErrorCode.QUERY_ERROR,
      message: expect.stringContaining('the result has no column "x"'),
    });
  });
});
