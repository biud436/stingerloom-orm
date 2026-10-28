import "reflect-metadata";
import { qAlias } from "../../../src/core/SelectQueryBuilder";
import { Expressions } from "../../../src/core/expressions/LogicalCondition";
import { OrmErrorCode } from "../../../src/errors/OrmErrorCode";
import {
  Column,
  Entity,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateTimestamp,
  Version,
} from "../../../src/decorators";
import { createInsertBuilderFor, createQbFor, Counter } from "./fixtures";
import {
  runBuilderGoldenMatrix,
  type BuilderGoldenCase,
  type DialectName,
} from "./harness";

/**
 * Golden SQL — `InsertQueryBuilder.values(columns, query)`, the
 * `INSERT … SELECT` form.
 *
 * The query is spliced as built wherever the dialect allows it. Two
 * dialects need more around it once a conflict clause follows: SQLite
 * reads `ON` after a FROM clause as a join constraint, so the query is
 * closed off with a WHERE; MySQL 8.0.19+ has no row alias for the SELECT
 * form, so the query becomes a derived table with the same name and
 * column names the row alias uses.
 */

@Entity()
class Reading {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 32 })
  mac!: string;

  @Column({ type: "int" })
  bucketStart!: number;

  @Column({ type: "int" })
  ts!: number;
}

/** A target with ORM-managed columns, which the INSERT appends. */
@Entity()
class Rollup {
  @PrimaryColumn({ type: "varchar", length: 32 })
  mac!: string;

  @Column({ type: "int" })
  records!: number;

  @UpdateTimestamp()
  updatedAt!: Date;

  @Version()
  version!: number;
}

const r = qAlias(Reading, "r");

function render(builder: { build(): { sql: string; values: unknown[] } }): {
  text: string;
  values: unknown[];
} {
  const built = builder.build();
  return { text: built.sql, values: built.values };
}

/** Readings rolled up per (mac, bucket): a count and the latest timestamp. */
function rollupQuery(dialect: DialectName) {
  return createQbFor(Reading, "r", dialect)
    .select([
      r.mac.as("mac"),
      r.bucketStart.as("bucketStart"),
      r.id.count().as("records"),
      r.ts.max().as("lastTs"),
    ])
    .groupBy(["r.mac", "r.bucketStart"]);
}

const COLUMNS = ["mac", "bucketStart", "records", "lastTs"] as const;

const PG_ROLLUP =
  'SELECT "r"."mac" AS "mac", "r"."bucketStart" AS "bucketStart", ' +
  'COUNT("r"."id") AS "records", MAX("r"."ts") AS "lastTs" ' +
  'FROM "reading" AS "r" GROUP BY "r"."mac", "r"."bucketStart"';
const MY_ROLLUP =
  "SELECT `r`.`mac` AS `mac`, `r`.`bucketStart` AS `bucketStart`, " +
  "COUNT(`r`.`id`) AS `records`, MAX(`r`.`ts`) AS `lastTs` " +
  "FROM `reading` AS `r` GROUP BY `r`.`mac`, `r`.`bucketStart`";
const SQLITE_ROLLUP = PG_ROLLUP;

const PG_INTO =
  'INSERT INTO "counter" ("mac", "bucketStart", "records", "lastTs") ';
const MY_INTO =
  "INSERT INTO `counter` (`mac`, `bucketStart`, `records`, `lastTs`) ";

