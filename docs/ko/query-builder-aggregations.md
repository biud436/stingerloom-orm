# Query Builder — 집계 & 서브쿼리

GROUP BY, HAVING, 서브쿼리, DISTINCT는 `find()`가 표현하기 힘들어지는
지점이에요. 이 페이지는 그 전체 세트를 MySQL / PostgreSQL / SQLite 모두
호환되는 예제로 정리해요.

## GROUP BY와 집계

카테고리별 게시글 수를 세고 싶다고 해볼게요. GROUP BY가 필요해요.

```typescript
import sql from "sql-template-tag";

const stats = await em
  .createQueryBuilder(Post, "p")
  .select(["category"])
  .addSelect(sql`COUNT(*)`, "postCount")
  .groupBy(["category"])
  .having(sql`COUNT(*) >= ${5}`)
  .getRawMany();
// [{ category: "tech", postCount: 42 }, { category: "life", postCount: 17 }, ...]
```

`groupBy()`는 컬럼명 배열을 받아요 (type-safe). `having()`은 집계 후 그룹을 필터링해요 — 여기서는 5개 이상의 게시글이 있는 카테고리만 남겨요.

> **참고** — `sql` 템플릿 없이도 `u.id.count()`, `.sum()`, `.avg()`,
> `.min()`, `.max()` 같은 타입드 집계가 가능해요. SELECT와 HAVING 양쪽에
> 같은 표현식을 재사용할 수 있고요. 자세한 내용은
> [QueryDSL 집계](./query-builder-querydsl.md#집계-count-sum-avg-min-max)를 보세요.

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

const authorStats = await em
  .createQueryBuilder(Post, "p")
  .leftJoin(User, "u", (join) => join.on(p.col("authorId"), "=", u.col("id")))
  .selectRaw([u.col("name")])
  .addSelect(sql`COUNT(*)`, "postCount")
  .addSelect(sql`AVG("p"."likeCount")`, "avgLikes")
  .groupBy([u.col("name")])
  .having(sql`COUNT(*) >= ${3}`)
  .addOrderBy("postCount", "DESC")
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

전체 세트는 [생산성 패턴](./query-builder-patterns.md#subquery-통합)에서
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

`DISTINCT ON` (PostgreSQL 전용)은 [Raw SQL & CTE](./raw-sql.md) 가이드를
보세요.

## 다음 단계

- [QueryDSL 표현식](./query-builder-querydsl.md) — 타입드 집계 / 윈도우 함수 / CASE / 날짜 컴포넌트
- [생산성 패턴](./query-builder-patterns.md) — `whereHas`, `withCount`, scope
- [Raw SQL & CTE](./raw-sql.md) — UNION, 재귀 CTE, 윈도우 함수
- [Query Builder 개요](./query-builder.md) — 기본 사용법과 전체 지도
