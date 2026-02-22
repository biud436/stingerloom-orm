# 쿼리 빌더 (RawQueryBuilder)

`RawQueryBuilder`는 체이닝 방식으로 복잡한 SQL 쿼리를 안전하게 구성할 수 있는 DSL입니다. 내부적으로 `sql-template-tag`를 사용하여 파라미터 바인딩을 처리합니다.

---

## 기본 사용법

`RawQueryBuilderFactory.create()`로 인스턴스를 생성하고 메서드를 체이닝합니다. 최종적으로 `build()`를 호출하면 `Sql` 객체가 반환됩니다.

```typescript
import { RawQueryBuilderFactory } from "stingerloom-orm";
import sql, { raw } from "sql-template-tag";

const qb = RawQueryBuilderFactory.create();

const query = qb
  .select(["id", "name", "email"])
  .from("`users`")
  .where([sql`\`is_active\` = ${true}`])
  .orderBy([{ column: "`created_at`", direction: "DESC" }])
  .limit(10)
  .build();

// TransactionSessionManager로 실행
const result = await transactionManager.query(query);
```

> 식별자(테이블명, 컬럼명)는 반드시 드라이버에 맞게 escape해야 합니다.
> MySQL: 백틱(\`), PostgreSQL: 큰따옴표(")

---

## select(columns)

SELECT 절을 설정합니다.

```typescript
select(columns: string[] | "*"): RawQueryBuilder
```

```typescript
// 특정 컬럼
qb.select(["`id`", "`name`", "`email`"]);

// 전체 컬럼
qb.select("*");

// 별칭(alias) 포함
qb.select(["`u`.`id`", "`u`.`name` AS `userName`"]);
```

---

## from(table, alias?)

FROM 절을 설정합니다.

```typescript
from(table: string | Sql, alias?: string): RawQueryBuilder
```

```typescript
// 테이블명
qb.from("`users`");

// 별칭 포함
qb.from("`users`", "u");

// 서브쿼리 사용
const subQuery = RawQueryBuilder.subquery()
  .select(["post_id", "COUNT(*) AS cnt"])
  .from("`comments`")
  .groupBy(["`post_id`"])
  .as("comment_counts");

qb.select(["`p`.`id`", "`p`.`title`", "`cc`.`cnt`"])
  .from("`posts`", "p")
  .leftJoin(subQuery, "cc", sql`\`p\`.\`id\` = \`cc\`.\`post_id\``);
```

---

## where(conditions) / andWhere(condition) / orWhere(condition)

WHERE 절을 설정합니다.

```typescript
where(conditions: Sql[]): RawQueryBuilder
andWhere(condition: Sql): RawQueryBuilder
orWhere(condition: Sql): RawQueryBuilder
```

```typescript
import sql from "sql-template-tag";

// 기본 WHERE
qb.where([
  sql`\`is_active\` = ${true}`,
  sql`\`age\` >= ${18}`,
]);
// WHERE `is_active` = ? AND `age` >= ?

// 빈 배열이면 WHERE 1=1
qb.where([]);

// AND 추가
qb.where([sql`\`is_active\` = ${true}`])
  .andWhere(sql`\`age\` < ${60}`);

// OR 추가
qb.where([sql`\`type\` = ${"admin"}`])
  .orWhere(sql`\`type\` = ${"superadmin"}`);
```

---

## whereIn / whereNotIn

IN / NOT IN 조건을 추가합니다. `where()` 이후에 AND로 연결됩니다.

```typescript
whereIn(column: string, values: any[]): RawQueryBuilder
whereNotIn(column: string, values: any[]): RawQueryBuilder
```

```typescript
qb.where([])
  .whereIn("`status`", ["active", "pending"]);
// WHERE 1=1 AND `status` IN (?, ?)

qb.where([])
  .whereNotIn("`id`", [1, 2, 3]);
// WHERE 1=1 AND `id` NOT IN (?, ?, ?)
```

---

## whereNull / whereNotNull

IS NULL / IS NOT NULL 조건을 추가합니다.

```typescript
whereNull(column: string): RawQueryBuilder
whereNotNull(column: string): RawQueryBuilder
```

```typescript
qb.where([])
  .whereNull("`deleted_at`");
// WHERE 1=1 AND `deleted_at` IS NULL

qb.where([])
  .whereNotNull("`email`");
// WHERE 1=1 AND `email` IS NOT NULL
```

---

## whereBetween

BETWEEN 조건을 추가합니다.

```typescript
whereBetween(column: string, min: any, max: any): RawQueryBuilder
```

```typescript
qb.where([])
  .whereBetween("`age`", 18, 65);
// WHERE 1=1 AND `age` BETWEEN ? AND ?
```

---

## JOIN 메서드

테이블 간 JOIN을 추가합니다.

```typescript
leftJoin(table: string | Sql, alias: string, condition: Sql): RawQueryBuilder
innerJoin(table: string | Sql, alias: string, condition: Sql): RawQueryBuilder
rightJoin(table: string | Sql, alias: string, condition: Sql): RawQueryBuilder
join(type: "INNER" | "LEFT" | "RIGHT", table, alias, condition): RawQueryBuilder
```

```typescript
import sql, { raw } from "sql-template-tag";