const cases: BuilderGoldenCase[] = [
  {
    name: "plain INSERT … SELECT — the query as built",
    build: (dialect) =>
      render(
        createInsertBuilderFor(Counter, dialect).values(
          [...COLUMNS],
          rollupQuery(dialect),
        ),
      ),
    postgres: { text: PG_INTO + PG_ROLLUP, values: [] },
    mysql: { text: MY_INTO + MY_ROLLUP, values: [] },
    sqlite: { text: PG_INTO + SQLITE_ROLLUP, values: [] },
  },
  {
    name: "accumulate on conflict",
    build: (dialect) =>
      render(
        createInsertBuilderFor(Counter, dialect)
          .values([...COLUMNS], rollupQuery(dialect))
          .onConflict(["mac", "bucketStart"])
          .doUpdate((t, x) => ({
            records: t.records.add(x.records),
            lastTs: Expressions.greatest(t.lastTs, x.lastTs),
          })),
      ),
    postgres: {
      text:
        PG_INTO +
        PG_ROLLUP +
        ' ON CONFLICT ("mac", "bucketStart") DO UPDATE SET ' +
        '"records" = ("counter"."records" + EXCLUDED."records"), ' +
        '"lastTs" = GREATEST("counter"."lastTs", EXCLUDED."lastTs")',
      values: [],
    },
    mysql: {
      text:
        MY_INTO +
        MY_ROLLUP +
        " ON DUPLICATE KEY UPDATE " +
        "`records` = (`counter`.`records` + VALUES(`records`)), " +
        "`lastTs` = GREATEST(`counter`.`lastTs`, VALUES(`lastTs`))",
      values: [],
    },
    sqlite: {
      text:
        PG_INTO +
        `SELECT * FROM (${SQLITE_ROLLUP}) WHERE true` +
        ' ON CONFLICT ("mac", "bucketStart") DO UPDATE SET ' +
        '"records" = ("counter"."records" + excluded."records"), ' +
        '"lastTs" = MAX("counter"."lastTs", excluded."lastTs")',
      values: [],
    },
  },
  {
    name: "doNothing",
    build: (dialect) =>
      render(
        createInsertBuilderFor(Counter, dialect)
          .values([...COLUMNS], rollupQuery(dialect))
          .onConflict(["mac", "bucketStart"])
          .doNothing(),
      ),
    postgres: {
      text:
        PG_INTO + PG_ROLLUP + ' ON CONFLICT ("mac", "bucketStart") DO NOTHING',
      values: [],
    },
    mysql: {
      text:
        "INSERT IGNORE INTO `counter` (`mac`, `bucketStart`, `records`, `lastTs`) " +
        MY_ROLLUP,
      values: [],
    },
    sqlite: {
      text:
        PG_INTO +
        `SELECT * FROM (${SQLITE_ROLLUP}) WHERE true` +
        ' ON CONFLICT ("mac", "bucketStart") DO NOTHING',
      values: [],
    },
  },
  {
    name: "the query's bound values keep their order",
    build: (dialect) =>
      render(
        createInsertBuilderFor(Counter, dialect)
          .values(
            [...COLUMNS],
            rollupQuery(dialect).where(r.ts.gt(10)).having(r.id.count().gt(2)),
          )
          .onConflict(["mac", "bucketStart"])
          .doUpdate((t, x) => ({ records: t.records.add(x.records).add(1) })),
      ),
    postgres: {
      text:
        PG_INTO +
        'SELECT "r"."mac" AS "mac", "r"."bucketStart" AS "bucketStart", ' +
        'COUNT("r"."id") AS "records", MAX("r"."ts") AS "lastTs" ' +
        'FROM "reading" AS "r" WHERE "r"."ts" > ? ' +
        'GROUP BY "r"."mac", "r"."bucketStart" HAVING COUNT("r"."id") > ?' +
        ' ON CONFLICT ("mac", "bucketStart") DO UPDATE SET ' +
        '"records" = (("counter"."records" + EXCLUDED."records") + ?)',
      values: [10, 2, 1],
    },
    mysql: {
      text:
        MY_INTO +
        "SELECT `r`.`mac` AS `mac`, `r`.`bucketStart` AS `bucketStart`, " +
        "COUNT(`r`.`id`) AS `records`, MAX(`r`.`ts`) AS `lastTs` " +
        "FROM `reading` AS `r` WHERE `r`.`ts` > ? " +
        "GROUP BY `r`.`mac`, `r`.`bucketStart` HAVING COUNT(`r`.`id`) > ?" +
        " ON DUPLICATE KEY UPDATE " +
        "`records` = ((`counter`.`records` + VALUES(`records`)) + ?)",
      values: [10, 2, 1],
    },
    sqlite: {
      text:
        PG_INTO +
        "SELECT * FROM (" +
        'SELECT "r"."mac" AS "mac", "r"."bucketStart" AS "bucketStart", ' +
        'COUNT("r"."id") AS "records", MAX("r"."ts") AS "lastTs" ' +
        'FROM "reading" AS "r" WHERE "r"."ts" > ? ' +
        'GROUP BY "r"."mac", "r"."bucketStart" HAVING COUNT("r"."id") > ?' +
        ") WHERE true" +
        ' ON CONFLICT ("mac", "bucketStart") DO UPDATE SET ' +
        '"records" = (("counter"."records" + excluded."records") + ?)',
      values: [10, 2, 1],
    },
  },
  {
    name: "a query that selects every column is rejected",
    build: (dialect) =>
      render(
        createInsertBuilderFor(Counter, dialect).values(
          [...COLUMNS],
          createQbFor(Reading, "r", dialect),
        ),
      ),
    postgres: { throws: OrmErrorCode.INVALID_QUERY },
    mysql: { throws: OrmErrorCode.INVALID_QUERY },
    sqlite: { throws: OrmErrorCode.INVALID_QUERY },
  },
  {
    name: "reading a proposed column the INSERT does not write is rejected",
    build: (dialect) =>
      render(
        createInsertBuilderFor(Counter, dialect)
          .values(["mac", "bucketStart", "records"], rollupQuery(dialect))
          .onConflict(["mac", "bucketStart"])
          .doUpdate(["records", "lastTs"]),
      ),
    postgres: { throws: OrmErrorCode.INVALID_QUERY },
    mysql: { throws: OrmErrorCode.INVALID_QUERY },
    sqlite: { throws: OrmErrorCode.INVALID_QUERY },
  },
];

