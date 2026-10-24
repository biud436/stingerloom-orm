/**
 * `em.query(defineRow(...))` against a table the ORM does not manage, on the
 * real mysql2 / pg drivers.
 *
 * The two drivers disagree on almost every raw value: pg returns BIGINT,
 * NUMERIC and COUNT(*) as strings, mysql2 returns DECIMAL and out-of-range
 * BIGINT as strings and booleans as TINYINT 0/1, and MariaDB stores JSON as
 * text. A row shape declares the intended types once, and both drivers must
 * yield the same converted row — the same values `find()` yields for an
 * entity with the same column builders.
 *
 * Requirements:
 *   INTEGRATION_TEST=true (jest config gate)
 *   reachable MySQL / PostgreSQL
 *     disable one with INTEGRATION_TEST_MYSQL=false / INTEGRATION_TEST_POSTGRES=false
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { defineEntity, defineRow, t } from "../../src/schema";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";
import { raw } from "../../src/utils/sqlTag";
import {
  createTestConnection,
  dropTestTable,
  type TestConnectionResult,
} from "./helpers/test-connection";
import { generateTableName } from "./helpers/create-test-entity";
import { getTestDrivers, type TestDriverConfig } from "./helpers/driver-config";

const skipReason = !process.env.INTEGRATION_TEST
  ? "INTEGRATION_TEST is not set"
  : undefined;
const describeIf = skipReason ? describe.skip : describe;

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

const CachedLocation = defineRow(
  { ...locationColumns, price: t.decimal(10, 2) },
  { name: "CachedLocation" },
);

describeIf.each(getTestDrivers())(
  "[Integration] em.query(shape) on an unmapped table ($label)",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let tableName: string;
    let LocationEntity: ReturnType<typeof defineLocationEntity>;

    const table = () =>
      raw(type === "postgres" ? `"${tableName}"` : `\`${tableName}\``);

    function defineLocationEntity(name: string) {
      return defineEntity(name, { ...locationColumns, id: t.int().primary() });
    }

    beforeAll(async () => {
      tableName = generateTableName("row_shape");
      conn = await createTestConnection(
        // The ORM must not create or alter this table — it belongs to
        // "another team" and is created with raw DDL below.
        { synchronize: false, logging: false, ...options },
        () => {
          LocationEntity = defineLocationEntity(tableName);
          return { entities: [LocationEntity] };
        },
      );
      em = conn.em;

      const ddl =
        type === "postgres"
          ? `CREATE TABLE "${tableName}" (
               id INT PRIMARY KEY,
               x DOUBLE PRECISION NOT NULL,
               zone VARCHAR(32) NOT NULL,
               is_hot BOOLEAN NOT NULL,
               hits BIGINT NOT NULL,
               price NUMERIC(10, 2) NOT NULL,
               meta JSONB,
               cached_at TIMESTAMP NOT NULL,
               cached_on DATE NOT NULL)`
          : `CREATE TABLE \`${tableName}\` (
               id INT PRIMARY KEY,
               x DOUBLE NOT NULL,
               zone VARCHAR(32) NOT NULL,
               is_hot TINYINT(1) NOT NULL,
               hits BIGINT NOT NULL,
               price DECIMAL(10, 2) NOT NULL,
               meta JSON NULL,
               cached_at DATETIME NOT NULL,
               cached_on DATE NOT NULL)`;
      await em.query(ddl);

      await em.query`
        INSERT INTO ${table()} (id, x, zone, is_hot, hits, price, meta, cached_at, cached_on)
        VALUES (${16}, ${12.5}, ${"north"}, ${true}, ${42}, ${"19.90"},
                ${JSON.stringify({ tags: ["a", "b"] })},
                ${"2026-10-24 09:30:00"}, ${"2026-10-24"})`;
      await em.query`
        INSERT INTO ${table()} (id, x, zone, is_hot, hits, price, meta, cached_at, cached_on)
        VALUES (${17}, ${-3.25}, ${"south"}, ${false}, ${raw("9007199254740993")}, ${"20.00"},
                ${null}, ${"2026-10-25 18:00:00"}, ${"2026-10-25"})`;
    }, 30000);

    afterAll(async () => {
      try {
        if (tableName) await dropTestTable(tableName);
      } catch {
        // ignore
      }
      if (conn) await conn.cleanup();
    }, 15000);

    it("reads the row typed and converted", async () => {
      const [loc] = await em.query(CachedLocation)`
        SELECT * FROM ${table()} AS a WHERE a.id = ${16}`;

      expect(loc).toEqual({
        id: 16,
        x: 12.5,
        zone: "north",
        isHot: true,
        hits: 42,
        price: 19.9,
        meta: { tags: ["a", "b"] },
        cachedAt: new Date(2026, 9, 24, 9, 30, 0),
        cachedOn: new Date(2026, 9, 24),
      });
    });

    it("matches what find() returns for an entity with the same column builders", async () => {
      const Location = defineRow(locationColumns);
      const [shaped] = await em.query(Location)`
        SELECT id, x, zone, is_hot, hits, meta, cached_at, cached_on
          FROM ${table()} WHERE id = ${16}`;
      const found = await em.findOne(LocationEntity, { where: { id: 16 } });
      expect({ ...found }).toEqual(shaped);
    });

    it("reads a BIGINT beyond ±2^53 losslessly with t.bigint({ mode }) and refuses to round it", async () => {
      const Hits = defineRow({ hits: t.bigint({ mode: "string" }) });
      const [row] = await em.query(Hits)`
        SELECT hits FROM ${table()} WHERE id = ${17}`;
      expect(row.hits).toBe("9007199254740993");

      await expect(
        em.query(CachedLocation)`SELECT * FROM ${table()} WHERE id = ${17}`,
      ).rejects.toMatchObject({ code: OrmErrorCode.BIGINT_PRECISION_LOSS });
    });

    it("reads aggregate expressions through the declared types", async () => {
      const anyHot = type === "postgres" ? raw("BOOL_OR(is_hot)") : raw("MAX(is_hot)");
      const Stats = defineRow({
        total: t.int(),
        avgPrice: t.double().name("avg_price"),
        hitsSum: t.bigint({ mode: "string" }).name("hits_sum"),
        latest: t.datetime(),
        anyHot: t.boolean().name("any_hot"),
      });
      const [stats] = await em.query(Stats)`
        SELECT COUNT(*) AS total,
               AVG(price) AS avg_price,
               SUM(hits) AS hits_sum,
               MAX(cached_at) AS latest,
               ${anyHot} AS any_hot
          FROM ${table()}`;
      expect(stats).toEqual({
        total: 2,
        avgPrice: 19.95,
        hitsSum: "9007199254741035",
        latest: new Date(2026, 9, 25, 18, 0, 0),
        anyHot: true,
      });
    });

    it("rejects a missing declared column and passes undeclared ones through", async () => {
      const Partial = defineRow({ id: t.int() });
      const [row] = await em.query(Partial)`
        SELECT id, zone FROM ${table()} WHERE id = ${16}`;
      expect(row).toEqual({ id: 16, zone: "north" });

      await expect(
        em.query(CachedLocation)`SELECT id FROM ${table()}`,
      ).rejects.toMatchObject({
        code: OrmErrorCode.QUERY_ERROR,
        message: expect.stringContaining('the result has no column "x"'),
      });
    });

    if (type === "postgres") {
      it("points at identifier folding when an unquoted alias loses its case", async () => {
        const Avg = defineRow({ avgPrice: t.double() });
        await expect(
          em.query(Avg)`SELECT AVG(price) AS avgPrice FROM ${table()}`,
        ).rejects.toMatchObject({
          code: OrmErrorCode.QUERY_ERROR,
          suggestion: expect.stringContaining('.name("avgprice")'),
        });

        const [row] = await em.query(Avg)`
          SELECT AVG(price) AS "avgPrice" FROM ${table()}`;
        expect(row.avgPrice).toBe(19.95);
      });
    }
  },
);
