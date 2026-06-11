# Query Builder — 집계 & 서브쿼리

GROUP BY, HAVING, 서브쿼리, DISTINCT는 `find()`가 표현력을 잃기 시작하는 지점입니다. 쿼리 빌더가 힘을 발휘하는 구간이죠. 이 페이지는 그 전부를 MySQL / PostgreSQL / SQLite에서 똑같이 동작하는 예제로 풀어봅니다.

## GROUP BY와 집계

카테고리별 게시글 수를 세고, **게시글이 5개 이상인 카테고리만 남긴다**고 해 봅시다. 요구 하나에 GROUP BY와 집계 함수와 HAVING이 전부 들어와요. 여기서 `qAlias()`가 특히 빛을 발합니다 — 같은 집계 표현식을 SELECT와 HAVING에 한 번씩만 적으면 되거든요.

```typescript
import { qAlias } from "@stingerloom/orm";

const p = qAlias(Post, "p");
const count = p.id.count();                // 한 번 정의

const stats = await em
  .createQueryBuilder(Post, "p")
  .select(["category"])
  .addSelect(count.as("postCount"))         // SELECT에 투영
  .groupBy(["p.category"])
  .having(count.gte(5))                     // HAVING에 재사용
  .addOrderBy(count.desc())                 // 정렬에도 재사용
  .getRawMany();
// [{ category: "tech", postCount: 42 }, { category: "life", postCount: 17 }, ...]
```

같은 쿼리를 raw `sql` 템플릿으로 쓴다면 어떨까요? `COUNT(*)`를 세 번 적게 됩니다.

```typescript
import sql from "sql-template-tag";

await em.createQueryBuilder(Post, "p")
  .select(["category"])
  .addSelect(sql`COUNT(*)`, "postCount")
  .groupBy(["p.category"])
  .having(sql`COUNT(*) >= ${5}`)            // ← 반복
  .appendSql(sql`ORDER BY "postCount" DESC`)
  .getRawMany();
```

`addOrderBy("postCount", "DESC")`는 키를 FROM 별칭으로 한정해서 `"p"."postCount"`가 됩니다. SELECT 리스트에만 존재하는 별칭이라 DB가 거부하죠. SELECT 별칭으로 정렬하려면 `appendSql(sql\`ORDER BY "alias" ...\`)`로 한 단계 내려갑니다 — 별칭이 그대로 살아남습니다.