// LEFT JOIN
qb.select(["`p`.*", "`u`.`name` AS `authorName`"])
  .from("`posts`", "p")
  .leftJoin(
    "`users`",
    "u",
    sql`${raw("`p`")}.${raw("`author_id`")} = ${raw("`u`")}.${raw("`id`")}`
  );
// SELECT `p`.*, `u`.`name` AS `authorName`
// FROM `posts` AS p
// LEFT JOIN `users` AS u ON `p`.`author_id` = `u`.`id`

// INNER JOIN
qb.select(["`o`.*"])
  .from("`orders`", "o")
  .innerJoin(
    "`order_items`",
    "oi",
    sql`${raw("`o`")}.${raw("`id`")} = ${raw("`oi`")}.${raw("`order_id`")}`
  );

// RIGHT JOIN
qb.from("`departments`", "d")
  .rightJoin(
    "`employees`",
    "e",
    sql`${raw("`d`")}.${raw("`id`")} = ${raw("`e`")}.${raw("`dept_id`")}`
  );
```

---

## orderBy(orders)

ORDER BY 절을 설정합니다.

```typescript
orderBy(orders: Array<{ column: string; direction: "ASC" | "DESC" }>): RawQueryBuilder
```

```typescript
qb.orderBy([
  { column: "`created_at`", direction: "DESC" },
  { column: "`id`", direction: "ASC" },
]);
// ORDER BY `created_at` DESC, `id` ASC
```

---

## limit(limit) / offset(offset)

LIMIT, OFFSET 절을 설정합니다.

```typescript
limit(limit: number | [number, number]): RawQueryBuilder
offset(offset: number): RawQueryBuilder
```

```typescript
// 단순 LIMIT
qb.limit(10);
// LIMIT 10

// [offset, count] 형태 (MySQL: LIMIT offset, count)
qb.setDatabaseType("mysql").limit([20, 10]);
// LIMIT 20, 10

// [offset, count] 형태 (PostgreSQL: LIMIT count OFFSET offset)
qb.setDatabaseType("postgresql").limit([20, 10]);
// LIMIT 10 OFFSET 20

// 독립적인 OFFSET (limit()과 함께 사용)
qb.limit(10).offset(20);
// LIMIT 10 OFFSET 20
```

---

## groupBy(columns) / having(conditions)

GROUP BY / HAVING 절을 설정합니다.

```typescript
groupBy(columns: string[]): RawQueryBuilder
having(conditions: Sql[]): RawQueryBuilder
```

```typescript
qb.select(["`category`", "COUNT(*) AS cnt"])
  .from("`posts`")
  .where([sql`\`is_active\` = ${true}`])
  .groupBy(["`category`"])
  .having([sql`COUNT(*) >= ${5}`]);
// SELECT `category`, COUNT(*) AS cnt
// FROM `posts`
// WHERE `is_active` = ?
// GROUP BY `category`
// HAVING COUNT(*) >= ?
```

---

## 서브쿼리

```typescript
// as(alias): IN 절에 사용할 서브쿼리
const subQuery = RawQueryBuilderFactory.create()
  .select(["`user_id`"])
  .from("`premium_subscriptions`")
  .where([sql`\`is_active\` = ${true}`])
  .asInQuery();

qb.select(["*"])
  .from("`users`")
  .where([])
  .appendSql(sql`AND \`id\` IN ${subQuery}`);
// SELECT * FROM `users` WHERE 1=1 AND `id` IN (SELECT `user_id` FROM ...)

// asExists(): EXISTS 서브쿼리
const exists = RawQueryBuilderFactory.create()
  .select(["`1`"])
  .from("`orders`")
  .where([sql`\`user_id\` = \`u\`.\`id\``])
  .asExists();

qb.select(["*"])
  .from("`users`", "u")
  .where([exists]);
// SELECT * FROM `users` AS u WHERE EXISTS (SELECT `1` FROM `orders` WHERE ...)
```

---

## 복잡한 쿼리 예제

### 사용자별 주문 통계

```typescript
const qb = RawQueryBuilderFactory.create();

const result = qb
  .select([
    "`u`.`id`",
    "`u`.`name`",
    "COUNT(`o`.`id`) AS `orderCount`",
    "SUM(`o`.`total`) AS `totalAmount`",
  ])
  .from("`users`", "u")
  .leftJoin(
    "`orders`",
    "o",
    sql`${raw("`u`")}.${raw("`id`")} = ${raw("`o`")}.${raw("`user_id`")}`
  )
  .where([sql`${raw("`u`")}.${raw("`is_active`")} = ${true}`])
  .groupBy(["`u`.`id`", "`u`.`name`"])
  .having([sql`COUNT(\`o\`.\`id\`) >= ${1}`])
  .orderBy([{ column: "`totalAmount`", direction: "DESC" }])
  .limit(20)
  .build();

const rows = await em.query(result);
```

### 날짜 범위 + 상태 필터 + 페이지네이션

```typescript
const startDate = new Date("2024-01-01");
const endDate = new Date("2024-12-31");

const qb = RawQueryBuilderFactory.create();
const query = qb
  .select(["*"])
  .from("`orders`")
  .where([sql`\`created_at\` BETWEEN ${startDate} AND ${endDate}`])
  .whereIn("`status`", ["pending", "processing"])
  .whereNotNull("`customer_id`")
  .orderBy([{ column: "`created_at`", direction: "DESC" }])
  .limit(10)
  .offset(20)
  .build();
```
