# 분석 쿼리 Cookbook

ORM의 Expressions DSL, window function, `date_trunc`, ordered-set aggregate, recursive CTE 위에 구축된 실전 분석 쿼리 레시피예요. 이 페이지의 모든 레시피는 [`nestjs-linear-clone` 분석 서비스](https://github.com/biud436/stingerloom-orm/blob/main/examples/nestjs-linear-clone/src/modules/analytics/analytics.service.ts)에서 그대로 가져왔어요 -- 각 레시피는 예제의 e2e 테스트가 검증하므로 코드베이스와 항상 동기화돼요.

아직 [Raw SQL & CTE](./raw-sql.md) 페이지를 읽지 않았다면 먼저 확인해 보세요. 거기서 소개한 `em.ref()` / `em.aliasRef()` / `RawQueryBuilder`가 모든 레시피의 빌딩 블록이에요.

## 한눈에 보기

| 레시피 | 패턴 | Dialect 지원 |
|--------|------|-------------|
| [Sprint burndown](#sprint-burndown) | `date_trunc` + group-by + JS 측 prefix sum | PostgreSQL / MySQL / SQLite |
| [Time-in-status](#time-in-status) | `LEAD()` window function + `dateDiff` | PostgreSQL / MySQL / SQLite |
| [Weekly lead time](#weekly-lead-time) | `dateTrunc('week', ...)` + 평균 | PostgreSQL / MySQL / SQLite |
| [Cycle-time percentile report](#cycle-time-percentile-report) | `percentile_cont` (PG) 또는 `ROW_NUMBER()` 에뮬레이션 (MySQL) | PostgreSQL 네이티브, MySQL 에뮬레이션 |
| [Recursive issue tree](#recursive-issue-tree) | `RawQueryBuilder`로 `WITH RECURSIVE` | PostgreSQL / MySQL |

## Sprint burndown

> **문제.** 스프린트의 burndown 차트를 그려요. 매일 캘린더 일자별로, 그 날 완료된 이슈 수, 누적 완료 수, 남은 estimate를 보여줘요.

전체 모양을 window function 없이 표현할 수 있어요. 단일 GROUP BY 쿼리로 일별 집계를 만들고, prefix sum은 JavaScript에서 처리해요. 핵심은 `Expressions.dateTrunc(completedAt, "day")` -- 같은 표현식이 PostgreSQL은 `DATE_TRUNC(...)`, MySQL은 `DATE(...)`, SQLite는 `date(..., 'start of day')`로 컴파일돼서 그대로 portable해요.

```typescript
import { Expressions, qAlias } from "@stingerloom/orm";

const i = qAlias(Issue, "i");

// 1. 스프린트 총 estimate -- 단일 scalar.
const totalRow = await em
  .createQueryBuilder(Issue, "i")
  .select([
    Expressions.coalesce(Expressions.sum(i.estimate), 0).as("totalEstimate"),
  ])
  .where(i.sprintId.eq(sprintId))
  .andWhere(i.deletedAt.isNull())
  .getRawOne();
const totalEstimate = Number(totalRow?.totalEstimate ?? 0);

// 2. 완료된 이슈에 대한 일별 집계.
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

// 3. JS에서 누적합 처리 (스프린트 윈도우가 짧으니 prefix sum을 애플리케이션에서
//    처리하면 SQL에서 window-over-CTE 배관이 빠져 깔끔해져요).
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

**컴파일된 SQL (PostgreSQL):**
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

MySQL은 `DATE(...)`와 백틱을 쓰고, SQLite는 `date(...)`를 써요. Expressions DSL이 dialect별로 알맞은 형태를 골라요.

## Time-in-status

> **문제.** 이슈의 상태 timeline을 만들어요. 상태 전환마다 한 행씩, 다음 변경 전까지 그 상태에 머문 시간을 hour 단위로 표시해요.

소스 데이터는 `activity_log` 테이블이에요 -- 각 행이 상태 변경을 기록해요 (`statusFrom` / `statusTo`는 audit subscriber가 채우는 정규화된 컬럼). 한 행의 머무름 시간은 `next_row.created_at - this_row.created_at`이에요. "파티션 내 다음 행"에 가장 자연스러운 window function이 `LEAD()`이고, `dateDiff`가 portable한 초 단위 interval을 만들어요.

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

`.floatValue().div(3600)`로 모든 dialect에서 나눗셈이 부동소수로 유지돼요 (PostgreSQL은 그냥 두면 정수 나눗셈으로 잘려요).

**컴파일된 SQL (PostgreSQL):**
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

`LEAD()`는 세 dialect 모두 지원하고, `dateDiff` 렌더링만 다이얼렉트별로 달라져요.

## Weekly lead time

> **문제.** 프로젝트의 주별 평균 lead time (`createdAt`부터 `completedAt`까지의 시간, hour 단위)을 최근 `windowDays` 동안의 데이터로 그려요.

`Expressions.dateTrunc(completedAt, "week")`는 dialect별로 ISO 월요일 시작 주를 만들어요 -- PostgreSQL `date_trunc('week', ...)`, MySQL `DATE_SUB(... INTERVAL WEEKDAY(...) DAY)`, SQLite `date(..., '-N days')`. 집계는 derived scalar에 대한 단순 `AVG()`예요.

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

**컴파일된 SQL (PostgreSQL):**
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

> **문제.** 최근 윈도우의 이슈 cycle time (`createdAt` ~ `completedAt`의 hour 단위 차)에 대해 P50 / P75 / P95를 계산해요.

이 레시피는 **dialect 지원 매트릭스**가 결정적인 교과서적 케이스예요:

- **PostgreSQL**은 SQL 표준 ordered-set aggregate `percentile_cont(p) WITHIN GROUP (ORDER BY x)`가 있어요. `Expressions.percentileCont(...)`가 이를 그대로 렌더링하므로 전체 쿼리가 `SelectQueryBuilder` 안에 머물러요.
- **MySQL**은 네이티브 ordered-set aggregate가 없어요. 표준 에뮬레이션은 쿼리 전체를 재작성해요 -- CTE가 `ROW_NUMBER() OVER (ORDER BY x)`를 cycle-time마다 붙이고, 외부 쿼리가 `rn = CEIL(N * p)`인 행을 골라요. 이건 다른 표현식이 아니라 쿼리 전체를 다시 짜야 하므로, DSL aggregate가 MySQL에서 `OrmError(UNSUPPORTED_OPERATION)`을 던지며 에뮬레이션 패턴을 안내해요.

### Dialect 분기

```typescript
if (em.getDriver() instanceof SqliteDriver) {
  throw new NotImplementedException(
    "cycleTimePercentiles는 PostgreSQL과 MySQL에서만 사용 가능해요.",
  );
}
const isPg = detectDialect(em) === "postgres";
return isPg
  ? cycleTimePercentilesPg(projectId, windowDays)
  : cycleTimePercentilesMySqlEmulation(projectId, windowDays);
```

### PostgreSQL -- 네이티브 ordered-set aggregate

순수 DSL: `Expressions.percentileCont`로 세 percentile을 한 쿼리에 projection해요.

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

이렇게 렌더링돼요:

```sql
SELECT
  PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY CAST(EXTRACT(EPOCH FROM (…)) AS DOUBLE PRECISION) / 3600) AS "p50",
  PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY …)                                                       AS "p75",
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY …)                                                       AS "p95",
  COUNT("i"."id") AS "sampleSize"
FROM "issue" AS "i"
WHERE "i"."project_id" = $1 …;
```

### MySQL -- `ROW_NUMBER()` 에뮬레이션

CTE는 완전히 타입화되어 있어요 -- projection, `ROW_NUMBER` 정렬, sample size를 위한 `COUNT(*) OVER ()` 모두 쿼리 빌더에서 나와요. percentile 행을 픽하는 부분만 raw로 남아요 (`MAX(CASE WHEN rn = CEIL(total * p) …)` 모양에는 DSL 헬퍼가 없어요).

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

이런 모양인 이유: `COUNT(*) OVER ()`로 `total`을 CTE 안에 묶어 들고 다니면 외부 쿼리가 `cycles`를 바로 읽을 수 있어요 -- FROM 서브쿼리 없이 끝나요. `cycles` 행은 CTE가 비어 있지 않을 때만 존재하므로 `total >= 1`이고 `CEIL(total * p) >= 1`이에요 -- floor가 필요 없어요.

## Recursive issue tree

> **문제.** 루트 이슈가 주어졌을 때 `parent_id` 체인을 따라 내려가서 전체 하위 이슈 트리를 반환해요. UI가 트리를 그릴 수 있게 depth와 `1/2/3` 스타일 path도 함께 줘요.

`RawQueryBuilder.withRecursive(...)`가 시작 `WITH RECURSIVE …` 절을 써 줘요 -- 우리는 UNION-ALL 본문만 제공해요. `em.ref(Issue, "r")` / `em.ref(Issue, "c")`로 양쪽 arm을 엔티티 인지 상태로 유지하고, `em.aliasRef("t")`로 CTE 전용 `depth` / `path` 컬럼을 참조해요.

```typescript
import sql, { raw } from "sql-template-tag";
import { RawQueryBuilder, Sql } from "@stingerloom/orm";

const dialect = detectDialect(em);          // "postgres" | "mysql"
const isMySql = dialect === "mysql";

// MySQL은 anchor에서 recursive 컬럼 타입을 고정시키므로 `maxDepth` 만큼의 zero-padded
// 세그먼트를 담을 명시적 너비가 필요해요. PG는 anchor에서 TEXT를 잡아 자유롭게 늘어나요.
const castText = isMySql ? "VARCHAR(4000)" : "TEXT";

const r = em.ref(Issue, "r");
const c = em.ref(Issue, "c");
const t = em.aliasRef("t");
const Q = (name: string) => raw(em.wrap(name));

// LPAD로 zero-padded된 `path` 세그먼트가 있으면 ORDER BY path가 id 기준 depth-first
// preorder를 만들어요 (lexicographic "10 < 2" 문제 해결).
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

JS에서 LPAD 0을 떼서 사람이 읽기 좋은 `1/2/3` path로 만들어요. 정렬은 DB에서 padded form 기준으로 이미 끝났으니 unpad 단계에서 다시 정렬할 필요는 없어요.

**같은 엔티티에 ref 두 개를 쓰는 이유.** `r`은 anchor 행(루트 이슈), `c`는 recursive step(CTE에 다시 조인되는 자식 행)이에요. 동일 `Issue`에 다른 alias를 준 두 ref를 쓰면 양쪽 arm 모두 충돌 없이 타입 인지 상태를 유지해요 -- `em.ref(Entity, alias)`가 정확히 이 패턴을 위해 설계됐어요.

**SQLite 노트.** SQLite도 `WITH RECURSIVE`를 지원해요. 예제는 2-way `mysql` / `postgres` 스위치를 쓰지만, SQLite 분기를 추가하는 건 dialect 감지에 한 줄 더 늘리는 정도이고 쿼리 모양은 그대로 유지돼요.

## 다음 단계

- [Raw SQL & CTE](./raw-sql.md) -- 모든 레시피가 사용하는 빌딩 블록 (`em.ref()`, `em.aliasRef()`, `RawQueryBuilder`).
- [Query Builder QueryDSL](./query-builder-querydsl.md) -- `Expressions.*` 레퍼런스, ordered-set aggregate와 window function 포함.
- [`nestjs-linear-clone` 예제](https://github.com/biud436/stingerloom-orm/tree/main/examples/nestjs-linear-clone) -- 이 레시피들의 원본 실행 가능 소스. PostgreSQL과 MySQL에서 SQL을 고정하는 e2e 테스트가 있어요.
