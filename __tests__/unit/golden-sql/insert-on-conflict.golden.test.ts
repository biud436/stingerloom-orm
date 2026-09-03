import "reflect-metadata";
import sql from "sql-template-tag";
import { qAlias } from "../../../src/core/SelectQueryBuilder";
import { qExcluded } from "../../../src/core/query-builder/alias/qExcluded";
import { Expressions } from "../../../src/core/expressions/LogicalCondition";
import { OrmErrorCode } from "../../../src/errors/OrmErrorCode";
import { createInsertBuilderFor, Counter } from "./fixtures";
import { runBuilderGoldenMatrix, type BuilderGoldenCase } from "./harness";

/**
 * Golden SQL — `InsertQueryBuilder` full-statement composition.
 *
 * This is the widest dialect split in the write path: PostgreSQL and
 * SQLite take a conflict target and a `DO UPDATE` action, MySQL takes
 * neither and spells the proposed row `VALUES(col)` instead of an
 * `EXCLUDED` pseudo-table. Several clauses have no MySQL equivalent at
 * all and must throw rather than render something narrower, so the
 * matrix pins the throws alongside the text.
 */

const c = qAlias(Counter, "c");
const ex = qExcluded(Counter);

/**
 * Render a built statement the way the golden harness spells SQL: `?`
 * placeholders (`Sql.sql`), not the `$n` form `toSql()` returns to match
 * its `UpdateQueryBuilder` sibling.
 */
function render(builder: { build(): { sql: string; values: unknown[] } }): {
  text: string;
  values: unknown[];
} {
  const built = builder.build();
  return { text: built.sql, values: built.values };
}

const ROW = { mac: "aa", bucketStart: 100, records: 5, lastTs: 150 };
const ROW2 = { mac: "bb", bucketStart: 200, records: 7, lastTs: 250 };

