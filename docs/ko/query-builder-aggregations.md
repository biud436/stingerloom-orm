# Query Builder — 집계 & 서브쿼리

GROUP BY, HAVING, 서브쿼리, DISTINCT는 `find()`가 표현하기 힘들어지는
지점이에요. 이 페이지는 그 전체 세트를 MySQL / PostgreSQL / SQLite 모두
호환되는 예제로 정리해요.

## GROUP BY와 집계

카테고리별 게시글 수를 세고, **게시글 5개 이상인 카테고리만 남기고 싶다**고 해볼게요. 이 요구 하나에 GROUP BY, 집계 함수, HAVING이 모두 들어와요. `qAlias()`로 쓰면 같은 집계 표현식을 SELECT와 HAVING에 한 번씩만 적으면 됩니다.

```typescript
import { qAlias } from "@stingerloom/orm";

const p = qAlias(Post, "p");
const count = p.id.count();                 // 한 번 정의

const stats = await em
  .createQueryBuilder(Post, "p")
  .select(["category"])
  .addSelect(count.as("postCount"))          // SELECT 에 투영
  .groupBy(["p.category"])
  .having(count.gte(5))                      // HAVING 에 재사용
  .addOrderBy(count.desc())                  // 같은 표현식으로 정렬까지
  .getRawMany();
// [{ category: "tech", postCount: 42 }, { category: "life", postCount: 17 }, ...]
```

**같은 쿼리를 raw `sql` 템플릿으로 쓰는 것과 비교해 보세요** — COUNT(*)를 세 번 적게 돼요.

```typescript
import sql from "sql-template-tag";

await em.createQueryBuilder(Post, "p")
  .select(["category"])
  .addSelect(sql`COUNT(*)`, "postCount")
  .groupBy(["p.category"])
  .having(sql`COUNT(*) >= ${5}`)             // ← 반복
  .addOrderBy("postCount", "DESC")
  .getRawMany();
```