둘 다 지원하긴 합니다. 다만 동일한 집계를 여러 자리에서 쓴다면 `qAlias()` 쪽이 유리해요. 기준을 바꿀 때 한 군데만 고치면 되니까요. `.count()`, `.sum()`, `.avg()`, `.min()`, `.max()`, `.countDistinct()` 전부 같은 방식으로 쓰고, 전체 연산자는 [QueryDSL 집계](./query-builder-querydsl.md#집계-count-sum-avg-min-max)에 정리돼 있습니다.

### SELECT에서 집계 함수 바로 쓰기

`addSelect()`에 `sql` 템플릿 리터럴을 넘기면 집계 컬럼을 추가할 수 있습니다. 두 번째 인자 별칭이 결과 객체의 키가 돼요.

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

그룹화된 엔티티 컬럼과 집계 컬럼을 함께 쓸 수도 있습니다.

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

엔티티 인식 조인까지 얹으면 테이블을 넘나드는 집계도 자연스럽게 됩니다.

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

### 표현식 빌더 addSelect()

`addSelect()`는 콜백도 받습니다. 콜백은 `@ComputedColumn({ expression })`과 동일한, 다이얼렉트 이식성이 보장되는 `e` 컨텍스트를 받아요 — `e.col("alias.prop")`, `e.iff(...)`, `e.count()` / `e.sum()` / `e.avg()` / `e.min()` / `e.max()`, 그리고 `ScalarExpression`의 전체 산술 체인(`add` / `sub` / `mul` / `div` / `floor` / …)까지. raw SQL 없이도 어느 다이얼렉트에서든 올바른 SQL이 렌더링됩니다.

```typescript
// COUNT(node.name) - 1 AS depth — raw SQL 없는 중첩 집합 깊이 계산
qb.addSelect((e) => e.count("node.name").sub(1), "depth");

// (c.rgt - (c.lft + 1)) / 2 AS children
qb.addSelect(
  (e) => e.col("c.rgt").sub(e.col("c.lft").add(1)).div(2).floor(),
  "children",
);
```

스칼라 결과는 별칭 인자가 **필수**입니다 — `addSelect((e) => ..., "alias")` — 없으면 `INVALID_QUERY`를 던져요. 집계는 별칭 인자를 쓰거나 `.as("alias")`로 마무리하면 됩니다.

이 조합이 가능한 건 `AggregateExpression`이 산술을 직접 지원하게 됐기 때문입니다. `.toScalar()`가 집계를 `ScalarExpression`으로 이어 주고, `.add()` / `.sub()` / `.mul()` / `.div()`는 `.toScalar().add(...)`의 단축형이에요. 같은 표면이 `qAlias()` 집계에도 열려 있으니 `p.id.count().sub(1)`도 그대로 동작합니다.

## 서브쿼리

쿼리 빌더는 WHERE, SELECT, FROM 어느 자리에든 서브쿼리를 넣을 수 있습니다. `find()`로는 불가능한 영역이지만, 빌더에서는 간단해요.

### WHERE IN 서브쿼리

타입드 단축은 `whereInSubquery(column, subBuilder)`입니다 — [패턴 & 생산성](./query-builder-patterns.md#whereinsubquery--wherenotinsubquery)에서 사용 예제를 확인하세요. 서브쿼리가 `SelectQueryBuilder`로 표현되지 않을 때(예: raw 소스에서 이미 `Sql` 조각을 받은 경우)에만 `Conditions.inSubquery()`로 내려갑니다.

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

상관 서브쿼리에는 `Conditions.exists()` 또는 `Conditions.notExists()`를 씁니다.

```typescript
// 발행된 게시글이 한 편이라도 있는 작성자 찾기
const authors = await em
  .createQueryBuilder(User, "a")
  .where(Conditions.exists(sql`(SELECT 1 FROM "post" "p" WHERE "p"."author_id" = "a"."id" AND "p"."status" = ${"published"})`))
  .getMany();
```

### SELECT 절의 스칼라 서브쿼리

`addSelect()`로 계산 컬럼처럼 스칼라 서브쿼리를 얹을 수 있습니다.

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

`asSubquery()`로 `SelectQueryBuilder`를 파생 테이블로 바꾸고, `RawQueryBuilder`에서 이 파생 테이블을 쿼리합니다.

```typescript
// 1단계: 안쪽 쿼리
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
    .from(inner.asSubquery("sub"))
    .where([sql`"sub"."cnt" >= ${3}`])
    .build()
);
// 게시글 3편 이상인 작성자
```

### CTE (공통 테이블 표현식)

복잡한 다단계 쿼리에는 `RawQueryBuilder`의 CTE를 씁니다.

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

재귀 CTE — 댓글 스레드나 조직도 같은 계층 데이터 — 가 필요하면 [Raw SQL & CTE](./raw-sql.md)를 참고하세요.

### `SelectQueryBuilder`를 안는 상위 헬퍼

서브쿼리 자체가 `SelectQueryBuilder`라면 타입드 헬퍼 쪽이 편합니다. 파라미터 바인딩이 그대로 유지되고, 안쪽 쿼리에도 자동완성이 돼요.

- `whereInSubquery(column, subQb)` / `whereNotInSubquery(...)`
- `whereExistsSubquery(subQb)` / `whereNotExistsSubquery(...)`
- `addSelectSubquery(subQb, alias)`

전체 세트는 [편의 패턴](./query-builder-patterns.md#subquery-통합)에서 다룹니다.

## DISTINCT

중복 없는 행만 받고 싶을 때는 DISTINCT를 활성화합니다.

```typescript
const uniqueCities = await em
  .createQueryBuilder(User, "u")
  .select(["city"])
  .setDistinct()
  .getPartialMany();
// SELECT DISTINCT "u"."city" FROM "user" AS "u"
```

결과 집합에서 중복 행을 제거합니다. 선택한 컬럼의 조합이 겹치는 행이 많을 때 유용해요.

집계 **내부** DISTINCT — `COUNT(DISTINCT col)` — 가 필요하면 `.count()` 대신 `.countDistinct()`를 씁니다. 두 DISTINCT는 의미가 다릅니다. 행 수준 DISTINCT는 결과 행 수 자체를 줄이고, 집계 내부 DISTINCT는 집계 대상 값의 중복만 제거합니다.

`DISTINCT ON` (PostgreSQL 전용)은 [Raw SQL & CTE](./raw-sql.md)에서 다룹니다.

## GROUP BY로는 부족할 때 — 윈도우 집계

GROUP BY는 그룹마다 행을 하나로 눌러 버립니다. "개별 행은 그대로 두면서 팀별 누적 합계를 같이 보여달라"처럼 **원본 행을 유지한 채 집계만 얹어야 하는 경우**에는 GROUP BY가 답이 되지 못해요. 이럴 때 등장하는 게 윈도우 함수입니다.

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

표현식을 `.toScalar()`로 마무리하면 WHERE / HAVING 안에 서브쿼리처럼 꽂을 수도 있습니다. API 전체와 리더보드 실전 예제는 [QueryDSL → 윈도우 함수](./query-builder-querydsl.md#윈도우-함수-aggregateover-windowbuilder)에서 이어서 볼 수 있어요.

## 다음 단계

- [QueryDSL 표현식](./query-builder-querydsl.md) — 타입드 집계 / 윈도우 / CASE / 날짜 컴포넌트
- [편의 패턴 → 서브쿼리 통합](./query-builder-patterns.md#subquery-통합) — 타입드 `whereInSubquery` / `whereExistsSubquery` / `addSelectSubquery`, `whereHas` / `withCount`
- [Raw SQL & CTE](./raw-sql.md) — UNION, 재귀 CTE
- [Query Builder 개요](./query-builder.md) — 기본 사용법과 전체 지도