const cases: BuilderGoldenCase[] = [
  {
    name: "accumulate + high-water mark — the expression upsert",
    build: (dialect) =>
      render(
        createInsertBuilderFor(Counter, dialect)
          .values([ROW, ROW2])
          .onConflict(["mac", "bucketStart"])
          .doUpdate((t, x) => ({
            records: t.records.add(x.records),
            lastTs: Expressions.greatest(t.lastTs, x.lastTs),
          }))
      ),
    postgres: {
      text:
        'INSERT INTO "counter" ("mac", "bucketStart", "records", "lastTs") ' +
        "VALUES (?, ?, ?, ?), (?, ?, ?, ?) " +
        'ON CONFLICT ("mac", "bucketStart") DO UPDATE SET ' +
        '"records" = ("records" + EXCLUDED."records"), ' +
        '"lastTs" = GREATEST("lastTs", EXCLUDED."lastTs")',
      values: ["aa", 100, 5, 150, "bb", 200, 7, 250],
    },
    mysql: {
      text:
        "INSERT INTO `counter` (`mac`, `bucketStart`, `records`, `lastTs`) " +
        "VALUES (?, ?, ?, ?), (?, ?, ?, ?) " +
        "ON DUPLICATE KEY UPDATE " +
        "`records` = (`records` + VALUES(`records`)), " +
        "`lastTs` = GREATEST(`lastTs`, VALUES(`lastTs`))",
      values: ["aa", 100, 5, 150, "bb", 200, 7, 250],
    },
    sqlite: {
      text:
        'INSERT INTO "counter" ("mac", "bucketStart", "records", "lastTs") ' +
        "VALUES (?, ?, ?, ?), (?, ?, ?, ?) " +
        'ON CONFLICT ("mac", "bucketStart") DO UPDATE SET ' +
        '"records" = ("records" + excluded."records"), ' +
        '"lastTs" = MAX("lastTs", excluded."lastTs")',
      values: ["aa", 100, 5, 150, "bb", 200, 7, 250],
    },
  },
  {
    name: "doUpdate(columns) — overwrite with the proposed values",
    build: (dialect) =>
      render(
        createInsertBuilderFor(Counter, dialect)
          .values(ROW)
          .onConflict(["mac", "bucketStart"])
          .doUpdate(["records", "lastTs"])
      ),
    postgres: {
      text:
        'INSERT INTO "counter" ("mac", "bucketStart", "records", "lastTs") ' +
        "VALUES (?, ?, ?, ?) " +
        'ON CONFLICT ("mac", "bucketStart") DO UPDATE SET ' +
        '"records" = EXCLUDED."records", "lastTs" = EXCLUDED."lastTs"',
      values: ["aa", 100, 5, 150],
    },
    mysql: {
      text:
        "INSERT INTO `counter` (`mac`, `bucketStart`, `records`, `lastTs`) " +
        "VALUES (?, ?, ?, ?) " +
        "ON DUPLICATE KEY UPDATE " +
        "`records` = VALUES(`records`), `lastTs` = VALUES(`lastTs`)",
      values: ["aa", 100, 5, 150],
    },
    sqlite: {
      text:
        'INSERT INTO "counter" ("mac", "bucketStart", "records", "lastTs") ' +
        "VALUES (?, ?, ?, ?) " +
        'ON CONFLICT ("mac", "bucketStart") DO UPDATE SET ' +
        '"records" = excluded."records", "lastTs" = excluded."lastTs"',
      values: ["aa", 100, 5, 150],
    },
  },
  {
    name: "doUpdate(object) — literal binds, raw Sql splices",
    build: (dialect) =>
      render(
        createInsertBuilderFor(Counter, dialect)
          .values(ROW)
          .onConflict(["mac", "bucketStart"])
          .doUpdate({ records: 0, lastTs: sql`0 + 1` })
      ),
    postgres: {
      text:
        'INSERT INTO "counter" ("mac", "bucketStart", "records", "lastTs") ' +
        "VALUES (?, ?, ?, ?) " +
        'ON CONFLICT ("mac", "bucketStart") DO UPDATE SET ' +
        '"records" = ?, "lastTs" = 0 + 1',
      values: ["aa", 100, 5, 150, 0],
    },
    mysql: {
      text:
        "INSERT INTO `counter` (`mac`, `bucketStart`, `records`, `lastTs`) " +
        "VALUES (?, ?, ?, ?) " +
        "ON DUPLICATE KEY UPDATE `records` = ?, `lastTs` = 0 + 1",
      values: ["aa", 100, 5, 150, 0],
    },
    sqlite: {
      text:
        'INSERT INTO "counter" ("mac", "bucketStart", "records", "lastTs") ' +
        "VALUES (?, ?, ?, ?) " +
        'ON CONFLICT ("mac", "bucketStart") DO UPDATE SET ' +
        '"records" = ?, "lastTs" = 0 + 1',
      values: ["aa", 100, 5, 150, 0],
    },
  },
  {
    name: "doNothing — DO NOTHING vs INSERT IGNORE",
    build: (dialect) =>
      render(
        createInsertBuilderFor(Counter, dialect)
          .values(ROW)
          .onConflict(["mac", "bucketStart"])
          .doNothing()
      ),
    postgres: {
      text:
        'INSERT INTO "counter" ("mac", "bucketStart", "records", "lastTs") ' +
        'VALUES (?, ?, ?, ?) ON CONFLICT ("mac", "bucketStart") DO NOTHING',
      values: ["aa", 100, 5, 150],
    },
    mysql: {
      text:
        "INSERT IGNORE INTO `counter` " +
        "(`mac`, `bucketStart`, `records`, `lastTs`) VALUES (?, ?, ?, ?)",
      values: ["aa", 100, 5, 150],
    },
    sqlite: {
      text:
        'INSERT INTO "counter" ("mac", "bucketStart", "records", "lastTs") ' +
        'VALUES (?, ?, ?, ?) ON CONFLICT ("mac", "bucketStart") DO NOTHING',
      values: ["aa", 100, 5, 150],
    },
  },
  {
    name: "conflict target defaults to the primary key",
    build: (dialect) =>
      render(
        createInsertBuilderFor(Counter, dialect)
          .values(ROW)
          .doUpdate(["records"])
      ),
    postgres: {
      text:
        'INSERT INTO "counter" ("mac", "bucketStart", "records", "lastTs") ' +
        "VALUES (?, ?, ?, ?) " +
        'ON CONFLICT ("mac", "bucketStart") DO UPDATE SET ' +
        '"records" = EXCLUDED."records"',
      values: ["aa", 100, 5, 150],
    },
    mysql: {
      text:
        "INSERT INTO `counter` (`mac`, `bucketStart`, `records`, `lastTs`) " +
        "VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE " +
        "`records` = VALUES(`records`)",
      values: ["aa", 100, 5, 150],
    },
    sqlite: {
      text:
        'INSERT INTO "counter" ("mac", "bucketStart", "records", "lastTs") ' +
        "VALUES (?, ?, ?, ?) " +
        'ON CONFLICT ("mac", "bucketStart") DO UPDATE SET ' +
        '"records" = excluded."records"',
      values: ["aa", 100, 5, 150],
    },
  },
  {
    name: "doUpdateWhere — PG/SQLite render it, MySQL has no equivalent",
    build: (dialect) =>
      render(
        createInsertBuilderFor(Counter, dialect)
          .values(ROW)
          .onConflict(["mac", "bucketStart"])
          .doUpdate({ lastTs: ex.lastTs })
          .doUpdateWhere(c.lastTs.lt(300))
      ),
    postgres: {
      text:
        'INSERT INTO "counter" ("mac", "bucketStart", "records", "lastTs") ' +
        "VALUES (?, ?, ?, ?) " +
        'ON CONFLICT ("mac", "bucketStart") DO UPDATE SET ' +
        '"lastTs" = EXCLUDED."lastTs" WHERE "lastTs" < ?',
      values: ["aa", 100, 5, 150, 300],
    },
    mysql: { throws: OrmErrorCode.UNSUPPORTED_OPERATION },
    sqlite: {
      text:
        'INSERT INTO "counter" ("mac", "bucketStart", "records", "lastTs") ' +
        "VALUES (?, ?, ?, ?) " +
        'ON CONFLICT ("mac", "bucketStart") DO UPDATE SET ' +
        '"lastTs" = excluded."lastTs" WHERE "lastTs" < ?',
      values: ["aa", 100, 5, 150, 300],
    },
  },
  {
    name: "partial-index predicate — PG/SQLite only",
    build: (dialect) =>
      render(
        createInsertBuilderFor(Counter, dialect)
          .values(ROW)
          .onConflict(["mac"], { where: c.lastTs.isNotNull() })
          .doUpdate(["records"])
      ),
    postgres: {
      text:
        'INSERT INTO "counter" ("mac", "bucketStart", "records", "lastTs") ' +
        "VALUES (?, ?, ?, ?) " +
        'ON CONFLICT ("mac") WHERE "lastTs" IS NOT NULL DO UPDATE SET ' +
        '"records" = EXCLUDED."records"',
      values: ["aa", 100, 5, 150],
    },
    mysql: { throws: OrmErrorCode.UNSUPPORTED_OPERATION },
    sqlite: {
      text:
        'INSERT INTO "counter" ("mac", "bucketStart", "records", "lastTs") ' +
        "VALUES (?, ?, ?, ?) " +
        'ON CONFLICT ("mac") WHERE "lastTs" IS NOT NULL DO UPDATE SET ' +
        '"records" = excluded."records"',
      values: ["aa", 100, 5, 150],
    },
  },
  {
    name: "ON CONSTRAINT — PostgreSQL only",
    build: (dialect) =>
      render(
        createInsertBuilderFor(Counter, dialect)
          .values(ROW)
          .onConflictConstraint("counter_pk")
          .doNothing()
      ),
    postgres: {
      text:
        'INSERT INTO "counter" ("mac", "bucketStart", "records", "lastTs") ' +
        'VALUES (?, ?, ?, ?) ON CONFLICT ON CONSTRAINT "counter_pk" DO NOTHING',
      values: ["aa", 100, 5, 150],
    },
    mysql: { throws: OrmErrorCode.UNSUPPORTED_OPERATION },
    sqlite: { throws: OrmErrorCode.UNSUPPORTED_OPERATION },
  },
  {
    name: "guarded upsert — advance only when the proposed row is newer",
    build: (dialect) =>
      render(
        createInsertBuilderFor(Counter, dialect)
          .values(ROW)
          .onConflict(["mac", "bucketStart"])
          .doUpdate((t, x) => ({ records: x.records, lastTs: x.lastTs }))
          .doUpdateWhere(c.lastTs.lt(ex.lastTs))
      ),
    postgres: {
      text:
        'INSERT INTO "counter" ("mac", "bucketStart", "records", "lastTs") ' +
        "VALUES (?, ?, ?, ?) " +
        'ON CONFLICT ("mac", "bucketStart") DO UPDATE SET ' +
        '"records" = EXCLUDED."records", "lastTs" = EXCLUDED."lastTs" ' +
        'WHERE "lastTs" < EXCLUDED."lastTs"',
      values: ["aa", 100, 5, 150],
    },
    mysql: { throws: OrmErrorCode.UNSUPPORTED_OPERATION },
    sqlite: {
      text:
        'INSERT INTO "counter" ("mac", "bucketStart", "records", "lastTs") ' +
        "VALUES (?, ?, ?, ?) " +
        'ON CONFLICT ("mac", "bucketStart") DO UPDATE SET ' +
        '"records" = excluded."records", "lastTs" = excluded."lastTs" ' +
        'WHERE "lastTs" < excluded."lastTs"',
      values: ["aa", 100, 5, 150],
    },
  },
  {
    name: "CASE fold — the guard as an iff() assignment, portable to MySQL",
    build: (dialect) =>
      render(
        createInsertBuilderFor(Counter, dialect)
          .values(ROW)
          .onConflict(["mac", "bucketStart"])
          .doUpdate((t, x) => ({
            lastTs: Expressions.iff(x.lastTs.gt(t.lastTs), x.lastTs, t.lastTs),
          }))
      ),
    postgres: {
      text:
        'INSERT INTO "counter" ("mac", "bucketStart", "records", "lastTs") ' +
        "VALUES (?, ?, ?, ?) " +
        'ON CONFLICT ("mac", "bucketStart") DO UPDATE SET ' +
        '"lastTs" = CASE WHEN EXCLUDED."lastTs" > "lastTs" ' +
        'THEN EXCLUDED."lastTs" ELSE "lastTs" END',
      values: ["aa", 100, 5, 150],
    },
    mysql: {
      text:
        "INSERT INTO `counter` (`mac`, `bucketStart`, `records`, `lastTs`) " +
        "VALUES (?, ?, ?, ?) " +
        "ON DUPLICATE KEY UPDATE " +
        "`lastTs` = CASE WHEN VALUES(`lastTs`) > `lastTs` " +
        "THEN VALUES(`lastTs`) ELSE `lastTs` END",
      values: ["aa", 100, 5, 150],
    },
    sqlite: {
      text:
        'INSERT INTO "counter" ("mac", "bucketStart", "records", "lastTs") ' +
        "VALUES (?, ?, ?, ?) " +
        'ON CONFLICT ("mac", "bucketStart") DO UPDATE SET ' +
        '"lastTs" = CASE WHEN excluded."lastTs" > "lastTs" ' +
        'THEN excluded."lastTs" ELSE "lastTs" END',
      values: ["aa", 100, 5, 150],
    },
  },
  {
    name: "raw Sql in a VALUES cell — spliced as written, not bound",
    build: (dialect) =>
      render(
        createInsertBuilderFor(Counter, dialect).values({
          mac: "aa",
          bucketStart: 100,
          records: 5,
          lastTs: sql`1000 + 1`,
        })
      ),
    postgres: {
      text:
        'INSERT INTO "counter" ("mac", "bucketStart", "records", "lastTs") ' +
        "VALUES (?, ?, ?, 1000 + 1)",
      values: ["aa", 100, 5],
    },
    mysql: {
      text:
        "INSERT INTO `counter` (`mac`, `bucketStart`, `records`, `lastTs`) " +
        "VALUES (?, ?, ?, 1000 + 1)",
      values: ["aa", 100, 5],
    },
    sqlite: {
      text:
        'INSERT INTO "counter" ("mac", "bucketStart", "records", "lastTs") ' +
        "VALUES (?, ?, ?, 1000 + 1)",
      values: ["aa", 100, 5],
    },
  },
  {
    name: "plain INSERT — no conflict clause when no action is declared",
    build: (dialect) =>
      render(createInsertBuilderFor(Counter, dialect).values(ROW)),
    postgres: {
      text:
        'INSERT INTO "counter" ("mac", "bucketStart", "records", "lastTs") ' +
        "VALUES (?, ?, ?, ?)",
      values: ["aa", 100, 5, 150],
    },
    mysql: {
      text:
        "INSERT INTO `counter` (`mac`, `bucketStart`, `records`, `lastTs`) " +
        "VALUES (?, ?, ?, ?)",
      values: ["aa", 100, 5, 150],
    },
    sqlite: {
      text:
        'INSERT INTO "counter" ("mac", "bucketStart", "records", "lastTs") ' +
        "VALUES (?, ?, ?, ?)",
      values: ["aa", 100, 5, 150],
    },
  },
];

runBuilderGoldenMatrix("golden-sql / INSERT ... ON CONFLICT", cases);