두 형태 모두 지원하지만, **동일 집계를 여러 곳에서 쓴다면 QueryDSL 쪽이 한 군데만 고치면 돼서 리포트성 쿼리에 유리해요.** `.count() / .sum() / .avg() / .min() / .max() / .countDistinct()` 모두 같은 방식으로 쓰고, 전체 연산자 표는 [QueryDSL 집계](./query-builder-querydsl.md#집계-count-sum-avg-min-max)에 있어요.

### SELECT에서 집계 함수 사용하기

`addSelect()`에 `sql` 템플릿 리터럴을 전달하면 집계 컬럼을 추가할 수 있어요. alias가 결과 객체의 키가 돼요.

```typescript
import sql from "sql-template-tag";

const stats = await em
  .createQueryBuilder(Order, "o")
  .addSelect(sql`AVG("o"."price")`, "avgPrice")
  .addSelect(sql`SUM("o"."price")`, "totalRevenue")
  .addSelect(sql`MIN("o"."price")`, "cheapest")
  .addSelect(sql`MAX("o"."price")`, "mostExpensive")
  .addSelect(sql`COUNT(*)`, "orderCount")
  .getRawMany();
// [{ avgPrice: 42.5, totalRevenue: 850, cheapest: 10, mostExpensive: 99, orderCount: 20 }]
```

그룹화된 엔티티 컬럼과 집계 컬럼을 함께 쓸 수도 있어요:

```typescript
const salesByCategory = await em
  .createQueryBuilder(Product, "p")
  .select(["category"])
  .addSelect(sql`AVG("p"."price")`, "avgPrice")
  .addSelect(sql`COUNT(*)`, "productCount")
  .groupBy(["category"])
  .having(sql`AVG("p"."price") > ${50}`)
  .orderBy({ category: "ASC" })
  .getRawMany();
// [{ category: "electronics", avgPrice: 299.99, productCount: 15 }, ...]
```

엔티티 인식 조인과 함께 사용하면 관련 테이블을 넘나드는 집계도 가능해요:

```typescript
const p = qAlias(Post, "p");
const u = qAlias(User, "u");
const postCount = p.id.count();
const avgLikes = p.likeCount.avg();

const authorStats = await em
  .createQueryBuilder(Post, "p")
  .leftJoin(User, "u", (join) => join.on(p.col("authorId"), "=", u.col("id")))
  .selectRaw([u.col("name")])
  .addSelect(postCount.as("postCount"))
  .addSelect(avgLikes.as("avgLikes"))
  .groupBy([u.col("name")])
  .having(postCount.gte(3))
  .addOrderBy(postCount.desc())
  .getRawMany();
// [{ name: "Alice", postCount: 12, avgLikes: 45.3 }, ...]
```

## 서브쿼리

Query builder는 WHERE, SELECT, FROM 절에서 서브쿼리를 지원해요. `find()`로는 서브쿼리를 표현할 수 없지만, query builder에서는 간단해요.

### WHERE IN 서브쿼리

`Conditions.inSubquery()`를 사용하거나 다른 query builder에서 빌드한 `Sql` 객체를 전달해요:

```typescript
import sql from "sql-template-tag";
import { Conditions } from "@stingerloom/orm";

// 한국 작성자의 게시글 찾기
const subquery = em
  .createQueryBuilder(User, "u")
  .select(["id"])
  .where("country", "KR")
  .toSql();

const posts = await em
  .createQueryBuilder(Post, "p")
  .where(Conditions.inSubquery(`"p"."authorId"`, sql`(${subquery})`))
  .getMany();
```

### WHERE EXISTS / NOT EXISTS

상관 서브쿼리에는 `Conditions.exists()` 또는 `Conditions.notExists()`를 사용해요:

```typescript
// 발행된 게시글이 하나 이상 있는 작성자 찾기
const authors = await em
  .createQueryBuilder(User, "a")
  .where(Conditions.exists(sql`(SELECT 1 FROM "post" "p" WHERE "p"."author_id" = "a"."id" AND "p"."status" = ${"published"})`))
  .getMany();
```

### SELECT 절 스칼라 서브쿼리

`addSelect()`로 계산 컬럼으로서 스칼라 서브쿼리를 추가할 수 있어요:

```typescript
const authors = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name"])
  .addSelect(
    sql`(SELECT COUNT(*) FROM "post" "p" WHERE "p"."author_id" = "u"."id")`,
    "postCount",
  )
  .getRawMany();
// [{ id: 1, name: "Alice", postCount: 5 }, { id: 2, name: "Bob", postCount: 0 }]
```

### FROM 서브쿼리 (파생 테이블)

`asSubquery()`로 SelectQueryBuilder를 파생 테이블로 변환하고, RawQueryBuilder로 쿼리해요:

```typescript
// 1단계: 내부 쿼리 빌드
const inner = em
  .createQueryBuilder(Post, "p")
  .select(["authorId"])
  .addSelect(sql`COUNT(*)`, "cnt")
  .groupBy(["authorId"]);

// 2단계: 파생 테이블로 사용
const qb = em.createQueryBuilder();
const results = await em.query(
  qb
    .select(['"sub"."authorId"', '"sub"."cnt"'])
    .from(inner.asSubquery("sub").sql)
    .where([sql`"sub"."cnt" >= ${3}`])
    .build()
);
// 게시글 3개 이상인 작성자
```

### CTE (Common Table Expressions)

복잡한 다단계 쿼리에는 RawQueryBuilder의 CTE를 사용해요:

```typescript
const qb = em.createQueryBuilder();

const results = await em.query(
  qb
    .with("active_authors", (sub) =>
      sub
        .select(['DISTINCT "authorId"'])
        .from('"post"')
        .where([sql`"status" = ${"published"}`])
    )
    .select(['"u"."id"', '"u"."name"'])
    .from('"user" "u"')
    .where([sql`"u"."id" IN (SELECT "authorId" FROM "active_authors")`])
    .build()
);
```

재귀 CTE(댓글 스레드나 조직도 같은 계층 데이터)는 [Raw SQL & CTE](./raw-sql.md) 가이드를 참고하세요.

### `SelectQueryBuilder`의 상위 헬퍼

서브쿼리 자체가 `SelectQueryBuilder`라면 타입드 헬퍼를 쓰는 게 편해요 —
파라미터 바인딩이 그대로 유지되고, 안쪽 쿼리에도 자동완성이 돼요.

- `whereInSubquery(column, subQb)` / `whereNotInSubquery(...)`
- `whereExistsSubquery(subQb)` / `whereNotExistsSubquery(...)`
- `addSelectSubquery(subQb, alias)`

전체 세트는 [편의 패턴](./query-builder-patterns.md#subquery-통합)에서
다뤄요.

## DISTINCT

중복 없는 행만 원할 때 DISTINCT를 활성화해요.

```typescript
const uniqueCities = await em
  .createQueryBuilder(User, "u")
  .select(["city"])
  .setDistinct()
  .getPartialMany();
// SELECT DISTINCT "u"."city" FROM "user" AS "u"
```

결과 집합에서 중복 행을 제거해요. 컬럼 일부만 선택할 때 같은 값을 공유하는 행이 많으면 유용해요.

집계 **내부** DISTINCT — `COUNT(DISTINCT col)` — 가 필요하면 `.count()` 대신 `.countDistinct()`를 쓰세요. 두 가지는 의미가 다릅니다: 행 수준 DISTINCT는 결과 행 수를 줄이고, 집계 내부 DISTINCT는 집계 대상 값의 중복을 제거해요.

`DISTINCT ON` (PostgreSQL 전용)은 [Raw SQL & CTE](./raw-sql.md) 가이드를 보세요.

## GROUP BY의 한계를 넘어 — 윈도우 집계

GROUP BY는 그룹마다 한 행만 남겨요. "개별 행은 그대로 두면서 팀별 누적 합계를 같이 보여달라"처럼 **원본 행을 유지한 채 집계를 붙여야 하는 경우**에는 윈도우 함수가 답이에요.

```typescript
const e = qAlias(Event, "e");

qb.select(["id", "teamId", "score"])
  .addSelect(
    e.score.sum().over()
      .partitionBy(e.teamId)
      .orderBy(e.createdAt.asc())
      .rowsBetween("UNBOUNDED PRECEDING", "CURRENT ROW")
      .as("running_total"),
  )
  .getRawMany();
```

표현식을 `.toScalar()`로 마무리하면 WHERE / HAVING 안에 서브쿼리처럼 꽂을 수도 있어요. 전체 API와 리더보드 실전 예제는 [QueryDSL → 윈도우 함수](./query-builder-querydsl.md#윈도우-함수-aggregateover-windowbuilder)에서 다뤄요.

## 다음 단계

- [QueryDSL 표현식](./query-builder-querydsl.md) — 타입드 집계 / 윈도우 함수 / CASE / 날짜 컴포넌트
- [편의 패턴 → Subquery 통합](./query-builder-patterns.md#subquery-통합) — 타입드 `whereInSubquery` / `whereExistsSubquery` / `addSelectSubquery`, `whereHas` / `withCount`
- [Raw SQL & CTE](./raw-sql.md) — UNION, 재귀 CTE
- [Query Builder 개요](./query-builder.md) — 기본 사용법과 전체 지도
