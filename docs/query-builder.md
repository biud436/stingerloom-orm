# 쿼리 빌더 (Query Builder)

`find()`나 `findOne()`으로 대부분의 조회를 처리할 수 있지만, JOIN, GROUP BY, 서브쿼리 같은 복잡한 SQL이 필요할 때가 있습니다. 이럴 때 **RawQueryBuilder**를 사용합니다.

## 언제 쿼리 빌더를 쓰나요?

| 상황 | 추천 |
|------|------|
| 단순 CRUD, WHERE 조건 | `em.find()`, `em.save()` 사용 |
| JOIN, GROUP BY, 서브쿼리 | 쿼리 빌더 사용 |
| DB 전용 함수, 복잡한 집계 | 쿼리 빌더 또는 `em.query()` 사용 |

## 기본 사용법

`RawQueryBuilderFactory.create()`로 쿼리 빌더를 만들고, 메서드를 체이닝한 다음 `build()`로 완성합니다.

```typescript
import { RawQueryBuilderFactory } from "stingerloom-orm";
import sql from "sql-template-tag";

const qb = RawQueryBuilderFactory.create();

const query = qb
  .select(["id", "name", "email"])
  .from('"users"')
  .where([sql`"is_active" = ${true}`])
  .orderBy([{ column: '"created_at"', direction: "DESC" }])
  .limit(10)
  .build();

// EntityManager로 실행
const users = await em.query(query);
```