runBuilderGoldenMatrix("golden-sql / INSERT … SELECT", cases);

describe("golden-sql / INSERT … SELECT — ORM-managed columns", () => {
  const rollupByMac = (dialect: DialectName, distinct = false) => {
    const qb = createQbFor(Reading, "r", dialect).select([
      r.mac.as("mac"),
      r.ts.as("records"),
    ]);
    return distinct ? qb.setDistinct() : qb.groupBy(["r.mac", "r.ts"]);
  };

  it.each<[DialectName, string]>([
    [
      "postgres",
      'INSERT INTO "rollup" ("mac", "records", "updatedAt", "version") ' +
        'SELECT "r"."mac" AS "mac", "r"."ts" AS "records", ? AS "updatedAt", ? AS "version" ' +
        'FROM "reading" AS "r" GROUP BY "r"."mac", "r"."ts"',
    ],
    [
      "mysql",
      "INSERT INTO `rollup` (`mac`, `records`, `updatedAt`, `version`) " +
        "SELECT `r`.`mac` AS `mac`, `r`.`ts` AS `records`, ? AS `updatedAt`, ? AS `version` " +
        "FROM `reading` AS `r` GROUP BY `r`.`mac`, `r`.`ts`",
    ],
  ])("appends the managed columns to the select list on %s", (dialect, text) => {
    expect(
      render(
        createInsertBuilderFor(Rollup, dialect).values(
          ["mac", "records"],
          rollupByMac(dialect),
        ),
      ),
    ).toEqual({ text, values: [expect.anything(), 1] });
  });

  it("moves them out of a DISTINCT select list on PostgreSQL", () => {
    // Inside a DISTINCT, PostgreSQL would type the parameters as text.
    expect(
      render(
        createInsertBuilderFor(Rollup, "postgres").values(
          ["mac", "records"],
          rollupByMac("postgres", true),
        ),
      ),
    ).toEqual({
      text:
        'INSERT INTO "rollup" ("mac", "records", "updatedAt", "version") ' +
        'SELECT "__src".*, ? AS "updatedAt", ? AS "version" FROM (' +
        'SELECT DISTINCT "r"."mac" AS "mac", "r"."ts" AS "records" FROM "reading" AS "r"' +
        ') AS "__src"',
      values: [expect.anything(), 1],
    });
  });

  it("keeps them in a DISTINCT select list elsewhere", () => {
    expect(
      render(
        createInsertBuilderFor(Rollup, "mysql").values(
          ["mac", "records"],
          rollupByMac("mysql", true),
        ),
      ).text,
    ).toBe(
      "INSERT INTO `rollup` (`mac`, `records`, `updatedAt`, `version`) " +
        "SELECT DISTINCT `r`.`mac` AS `mac`, `r`.`ts` AS `records`, ? AS `updatedAt`, ? AS `version` " +
        "FROM `reading` AS `r`",
    );
  });

  it("leaves a managed column the query selects to the query", () => {
    expect(
      render(
        createInsertBuilderFor(Rollup, "postgres").values(
          ["mac", "records", "version"],
          createQbFor(Reading, "r", "postgres").select([
            r.mac.as("mac"),
            r.ts.as("records"),
            r.id.as("version"),
          ]),
        ),
      ),
    ).toEqual({
      text:
        'INSERT INTO "rollup" ("mac", "records", "version", "updatedAt") ' +
        'SELECT "r"."mac" AS "mac", "r"."ts" AS "records", "r"."id" AS "version", ? AS "updatedAt" ' +
        'FROM "reading" AS "r"',
      values: [expect.anything()],
    });
  });

  it("does not change the query it was given", () => {
    const query = rollupByMac("postgres");
    const before = query.getSql();
    const builder = createInsertBuilderFor(Rollup, "postgres").values(
      ["mac", "records"],
      query,
    );
    render(builder);
    render(builder);
    expect(query.getSql()).toEqual(before);
  });
});

