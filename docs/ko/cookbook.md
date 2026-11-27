# 분석 쿼리 Cookbook

ORM의 Expressions DSL, 윈도 함수, `date_trunc`, ordered-set aggregate, 재귀 CTE로 만든 실전 분석 쿼리 레시피입니다. 모든 레시피는 [`nestjs-linear-clone` 분석 서비스](https://github.com/biud436/stingerloom-orm/blob/main/examples/nestjs-linear-clone/src/modules/analytics/analytics.service.ts)에서 그대로 가져왔습니다. 그래서 각 레시피는 예제의 e2e 테스트로 검증되고 코드베이스와 항상 동기화됩니다.

아직 [Raw SQL & CTE](./raw-sql.md) 페이지를 읽지 않았다면 먼저 읽어 보세요. 그 페이지에서 소개하는 `em.ref()` / `em.aliasRef()` / `RawQueryBuilder`가 모든 레시피의 기본 구성 요소입니다.

## 한눈에 보기

| 레시피 | 패턴 | 다이얼렉트 지원 |
|--------|------|-------------|
| [Sprint burndown](#sprint-burndown) | `date_trunc` + GROUP BY + JS 쪽 누적 합 | PostgreSQL / MySQL / SQLite |
| [Time-in-status](#time-in-status) | `LEAD()` 윈도 함수 + `dateDiff` | PostgreSQL / MySQL / SQLite |
| [Weekly lead time](#weekly-lead-time) | `dateTrunc('week', ...)` + 평균 | PostgreSQL / MySQL / SQLite |
| [Cycle-time percentile report](#cycle-time-percentile-report) | `percentile_cont` (PG) 또는 `ROW_NUMBER()` 에뮬레이션 (MySQL) | PostgreSQL 네이티브, MySQL 에뮬레이션 |
| [Recursive issue tree](#recursive-issue-tree) | `RawQueryBuilder`로 `WITH RECURSIVE` | PostgreSQL / MySQL |

## Sprint burndown

> 문제: 스프린트의 burndown 차트를 그립니다. 날짜마다 그날 완료된 이슈 수, 누적 완료 수, 남은 estimate를 보여 줍니다.

이 쿼리는 윈도 함수 없이 표현할 수 있습니다. GROUP BY 쿼리 하나로 일별 집계를 만들고 누적 합은 그 뒤에 JavaScript에서 계산합니다. 핵심은 `Expressions.dateTrunc(completedAt, "day")`입니다. 같은 표현식이 PostgreSQL에서는 `DATE_TRUNC(...)`, MySQL에서는 `DATE(...)`, SQLite에서는 `date(..., 'start of day')`로 컴파일됩니다. 그래서 쿼리를 쓴 그대로 여러 데이터베이스에서 동작합니다.

```typescript
import { Expressions, qAlias } from "@stingerloom/orm";

const i = qAlias(Issue, "i");

// 1. 스프린트 총 estimate: 스칼라 값 하나
const totalRow = await em
  .createQueryBuilder(Issue, "i")
  .select([
    Expressions.coalesce(Expressions.sum(i.estimate), 0).as("totalEstimate"),
  ])
  .where(i.sprintId.eq(sprintId))
  .andWhere(i.deletedAt.isNull())
  .getRawOne();
const totalEstimate = Number(totalRow?.totalEstimate ?? 0);

// 2. 완료된 이슈의 일별 집계
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

// 3. 누적 합은 JS에서 계산합니다. 스프린트 기간이 짧으므로 애플리케이션에서
//    계산하면 SQL에서 CTE 위에 윈도 함수를 얹지 않아도 되어 깔끔합니다.
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

MySQL에서는 `DATE(...)`와 백틱 인용을 쓰고 SQLite에서는 `date(...)`를 씁니다. Expressions DSL이 다이얼렉트마다 알맞은 형태를 고릅니다.

## Time-in-status

> 문제: 이슈의 상태 타임라인을 만듭니다. 상태 전환마다 한 행씩 만들고 다음 변경 전까지 그 상태에 머문 시간을 시간 단위로 표시합니다.

소스 데이터는 `activity_log` 테이블입니다. 이 테이블의 각 행은 상태 변경 하나를 기록합니다. `statusFrom` / `statusTo`는 감사 구독자가 채우는 비정규화 컬럼이고 타입이 정해져 있습니다. 한 행이 그 상태에 머문 시간은 `next_row.created_at - this_row.created_at`입니다. "파티션 안의 다음 행"을 구하는 데 가장 자연스러운 윈도 함수는 `LEAD()`입니다. 그리고 `dateDiff`는 어느 다이얼렉트에서든 동작하는 초 단위 간격을 만듭니다.

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

`.floatValue().div(3600)`을 쓰면 모든 다이얼렉트에서 나눗셈 결과가 부동소수점으로 유지됩니다. 이렇게 하지 않으면 PostgreSQL에서는 정수 나눗셈이 되어 소수점 아래가 잘립니다.

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

`LEAD()`는 지원하는 세 다이얼렉트에서 모두 동작합니다. 다이얼렉트마다 달라지는 것은 `dateDiff` 렌더링뿐입니다.

## Weekly lead time

> 문제: 프로젝트의 주별 평균 lead time을 최근 `windowDays`일 동안의 데이터로 그립니다. lead time은 `createdAt`부터 `completedAt`까지 걸린 시간이고 시간 단위로 셉니다.

`Expressions.dateTrunc(completedAt, "week")`는 모든 다이얼렉트에서 ISO 기준으로 월요일에 시작하는 주를 만듭니다. PostgreSQL에서는 `date_trunc('week', ...)`, MySQL에서는 `DATE_SUB(... INTERVAL WEEKDAY(...) DAY)`, SQLite에서는 `date(..., '-N days')`가 됩니다. 집계는 계산으로 얻은 스칼라 값에 단순히 `AVG()`를 적용합니다.

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

> 문제: 최근 윈도에 속한 이슈의 cycle time에서 P50 / P75 / P95를 계산합니다. cycle time은 `createdAt`과 `completedAt`의 차이를 시간 단위로 잰 값입니다.

이 레시피는 다이얼렉트별 지원 차이가 중요해지는 대표적인 사례입니다.

- **PostgreSQL**에는 SQL 표준 ordered-set aggregate인 `percentile_cont(p) WITHIN GROUP (ORDER BY x)`가 있습니다. `Expressions.percentileCont(...)`가 이 함수를 그대로 렌더링합니다. 그래서 쿼리 전체가 `SelectQueryBuilder` 안에서 끝납니다.
- **MySQL**에는 네이티브 ordered-set aggregate가 없습니다. 표준 에뮬레이션은 쿼리 자체를 다시 작성합니다. CTE가 cycle time마다 `ROW_NUMBER() OVER (ORDER BY x)`를 붙이고 바깥 쿼리가 `rn = CEIL(N * p)`인 행을 고릅니다. 표현식 하나만 바꾸는 것이 아니라 쿼리 전체를 다시 짜야 합니다. 그래서 MySQL에서 DSL aggregate는 `OrmError(UNSUPPORTED_OPERATION)`을 던지고 에뮬레이션 패턴을 안내합니다.

### Dialect 분기

```typescript
if (em.getDriver() instanceof SqliteDriver) {
  throw new NotImplementedException(
    "cycleTimePercentiles는 PostgreSQL과 MySQL에서만 사용할 수 있습니다.",
  );
}
const isPg = detectDialect(em) === "postgres";
return isPg
  ? cycleTimePercentilesPg(projectId, windowDays)
  : cycleTimePercentilesMySqlEmulation(projectId, windowDays);
```

### PostgreSQL -- 네이티브 ordered-set aggregate

DSL만으로 작성합니다. `Expressions.percentileCont`로 백분위수 세 개를 쿼리 하나에서 투영합니다.

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

렌더링 결과는 다음과 같습니다.

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

CTE는 전부 타입 있는 코드로 작성합니다. 투영, `ROW_NUMBER` 정렬, 표본 크기를 구하는 `COUNT(*) OVER ()`가 모두 쿼리 빌더에서 나옵니다. 백분위수에 해당하는 행을 고르는 부분만 raw SQL로 남습니다. `MAX(CASE WHEN rn = CEIL(total * p) …)` 형태를 만드는 DSL 헬퍼는 없기 때문입니다.

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

쿼리를 이렇게 짠 데는 이유가 있습니다. `COUNT(*) OVER ()`로 `total`을 CTE 안에 함께 담아 두면 바깥 쿼리가 FROM 서브쿼리 없이 `cycles`를 바로 읽을 수 있습니다. 그리고 `cycles` 행은 CTE가 비어 있지 않을 때만 존재합니다. 그래서 `total >= 1`이고 `CEIL(total * p) >= 1`입니다. 따로 하한을 둘 필요가 없습니다.

## Recursive issue tree

> 문제: 루트 이슈가 주어지면 `parent_id` 체인을 따라 내려가서 하위 이슈 트리 전체를 반환합니다. UI가 트리를 그릴 수 있도록 깊이와 `1/2/3` 형태의 경로도 함께 반환합니다.

`RawQueryBuilder.withRecursive(...)`가 맨 앞의 `WITH RECURSIVE …` 절을 만듭니다. 직접 작성할 부분은 UNION ALL 본문뿐입니다. `em.ref(Issue, "r")` / `em.ref(Issue, "c")`를 쓰면 UNION ALL의 양쪽 쿼리가 모두 엔티티 메타데이터를 인식합니다. 그리고 `em.aliasRef("t")`로 CTE에만 있는 `depth` / `path` 컬럼을 참조합니다.

```typescript
import sql, { raw } from "sql-template-tag";
import { RawQueryBuilder, Sql } from "@stingerloom/orm";

const dialect = detectDialect(em);          // "postgres" | "mysql"
const isMySql = dialect === "mysql";

// MySQL은 anchor에서 재귀 컬럼의 타입을 고정합니다. 그래서 0을 채운 세그먼트를 `maxDepth`개만큼
// 담을 너비를 명시해야 합니다. PostgreSQL은 anchor에서 TEXT로 정해지므로 길이가 자유롭게 늘어납니다.
const castText = isMySql ? "VARCHAR(4000)" : "TEXT";

const r = em.ref(Issue, "r");
const c = em.ref(Issue, "c");
const t = em.aliasRef("t");
const Q = (name: string) => raw(em.wrap(name));

// `path` 세그먼트에 LPAD로 0을 채워 두면 ORDER BY path가 id 기준 깊이 우선 전위 순서가 됩니다.
// 문자열 비교에서 "10 < 2"가 되는 문제도 해결됩니다.
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

JS에서 LPAD로 채운 0을 떼어 내면 사람이 읽기 좋은 `1/2/3` 경로가 됩니다. 정렬은 데이터베이스에서 0을 채운 형태를 기준으로 이미 끝났습니다. 그래서 0을 떼어 낸 뒤 다시 정렬할 필요는 없습니다.

같은 엔티티에 ref를 두 개 쓰는 데는 이유가 있습니다. `r`은 anchor 행인 루트 이슈입니다. `c`는 재귀 단계의 행으로 CTE에 다시 조인되는 자식 행입니다. 같은 `Issue`에 별칭을 다르게 준 ref 두 개를 쓰면 UNION ALL의 양쪽 쿼리가 충돌 없이 타입 정보를 유지합니다. `em.ref(Entity, alias)`는 바로 이 패턴을 위해 설계됐습니다.

SQLite도 `WITH RECURSIVE`를 지원합니다. 예제는 `mysql`과 `postgres` 두 갈래로만 분기합니다. 하지만 SQLite 분기를 추가할 때는 다이얼렉트 감지 코드만 조금 고치면 됩니다. 쿼리 형태는 바뀌지 않습니다.

## 다음 단계

- [Raw SQL & CTE](./raw-sql.md): 모든 레시피가 사용하는 기본 구성 요소인 `em.ref()`, `em.aliasRef()`, `RawQueryBuilder`
- [Query Builder QueryDSL](./query-builder-querydsl.md): ordered-set aggregate와 윈도 함수를 포함한 `Expressions.*` 레퍼런스
- [`nestjs-linear-clone` 예제](https://github.com/biud436/stingerloom-orm/tree/main/examples/nestjs-linear-clone): 이 레시피들을 가져온 실행 가능한 원본 소스입니다. PostgreSQL과 MySQL에서 생성되는 SQL을 검증하는 e2e 테스트가 있습니다.
