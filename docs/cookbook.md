# Analytical Query Cookbook

A set of real-world analytical query recipes built on top of the ORM's Expressions DSL, window functions, `date_trunc`, ordered-set aggregates, and recursive CTEs. Every recipe in this page is taken verbatim from the [`nestjs-linear-clone` analytics service](https://github.com/biud436/stingerloom-orm/blob/main/examples/nestjs-linear-clone/src/modules/analytics/analytics.service.ts), so each one is exercised by the example's e2e tests and stays in sync with the codebase.

If you have not read it yet, the [Raw SQL & CTE](./raw-sql.md) page introduces `em.ref()` / `em.aliasRef()` / `RawQueryBuilder` -- the building blocks every recipe here leans on once the typed DSL runs out of expressiveness.

## At a glance

| Recipe | Pattern | Dialect support |
|--------|---------|-----------------|
| [Sprint burndown](#sprint-burndown) | `date_trunc` + group-by + JS-side prefix sum | PostgreSQL / MySQL / SQLite |
| [Time-in-status](#time-in-status) | `LEAD()` window function + `dateDiff` | PostgreSQL / MySQL / SQLite |
| [Weekly lead time](#weekly-lead-time) | `dateTrunc('week', ...)` + average | PostgreSQL / MySQL / SQLite |
| [Cycle-time percentile report](#cycle-time-percentile-report) | `percentile_cont` (PG) or `ROW_NUMBER()` emulation (MySQL) | PostgreSQL native, MySQL emulated |
| [Recursive issue tree](#recursive-issue-tree) | `WITH RECURSIVE` via `RawQueryBuilder` | PostgreSQL / MySQL |

## Sprint burndown

> **Problem.** For a sprint, plot the burndown chart: per calendar day, the number of issues completed that day, the cumulative number completed so far, and the remaining estimate.

The whole shape can be expressed without a window function: a single GROUP BY query produces the daily aggregate, and the prefix sum is folded in JavaScript afterwards. The trick is `Expressions.dateTrunc(completedAt, "day")` -- the same expression compiles to `DATE_TRUNC(...)` on PostgreSQL, `DATE(...)` on MySQL, and `date(..., 'start of day')` on SQLite, so the query is portable as written.

```typescript
import { Expressions, qAlias } from "@stingerloom/orm";

const i = qAlias(Issue, "i");

// 1. Sprint total estimate -- a single scalar.
const totalRow = await em
  .createQueryBuilder(Issue, "i")
  .select([
    Expressions.coalesce(Expressions.sum(i.estimate), 0).as("totalEstimate"),
  ])
  .where(i.sprintId.eq(sprintId))
  .andWhere(i.deletedAt.isNull())
  .getRawOne();
const totalEstimate = Number(totalRow?.totalEstimate ?? 0);

// 2. Daily aggregates over completed issues.
const day = Expressions.dateTrunc(i.completedAt, "day");
const dailyRows = await em
  .createQueryBuilder(Issue, "i")
  .select([
    day.as("day"),
    Expressions.count("*").as("completedCount"),
    Expressions.coalesce(Expressions.sum(i.estimate), 0).as("completedEstimate"),
  ])
  .where(i.sprintId.eq(sprintId))
  .andWhere(i.deletedAt.isNull())
  .andWhere(i.status.eq("DONE"))
  .andWhere(i.completedAt.isNotNull())
  .groupBy([day])
  .addOrderBy(day, "ASC")
  .getRawMany();

// 3. Running totals in JS (sprint windows are short, so the prefix sum
//    in application code keeps the SQL free of window-over-CTE plumbing).
let cumulativeCompleted = 0;
let cumulativeEstimate = 0;
const burndown = dailyRows.map((row) => {
  cumulativeCompleted += Number(row.completedCount);
  cumulativeEstimate += Number(row.completedEstimate);
  return {
    day: row.day,
    completedThatDay: Number(row.completedCount),
    cumulativeCompleted,
    remainingEstimate: totalEstimate - cumulativeEstimate,
  };
});
```

**Compiled SQL (PostgreSQL):**
```sql
SELECT
  DATE_TRUNC('day', "i"."completed_at") AS "day",
  COUNT(*) AS "completedCount",
  COALESCE(SUM("i"."estimate"), 0) AS "completedEstimate"
FROM "issue" AS "i"
WHERE "i"."sprint_id" = $1
  AND "i"."deleted_at" IS NULL
  AND "i"."status" = $2
  AND "i"."completed_at" IS NOT NULL
GROUP BY DATE_TRUNC('day', "i"."completed_at")
ORDER BY DATE_TRUNC('day', "i"."completed_at") ASC;
```

The MySQL form uses `DATE(...)` and backtick quoting; SQLite uses `date(...)`. The Expressions DSL picks the right form per dialect.

## Time-in-status

> **Problem.** For an issue, build the status timeline -- one row per status transition, with the number of hours the issue spent in each status before the next change.

The source data is the `activity_log` table, where each row records a status change (`statusFrom` and `statusTo` are denormalized typed columns populated by the audit subscriber). The hours-in-status of a row is `next_row.created_at - this_row.created_at`. `LEAD()` is the natural window function for "next row in the partition," and `dateDiff` produces a portable second-level interval.

```typescript
import { Expressions, qAlias } from "@stingerloom/orm";

const a = qAlias(ActivityLog, "a");

const leftAt = Expressions
  .lead(a.createdAt)
  .partitionBy(a.issueId)
  .orderBy(a.createdAt.asc())
  .toScalar();

const hoursInStatus = Expressions
  .dateDiff(leftAt, a.createdAt, "second")
  .floatValue()
  .div(3600);

const rows = await em
  .createQueryBuilder(ActivityLog, "a")
  .select([
    a.issueId.as("issueId"),
    a.statusTo.as("status"),
    a.createdAt.as("enteredAt"),
    leftAt.as("leftAt"),
    hoursInStatus.as("hoursInStatus"),
  ])
  .where(a.issueId.eq(issueId))
  .andWhere(a.statusTo.isNotNull())
  .addOrderBy(a.createdAt, "ASC")
  .getRawMany();
```

`.floatValue().div(3600)` keeps the division floating-point on every dialect (PostgreSQL would integer-truncate otherwise).

**Compiled SQL (PostgreSQL):**
```sql
SELECT
  "a"."issue_id" AS "issueId",
  "a"."status_to" AS "status",
  "a"."created_at" AS "enteredAt",
  LEAD("a"."created_at") OVER (
    PARTITION BY "a"."issue_id"
    ORDER BY "a"."created_at" ASC
  ) AS "leftAt",
  CAST(EXTRACT(EPOCH FROM (
    LEAD("a"."created_at") OVER (
      PARTITION BY "a"."issue_id" ORDER BY "a"."created_at" ASC
    ) - "a"."created_at"
  )) AS DOUBLE PRECISION) / 3600 AS "hoursInStatus"
FROM "activity_log" AS "a"
WHERE "a"."issue_id" = $1 AND "a"."status_to" IS NOT NULL
ORDER BY "a"."created_at" ASC;
```

`LEAD()` works on all three supported dialects; only the `dateDiff` rendering differs between them.

## Weekly lead time

> **Problem.** For a project, plot weekly average lead time (hours between `createdAt` and `completedAt`) over the last `windowDays` days.

`Expressions.dateTrunc(completedAt, "week")` renders an ISO-Monday week start on every dialect: PostgreSQL `date_trunc('week', ...)`, MySQL `DATE_SUB(... INTERVAL WEEKDAY(...) DAY)`, SQLite `date(..., '-N days')`. The aggregate is a plain `AVG()` over a derived scalar.

```typescript
import { Expressions, qAlias } from "@stingerloom/orm";

const i = qAlias(Issue, "i");
const cycleHours = Expressions
  .dateDiff(i.completedAt, i.createdAt, "second")
  .floatValue()
  .div(3600);
const week = Expressions.dateTrunc(i.completedAt, "week");
const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

const rows = await em
  .createQueryBuilder(Issue, "i")
  .select([
    week.as("weekStart"),
    Expressions.avg(cycleHours).as("leadTimeHours"),
    Expressions.count("*").as("closedCount"),
  ])
  .where(i.projectId.eq(projectId))
  .andWhere(i.status.eq("DONE"))
  .andWhere(i.completedAt.isNotNull())
  .andWhere(i.completedAt.gte(cutoff))
  .andWhere(i.deletedAt.isNull())
  .groupBy([week])
  .addOrderBy(week, "ASC")
  .getRawMany();
```

**Compiled SQL (PostgreSQL):**
```sql
SELECT
  DATE_TRUNC('week', "i"."completed_at") AS "weekStart",
  AVG(
    CAST(EXTRACT(EPOCH FROM ("i"."completed_at" - "i"."created_at")) AS DOUBLE PRECISION) / 3600
  ) AS "leadTimeHours",
  COUNT(*) AS "closedCount"
FROM "issue" AS "i"
WHERE "i"."project_id" = $1
  AND "i"."status" = $2
  AND "i"."completed_at" IS NOT NULL
  AND "i"."completed_at" >= $3
  AND "i"."deleted_at" IS NULL
GROUP BY DATE_TRUNC('week', "i"."completed_at")
ORDER BY DATE_TRUNC('week', "i"."completed_at") ASC;
```

## Cycle-time percentile report

> **Problem.** Compute the P50 / P75 / P95 of issue cycle time (hours between `createdAt` and `completedAt`) within a recent window.

This is the textbook case where the **dialect support matrix** matters:

- **PostgreSQL** has the SQL-standard ordered-set aggregate `percentile_cont(p) WITHIN GROUP (ORDER BY x)`. `Expressions.percentileCont(...)` renders it directly -- the whole query stays inside `SelectQueryBuilder`.
- **MySQL** has no native ordered-set aggregate. The standard emulation rewrites the query: a CTE attaches `ROW_NUMBER() OVER (ORDER BY x)` to every cycle-time, then the outer query picks the row at `rn = CEIL(N * p)`. Because this needs a whole-query rewrite -- not just a different expression -- the DSL aggregate throws `OrmError(UNSUPPORTED_OPERATION)` on MySQL with a pointer to the emulation pattern.

### Branch by dialect

```typescript
if (em.getDriver() instanceof SqliteDriver) {
  throw new NotImplementedException(
    "cycleTimePercentiles is only available on PostgreSQL and MySQL.",
  );
}
const isPg = detectDialect(em) === "postgres";
return isPg
  ? cycleTimePercentilesPg(projectId, windowDays)
  : cycleTimePercentilesMySqlEmulation(projectId, windowDays);
```

### PostgreSQL -- native ordered-set aggregate

Pure DSL: `Expressions.percentileCont` projects three percentiles in one query.

```typescript
const i = qAlias(Issue, "i");
const cycleHours = Expressions
  .dateDiff(i.completedAt, i.createdAt, "second")
  .floatValue()
  .div(3600);

const row = await em
  .createQueryBuilder(Issue, "i")
  .select([
    Expressions.percentileCont(0.5, cycleHours).as("p50"),
    Expressions.percentileCont(0.75, cycleHours).as("p75"),
    Expressions.percentileCont(0.95, cycleHours).as("p95"),
    i.id.count().as("sampleSize"),
  ])
  .where(i.projectId.eq(projectId))
  .andWhere(i.status.eq("DONE"))
  .andWhere(i.completedAt.isNotNull())
  .andWhere(i.completedAt.gte(cutoff))
  .andWhere(i.deletedAt.isNull())
  .getRawOne();
```

Renders to:

```sql
SELECT
  PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY CAST(EXTRACT(EPOCH FROM (…)) AS DOUBLE PRECISION) / 3600) AS "p50",
  PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY …)                                                       AS "p75",
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY …)                                                       AS "p95",
  COUNT("i"."id") AS "sampleSize"
FROM "issue" AS "i"
WHERE "i"."project_id" = $1 …;
```

### MySQL -- `ROW_NUMBER()` emulation

The CTE is fully typed -- the projection, the `ROW_NUMBER` ordering, and `COUNT(*) OVER ()` for the sample size all come from the query builder. Only the percentile-row picker stays raw (no DSL helper exists for `MAX(CASE WHEN rn = CEIL(total * p) …)`).

```typescript
import sql, { raw } from "sql-template-tag";
import { RawQueryBuilder } from "@stingerloom/orm";

const i = qAlias(Issue, "i");
const cycleHours = Expressions
  .dateDiff(i.completedAt, i.createdAt, "second")
  .floatValue()
  .div(3600);

const cyclesCte = em
  .createQueryBuilder(Issue, "i")
  .select([
    cycleHours.as("hours"),
    Expressions.rowNumber().orderBy(cycleHours.asc()).as("rn"),
    Expressions.count("*").over().as("total"),
  ])
  .where(i.projectId.eq(projectId))
  .andWhere(i.status.eq("DONE"))
  .andWhere(i.completedAt.isNotNull())
  .andWhere(i.completedAt.gte(cutoff))
  .andWhere(i.deletedAt.isNull())
  .toSql();

const c = em.aliasRef("cycles");
const Q = (name: string) => raw(em.wrap(name));
const pick = (p: number) =>
  sql`MAX(CASE WHEN ${c.rn} = CEIL(${c.total} * ${p}) THEN ${c.hours} END)`;

const built = RawQueryBuilder.create()
  .setDatabaseType("mysql")
  .with("cycles", cyclesCte)
  .selectFragments([
    sql`${pick(0.5)}  AS ${Q("p50")}`,
    sql`${pick(0.75)} AS ${Q("p75")}`,
    sql`${pick(0.95)} AS ${Q("p95")}`,
    sql`${c.total}    AS ${Q("sampleSize")}`,
  ])
  .from("cycles")
  .groupBy([c.total])
  .build();

const rows = await em.query<Record<string, unknown>>(built);
```

Why this shape: carrying `total` inside the CTE via `COUNT(*) OVER ()` lets the outer query read `cycles` directly with no FROM-subquery. `cycles` rows only exist when the CTE is non-empty, so `total >= 1` and `CEIL(total * p) >= 1` -- no floor needed.

## Recursive issue tree

> **Problem.** Given a root issue, walk down the `parent_id` chain and return the entire subissue tree, with the depth and a `1/2/3`-style path so a UI can render the tree.

`RawQueryBuilder.withRecursive(...)` writes the leading `WITH RECURSIVE …` clause; we only provide the UNION-ALL body. `em.ref(Issue, "r")` / `em.ref(Issue, "c")` keep both arms entity-aware, and `em.aliasRef("t")` references the CTE-only `depth` / `path` columns.

```typescript
import sql, { raw } from "sql-template-tag";
import { RawQueryBuilder, Sql } from "@stingerloom/orm";

const dialect = detectDialect(em);          // "postgres" | "mysql"
const isMySql = dialect === "mysql";

// MySQL fixes the recursive column type from the anchor, so we need an
// explicit width big enough for `maxDepth` zero-padded segments. PG picks
// TEXT from the anchor and grows freely.
const castText = isMySql ? "VARCHAR(4000)" : "TEXT";

const r = em.ref(Issue, "r");
const c = em.ref(Issue, "c");
const t = em.aliasRef("t");
const Q = (name: string) => raw(em.wrap(name));

// LPAD-zero-padded `path` segments make ORDER BY path produce a depth-
// first preorder by id (instead of lexicographic "10 < 2").
const padded = (idSql: Sql) =>
  sql`LPAD(CAST(${idSql} AS ${raw(castText)}), 10, '0')`;

const built = RawQueryBuilder.create()
  .setDatabaseType(isMySql ? "mysql" : "postgresql")
  .withRecursive("issue_tree", (qb) =>
    qb
      .selectFragments([
        r.as("id"), r.as("parentId"), r.as("number"), r.as("title"), r.as("status"),
        sql`0 AS ${Q("depth")}`,
        sql`CAST(${padded(r.id)} AS ${raw(castText)}) AS ${Q("path")}`,
      ])
      .from(r)
      .where([sql`${r.id} = ${rootIssueId}`, sql`${r.deletedAt} IS NULL`])
      .unionAll()
      .selectFragments([
        c.id, c.parentId, c.number, c.title, c.status,
        sql`${t.depth} + 1`,
        sql`CONCAT(${t.path}, '/', ${padded(c.id)})`,
      ])
      .from(c)
      .innerJoin("issue_tree", "t", sql`${c.parentId} = ${t.id}`)
      .where([sql`${c.deletedAt} IS NULL`, sql`${t.depth} < ${maxDepth}`]),
  )
  .select("*")
  .from("issue_tree")
  .orderBy([{ column: em.wrap("path"), direction: "ASC" }])
  .build();

const rows = await em.query<Record<string, unknown>>(built);
```

Strip the LPAD zeros in JS for a human-readable `1/2/3` path. The sort ordering was already locked in by the DB on the padded form, so the JS unpadding does not need to re-sort.

**Why two refs for the same entity.** `r` is the anchor row (the root issue); `c` is the recursive step (a child row joined back to the CTE). Using two aliased refs against the same `Issue` keeps both arms type-aware without colliding -- `em.ref(Entity, alias)` is designed for exactly this pattern.

**SQLite note.** SQLite supports `WITH RECURSIVE`, but the example wires a 2-way `mysql` / `postgres` switch -- adding a SQLite branch is a small change to the dialect detection, not the query shape.

## Next steps

- [Raw SQL & CTE](./raw-sql.md) -- the building blocks (`em.ref()`, `em.aliasRef()`, `RawQueryBuilder`) every recipe here uses.
- [Query Builder QueryDSL](./query-builder-querydsl.md) -- `Expressions.*` reference, including ordered-set aggregates and window functions.
- [`nestjs-linear-clone` example](https://github.com/biud436/stingerloom-orm/tree/main/examples/nestjs-linear-clone) -- the runnable source these recipes were lifted from, with e2e tests pinning the SQL on PostgreSQL and MySQL.