/**
 * MySQL 8.0.19+ reads the proposed row of a VALUES list through a row
 * alias, which the SELECT form does not take. The query becomes a derived
 * table under the same alias and column names instead, so the conflict
 * action renders the same `new`.`__col` references.
 */
describe("golden-sql / INSERT … SELECT — MySQL 8.0.19+", () => {
  const mysql8 = <T>(entity: new () => T) =>
    createInsertBuilderFor(entity, "mysql", { rowAlias: true });

  it("reads the proposed row from a derived table", () => {
    expect(
      render(
        mysql8(Counter)
          .values([...COLUMNS], rollupQuery("mysql"))
          .onConflict(["mac", "bucketStart"])
          .doUpdate((t, x) => ({
            records: t.records.add(x.records),
            lastTs: Expressions.greatest(t.lastTs, x.lastTs),
          })),
      ),
    ).toEqual({
      text:
        MY_INTO +
        `SELECT * FROM (${MY_ROLLUP}) ` +
        "AS `new` (`__mac`, `__bucketStart`, `__records`, `__lastTs`) " +
        "ON DUPLICATE KEY UPDATE " +
        "`records` = (`counter`.`records` + `new`.`__records`), " +
        "`lastTs` = GREATEST(`counter`.`lastTs`, `new`.`__lastTs`)",
      values: [],
    });
  });

  it("holds the managed columns inside the derived table", () => {
    expect(
      render(
        mysql8(Rollup)
          .values(
            ["mac", "records"],
            createQbFor(Reading, "r", "mysql").select([
              r.mac.as("mac"),
              r.ts.as("records"),
            ]),
          )
          .onConflict(["mac"])
          .doUpdate(["records", "updatedAt"]),
      ),
    ).toEqual({
      text:
        "INSERT INTO `rollup` (`mac`, `records`, `updatedAt`, `version`) " +
        "SELECT * FROM (" +
        "SELECT `r`.`mac` AS `mac`, `r`.`ts` AS `records`, ? AS `updatedAt`, ? AS `version` " +
        "FROM `reading` AS `r`" +
        ") AS `new` (`__mac`, `__records`, `__updatedAt`, `__version`) " +
        "ON DUPLICATE KEY UPDATE " +
        "`records` = `new`.`__records`, `updatedAt` = `new`.`__updatedAt`",
      values: [expect.anything(), 1],
    });
  });

  it("doNothing stays INSERT IGNORE over the query as built", () => {
    expect(
      render(
        mysql8(Counter)
          .values([...COLUMNS], rollupQuery("mysql"))
          .doNothing(),
      ).text,
    ).toBe(
      "INSERT IGNORE INTO `counter` (`mac`, `bucketStart`, `records`, `lastTs`) " +
        MY_ROLLUP,
    );
  });

  it("a plain INSERT … SELECT has no derived table", () => {
    expect(
      render(mysql8(Counter).values([...COLUMNS], rollupQuery("mysql"))).text,
    ).toBe(MY_INTO + MY_ROLLUP);
  });
});