> **Hint** 테이블명과 컬럼명은 DB에 맞게 따옴표로 감싸야 합니다. PostgreSQL은 큰따옴표(`"`), MySQL은 백틱(`` ` ``)을 사용합니다.

## SELECT

```typescript
// 특정 컬럼
qb.select(['"id"', '"name"', '"email"']);

// 전체 컬럼
qb.select("*");

// 별칭(alias)
qb.select(['"u"."id"', '"u"."name" AS "userName"']);
```

## FROM

```typescript
// 기본
qb.from('"users"');

// 별칭 지정
qb.from('"users"', "u");
```

## WHERE 조건

`where()`는 `sql-template-tag`의 템플릿 리터럴을 사용하여 안전하게 값을 바인딩합니다.

```typescript
import sql from "sql-template-tag";

// 기본 WHERE (여러 조건은 AND로 연결)
qb.where([
  sql`"is_active" = ${true}`,
  sql`"age" >= ${18}`,
]);
// WHERE "is_active" = $1 AND "age" >= $2

// 빈 배열이면 WHERE 1=1 (이후 조건 추가 가능)
qb.where([]);

// AND / OR 추가
qb.where([sql`"type" = ${"admin"}`])
  .andWhere(sql`"age" < ${60}`)
  .orWhere(sql`"type" = ${"superadmin"}`);
```

### IN / NOT IN

```typescript
qb.where([])
  .whereIn('"status"', ["active", "pending"]);
// WHERE 1=1 AND "status" IN ($1, $2)

qb.where([])
  .whereNotIn('"id"', [1, 2, 3]);
```

### NULL 체크

```typescript
qb.where([])
  .whereNull('"deleted_at"');
// WHERE 1=1 AND "deleted_at" IS NULL

qb.where([])
  .whereNotNull('"email"');
```

### BETWEEN

```typescript
qb.where([])
  .whereBetween('"age"', 18, 65);
// WHERE 1=1 AND "age" BETWEEN $1 AND $2
```

## JOIN

테이블을 조인할 때 사용합니다.

```typescript
import sql, { raw } from "sql-template-tag";

// LEFT JOIN
qb.select(['"p".*', '"u"."name" AS "authorName"'])
  .from('"posts"', "p")
  .leftJoin(
    '"users"',
    "u",
    sql`${raw('"p"')}."author_id" = ${raw('"u"')}."id"`
  );

// INNER JOIN
qb.select(['"o".*'])
  .from('"orders"', "o")
  .innerJoin(
    '"order_items"',
    "oi",
    sql`${raw('"o"')}."id" = ${raw('"oi"')}."order_id"`
  );

// RIGHT JOIN도 같은 방식
qb.rightJoin('"employees"', "e", sql`...`);
```

## ORDER BY, LIMIT, OFFSET

```typescript
// ORDER BY
qb.orderBy([
  { column: '"created_at"', direction: "DESC" },
  { column: '"id"', direction: "ASC" },
]);

// LIMIT
qb.limit(10);

// [offset, count] 형태
qb.setDatabaseType("mysql").limit([20, 10]);
// MySQL: LIMIT 20, 10

qb.setDatabaseType("postgresql").limit([20, 10]);
// PostgreSQL: LIMIT 10 OFFSET 20

// LIMIT + OFFSET
qb.limit(10).offset(20);
```

## GROUP BY, HAVING

집계 쿼리에 사용합니다.

```typescript
qb.select(['"category"', "COUNT(*) AS cnt"])
  .from('"posts"')
  .where([sql`"is_active" = ${true}`])
  .groupBy(['"category"'])
  .having([sql`COUNT(*) >= ${5}`]);
// SELECT "category", COUNT(*) AS cnt
// FROM "posts"
// WHERE "is_active" = $1
// GROUP BY "category"
// HAVING COUNT(*) >= $2
```

## 서브쿼리

### IN 서브쿼리

```typescript
const subQuery = RawQueryBuilderFactory.create()
  .select(['"user_id"'])
  .from('"premium_subscriptions"')
  .where([sql`"is_active" = ${true}`])
  .asInQuery();

qb.select(["*"])
  .from('"users"')
  .where([])
  .appendSql(sql`AND "id" IN ${subQuery}`);
// SELECT * FROM "users" WHERE 1=1 AND "id" IN (SELECT "user_id" FROM ...)
```

### EXISTS 서브쿼리

```typescript
const exists = RawQueryBuilderFactory.create()
  .select(['"1"'])
  .from('"orders"')
  .where([sql`"user_id" = "u"."id"`])
  .asExists();

qb.select(["*"])
  .from('"users"', "u")
  .where([exists]);
// SELECT * FROM "users" AS u WHERE EXISTS (SELECT "1" FROM "orders" WHERE ...)
```

### FROM 서브쿼리

```typescript
const subQuery = RawQueryBuilderFactory.create()
  .select(['"post_id"', "COUNT(*) AS cnt"])
  .from('"comments"')
  .groupBy(['"post_id"'])
  .as("comment_counts");

qb.select(['"p"."id"', '"p"."title"', '"cc"."cnt"'])
  .from('"posts"', "p")
  .leftJoin(subQuery, "cc", sql`"p"."id" = "cc"."post_id"`);
```

## 실전 예제

### 사용자별 주문 통계

```typescript
const query = RawQueryBuilderFactory.create()
  .select([
    '"u"."id"',
    '"u"."name"',
    'COUNT("o"."id") AS "orderCount"',
    'SUM("o"."total") AS "totalAmount"',
  ])
  .from('"users"', "u")
  .leftJoin(
    '"orders"', "o",
    sql`${raw('"u"')}."id" = ${raw('"o"')}."user_id"`
  )
  .where([sql`${raw('"u"')}."is_active" = ${true}`])
  .groupBy(['"u"."id"', '"u"."name"'])
  .having([sql`COUNT("o"."id") >= ${1}`])
  .orderBy([{ column: '"totalAmount"', direction: "DESC" }])
  .limit(20)
  .build();

const stats = await em.query(query);
```

### 날짜 범위 + 상태 필터 + 페이지네이션

```typescript
const startDate = new Date("2024-01-01");
const endDate = new Date("2024-12-31");

const query = RawQueryBuilderFactory.create()
  .select(["*"])
  .from('"orders"')
  .where([sql`"created_at" BETWEEN ${startDate} AND ${endDate}`])
  .whereIn('"status"', ["pending", "processing"])
  .whereNotNull('"customer_id"')
  .orderBy([{ column: '"created_at"', direction: "DESC" }])
  .limit(10)
  .offset(20)
  .build();

const orders = await em.query(query);
```

## 다음 단계

- [트랜잭션](./transactions.md) — 쿼리 여러 개를 하나의 작업 단위로 묶기
- [EntityManager](./entity-manager.md) — find(), save() 등 기본 CRUD로 돌아가기
- [API 레퍼런스](./api-reference.md) — 전체 메서드 시그니처 빠르게 확인
