# Query Builder — JOIN

`find()`로도 관계를 따라 eager load는 할 수 있습니다. 다만 `@ManyToOne` / `@OneToMany` / `@OneToOne`으로 선언해 둔 경로만 탐색할 수 있죠.

쿼리 빌더는 거기서 한 발 더 나갑니다. 어떤 엔티티든, 심지어 raw 테이블 이름만 알아도 조인할 수 있고, 조인 건너편의 컬럼을 타입스크립트 자동완성으로 참조할 수 있고, 관계 메타데이터가 있으면 ON 절을 아예 생략할 수도 있습니다. 쿼리 빌더의 가치가 가장 선명하게 드러나는 구간이에요.

조인을 쓰는 방식은 세 가지입니다. 하나씩 살펴봅니다.

> **먼저 알아둘 것** — 이 페이지에서 쓰는 컬럼 참조 헬퍼(`alias()`, `qAlias()`)의 전체 설명은 [QueryDSL 표현식](./query-builder-querydsl.md)에 있습니다. 아래에서는 조인에 필요한 만큼만 다시 정리해요.

## `alias()` — 타입 안전한 컬럼 참조

조인을 하는 순간 여러 엔티티의 컬럼을 함께 참조하게 됩니다 — `"p.authorId"`, `"u.firstName"` 같은 것들. 이런 문자열은 자동완성이 안 돼요. `alias()`가 그 틈을 메웁니다.

```typescript
import { alias } from "@stingerloom/orm";

const p = alias(Post, "p");
const u = alias(User, "u");

p.col("authorId");   // "p.authorId" 반환 — 자동완성 ✓
u.col("firstName");  // "u.firstName" 반환 — 자동완성 ✓
u.col("typo");       // ✗ 컴파일 에러 — "typo"는 User의 키가 아님
```

`alias()`는 타입이 찍힌 참조를 만들어 줍니다. `.col()`의 인자가 `keyof T`로 제한되니 에디터가 프로퍼티 이름을 자동완성해 주고, 런타임에는 `"alias.property"` 문자열을 돌려줍니다. 쿼리 빌더의 별칭 레지스트리가 이를 실제 DB 컬럼명으로 변환해 줍니다.

`alias()` 참조는 어디서든 쓸 수 있어요 — `where()`, `selectRaw()`, `addOrderBy()`, `whereIn()`, `JoinOnBuilder.on()`.

## `qAlias()` — 연산자까지 타입드

좀 더 직관적인 API를 원한다면 `qAlias()`를 쓰세요. 엔티티 프로퍼티에 바로 접근하고 그 뒤에 조건 메서드를 이어 붙일 수 있습니다. 코드 생성 단계 없이 런타임 프록시로 동작해요.

```typescript
import { qAlias } from "@stingerloom/orm";

const u = qAlias(User, "u");
const p = qAlias(Post, "p");

const posts = await em
  .createQueryBuilder(Post, "p")
  .leftJoin(User, "u", (j) => j.on(p.col("authorId"), "=", u.col("id")))
  .where(u.firstName.eq("Alice"))           // u.firstName 자동완성 ✓
  .where(u.age.gte(18))                     // .gte() → >= 연산자
  .where(p.status.in(["active", "draft"]))  // .in() → IN (...)
  .where(u.deletedAt.isNull())              // .isNull() → IS NULL
  .getRawMany();
```

프로퍼티 하나하나가 `ColumnExpression`이 됩니다. 조인 맥락에서 자주 쓰는 연산자만 짧게 정리하면:

| 메서드 | SQL | 예시 |
|--------|-----|------|
| `.eq(value)` | `= ?` | `u.name.eq("Alice")` |
| `.neq(value)` | `!= ?` | `u.role.neq("guest")` |
| `.gt(value)` | `> ?` | `u.age.gt(18)` |
| `.gte(value)` | `>= ?` | `u.age.gte(18)` |
| `.lt(value)` | `< ?` | `u.age.lt(65)` |
| `.lte(value)` | `<= ?` | `u.age.lte(65)` |
| `.like(pattern)` | `LIKE ?` | `u.name.like("%John%")` |
| `.notLike(pattern)` | `NOT LIKE ?` | `u.name.notLike("%bot%")` |
| `.in(values)` | `IN (?, ?, ...)` | `u.id.in([1, 2, 3])` |
| `.notIn(values)` | `NOT IN (...)` | `u.id.notIn([999])` |
| `.isNull()` | `IS NULL` | `u.deletedAt.isNull()` |
| `.isNotNull()` | `IS NOT NULL` | `u.email.isNotNull()` |
| `.between(min, max)` | `BETWEEN ? AND ?` | `u.age.between(18, 65)` |

`.eq()`와 `.neq()`는 피연산자를 정규화해서 항상 올바른 SQL을 만들어 줍니다.
`null`은 `IS NULL` / `IS NOT NULL`로 바뀌고(항상 UNKNOWN이 되는 `= NULL`을
절대 만들지 않습니다), 배열은 `IN (...)` / `NOT IN (...)`으로 바뀝니다. 즉
`u.deletedAt.neq(null)`은 `IS NOT NULL`을, `u.role.neq(["a", "b"])`는
`NOT IN (?, ?)`을 생성합니다. 명시적 연산자 형태인 `where(col, "!=", null)` /
`where(col, "=", null)`에도 동일한 변환이 적용됩니다.

전체 목록(집계 / CASE / 윈도우 / 날짜 등)은 [QueryDSL 표현식](./query-builder-querydsl.md)에 있어요.

`qAlias()`는 `alias()`의 `.col()`도 지원하니 두 스타일을 섞어 써도 됩니다.

```typescript
const u = qAlias(User, "u");
qb.where(u.firstName.eq("Alice"))       // QueryDSL 스타일
  .addOrderBy(u.col("lastName"), "ASC"); // alias() 스타일
```

## 엔티티 인식 조인 (권장)

조인의 가장 깔끔한 방법은 **엔티티 클래스 자체**를 첫 인자로 넘기는 것입니다. ORM이 테이블 이름을 알아서 해석하고, `alias()`로 camelCase 프로퍼티까지 자동완성을 제공해요.

```typescript
const p = alias(Post, "p");
const u = alias(User, "u");

const posts = await em
  .createQueryBuilder(Post, "p")
  .leftJoin(User, "u", (join) =>
    join.on(p.col("authorId"), "=", u.col("id"))
  )
  .selectRaw([p.col("title"), u.col("name")])
  .where(u.col("age"), ">=", 18)
  .orderBy({ createdAt: "DESC" })
  .limit(20)
  .getRawMany();
```

- `leftJoin(User, "u", ...)` — 첫 인자가 **엔티티 클래스**입니다. ORM이 실제 테이블(`user`)을 해석하고, `"u"` 별칭을 내부 레지스트리에 등록해요.
- `join.on(p.col("authorId"), "=", u.col("id"))` — ON 조건도 타입드 참조. `SnakeNamingStrategy`를 쓴다면 `authorId` → `author_id`로 자동 변환됩니다.
- `selectRaw([p.col("title"), u.col("name")])` — 두 엔티티의 컬럼을 자동완성 받아 가며 선택.
- `where(u.col("age"), ">=", 18)` — 조인된 엔티티의 컬럼도 같은 방식으로 필터링.

::: tip
자동완성이 필요 없다면 문자열로 바로 써도 됩니다 — `where("u.age", ">=", 18)`. 런타임 동작은 동일해요.
:::

`JoinOnBuilder` 콜백은 여러 조건과 리터럴 값을 모두 받습니다.

```typescript
qb.leftJoin(User, "u", (join) =>
  join
    .on(p.col("authorId"), "=", u.col("id"))       // 컬럼 = 컬럼
    .andOn(u.col("status"), "=", p.col("status"))   // 추가 조건
    .onVal(u.col("isActive"), "=", true)             // 컬럼 = 리터럴 값
);
```

### Null 및 IN 조건 — `onNull()`, `onNotNull()`, `onIn()`

세 가지 `JoinOnBuilder` 메서드를 쓰면 빌더를 벗어나지 않고 JOIN 범위를 더 좁힐 수 있습니다.

| 메서드 | SQL 조각 | 비고 |
|--------|---------|------|
| `onNull(ref)` | `ref IS NULL` | 매칭이 없는 행을 거르는 안티-조인에 유용 |
| `onNotNull(ref)` | `ref IS NOT NULL` | 조인 대상 측에 null이 아닌 값을 요구 |
| `onIn(ref, values)` | `ref IN (?, ?, ...)` | 값은 파라미터 바인딩 (직접 연결 없음); 빈 배열은 `1 = 0` 방출 |

세 메서드 모두 `on()` / `andOn()` / `onVal()`과 AND 의미론으로 이어집니다. `ref` 인자는 `on()`과 동일한 `"alias.property"` 문자열 해석 방식을 따르므로 NamingStrategy와 `@Column({ name })` 매핑이 그대로 적용돼요.

```typescript
// 활성 상태이고 이메일 인증된 사용자만 조인
const posts = await em
  .createQueryBuilder(Post, "p")
  .leftJoin(User, "u", (j) =>
    j.on("p.authorId", "=", "u.id")
     .onNotNull("u.verifiedAt")                // u.verified_at IS NOT NULL
     .onIn("u.role", ["admin", "editor"]),     // u.role IN (?, ?)
  )
  .getMany();

// soft-delete되지 않은 작성자가 없는 게시물 찾기
const orphaned = await em
  .createQueryBuilder(Post, "p")
  .leftJoin(User, "u", (j) =>
    j.on("p.authorId", "=", "u.id")
     .onNull("u.deletedAt"),   // u.deleted_at IS NULL
  )
  .getMany();
```

### 범위 포함 ON — `onBetween()`

범위 포함(range containment) 셀프 조인 — 중첩 집합(nested set), 인터벌 트리 — 에서는 `onBetween(ref, lowRef, highRef)`가 컬럼을 다른 두 **컬럼 참조** 사이와 비교합니다. `onValBetween(ref, low, high)`는 리터럴 경계값을 받아 파라미터로 바인딩해요.

```typescript
// SELECT ... FROM category node JOIN category parent
//   ON node.lft BETWEEN parent.lft AND parent.rgt
const tree = await em
  .createQueryBuilder(Category, "node")
  .innerJoin(Category, "parent", (j) =>
    j.onBetween("node.lft", "parent.lft", "parent.rgt"),
  )
  .getRawMany();

// 리터럴 경계 — 파라미터 바인딩
qb.innerJoin(Category, "sub", (j) => j.onValBetween("sub.lft", 1, 42));
```

`andOnBetween()`은 AND 의미론으로 범위 조건을 하나 더 잇습니다. 세 메서드 모두 별칭 레지스트리를 통해 참조를 해석하므로 NamingStrategy와 `@Column({ name })` 매핑이 그대로 적용돼요.

## 관계 기반 조인 (ON 자동 생성)

`@ManyToOne` / `@OneToMany` / `@OneToOne`이 걸려 있다면 ON 조건을 생략해도 됩니다. 관계 메타데이터에서 ORM이 알아서 만들어요.

```typescript
// Post에 @ManyToOne(() => User) author: User; 가 있다면

const posts = await em
  .createQueryBuilder(Post, "p")
  .leftJoinRelation("author", "u")     // 자동: ON p.author_id = u.id
  .where("u.name", "LIKE", "%John%")
  .getMany();
```

양방향 모두 동작합니다.

```typescript
// User에 @OneToMany(() => Post, { mappedBy: "author" }) posts: Post[]; 가 있다면

const users = await em
  .createQueryBuilder(User, "u")
  .leftJoinRelation("posts", "p")      // 자동: ON u.id = p.author_id
  .where("p.status", "published")
  .getMany();
```

`innerJoinRelation()`도 있어요.

> **`@ManyToMany`는 `leftJoinRelation` / `innerJoinRelation` 대상에서 빠져 있습니다.** 중간 테이블을 자동으로 두 번 조인해 주지는 않으니, M2M 조인은 중간 테이블을 직접 문자열 조인으로 이어주거나 서브쿼리로 풀어 쓰세요. 같은 이유로 `whereHas`도 `@ManyToMany`를 지원하지 않습니다 ([편의 패턴 → `whereHas`](./query-builder-patterns.md#wherehas-wherenothas-—-관계-존재-필터) 참고).

## JoinAndSelect — 조인과 SELECT를 한 번에

조인된 엔티티의 모든 컬럼을 결과에 포함시키고 싶을 때는 `*AndSelect` 변형이 있습니다. 조인 + SELECT 반복 작업을 하나로 줄여 주고, 엔티티 조회에서는 조인된 컬럼이 관계 프로퍼티로 하이드레이션됩니다.

```typescript
const posts = await em
  .createQueryBuilder(Post, "p")
  .leftJoinRelationAndSelect("author", "u")
  .where("p.status", "published")
  .getMany();
// [Post { id: 1, title: "...", author: User { id: 7, name: "Alice" } }, ...]
```

`*AndSelect` 변형은 네 가지입니다.

| 메서드 | 설명 |
|--------|------|
| `leftJoinAndSelect(Entity, alias, onBuilder)` | LEFT JOIN + 조인된 컬럼 자동 SELECT |
| `innerJoinAndSelect(Entity, alias, onBuilder)` | INNER JOIN + 조인된 컬럼 자동 SELECT |
| `leftJoinRelationAndSelect(property, alias)` | 관계 기반 LEFT JOIN + 자동 SELECT |
| `innerJoinRelationAndSelect(property, alias)` | 관계 기반 INNER JOIN + 자동 SELECT |

### 컬럼이 선택되는 방식

조인된 모든 컬럼은 `alias_column` AS 별칭으로 선택됩니다 (`` `u`.`id` AS `u_id` ``). 동시에 루트의 `alias.*`도 `alias_column` 형태의 명시적 컬럼들(`p_id`, `p_title`, …)로 펼쳐져요. 모든 컬럼이 고유한 접두사를 달고 있으니, 조인된 컬럼이 같은 이름의 루트 컬럼을 덮어쓰는 일이 원천적으로 불가능합니다 — 양쪽 테이블에 `id`가 있어도 문제없어요.

### getMany() / getOne() — 관계 하이드레이션

엔티티 조회는 접두사 컬럼들을 관계 프로퍼티로 다시 조립합니다.

- `@ManyToOne` / `@OneToOne` — 조인된 행이 **중첩 객체**가 됩니다. LEFT JOIN에서 매칭이 없으면 `null`이에요.
- `@OneToMany` — 루트 행을 **PK 기준으로 중복 제거·그룹화**하고, 조인된 행들을 배열로 모읍니다. 매칭이 없으면 빈 배열 `[]`이에요.

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .leftJoinRelationAndSelect("posts", "p")
  .getMany();
// [User { id: 1, posts: [Post {...}, Post {...}] }, User { id: 2, posts: [] }]
// — 조인된 행마다 하나가 아니라, 행 그룹당 User 하나
```

### getRawMany() — 접두사 키

raw 조회는 접두사를 그대로 노출합니다. 조인된 컬럼은 `u_id`, `u_username`, … 으로, 루트 `*`가 펼쳐졌다면 루트 컬럼도 `p_id`, `p_title`, … 으로 도착해요.

```typescript
const rows = await em
  .createQueryBuilder(Post, "p")
  .leftJoinAndSelect(User, "u", (j) => j.on("p.authorId", "=", "u.id"))
  .getRawMany();
// [{ p_id: 1, p_title: "...", u_id: 7, u_name: "Alice", ... }]
```

::: warning 동작 변경
기존에 `getRawMany()`를 `*AndSelect`와 함께 쓰고 있었다면 키 접근을 업데이트하세요 — 조인된 컬럼(그리고 펼쳐진 루트 컬럼)은 이제 평평한 키가 아니라 접두사 키입니다. 평평한 형태는 같은 이름의 컬럼을 모르는 사이 잃어버렸지만, 접두사 형태는 모든 값을 보존해요.
:::

### 엔티티 기반 조인의 관계 매칭

`leftJoinAndSelect(Entity, alias, on)`은 루트 엔티티에 조인 대상과 연결된 관계 프로퍼티가 있으면 자동으로 매칭합니다. 매칭되면 `*RelationAndSelect` 없이도 위와 동일하게 하이드레이션돼요. 매칭되는 관계가 없으면 컬럼은 여전히 별칭 접두사를 달지만(덮어쓰기 없음) 중첩은 일어나지 않으니 `getRawMany()`로 읽으세요.

## 문자열 기반 조인 (raw)

엔티티 메타데이터가 없는 대상 — 뷰, 서브쿼리, raw 테이블 — 과 조인할 때는 테이블 이름을 그대로 문자열로 넘길 수 있어요.

```typescript
qb.leftJoin("audit_log", "al", sql`"p"."id" = "al"."post_id"`);
```

## 멀티 테이블 조인

여러 조인을 체이닝해서 엔티티 그래프를 따라갈 수 있습니다.

```typescript
const p = qAlias(Post, "p");
const u = qAlias(User, "u");
const c = qAlias(Comment, "c");

const results = await em
  .createQueryBuilder(Post, "p")
  .leftJoin(User, "u", (j) => j.on(p.col("authorId"), "=", u.col("id")))
  .leftJoin(Comment, "c", (j) => j.on(c.col("postId"), "=", p.col("id")))
  .selectRaw([p.col("title"), u.col("name"), c.col("content")])
  .where(u.age.gte(18))
  .where(c.content.isNotNull())
  .addOrderBy(u.col("name"), "ASC")
  .limit(50)
  .getRawMany();
```

## 실전 — B2B 매출 리포트 (3단 조인 + 집계)

조인이 두 개 이상 겹치는 전형적인 시나리오가 리포트성 쿼리입니다. "2026년 이후 주문 중 총 주문 수량이 50개를 넘는 고객을 수량 내림차순으로" 같은 요구를 그려 보면, 조인과 집계가 한 화면에 자연스럽게 모여요.

```typescript
const c = qAlias(Customer, "c");
const o = qAlias(Order, "o");
const oi = qAlias(OrderItem, "oi");
const totalQty = oi.quantity.sum();

const top = await em.createQueryBuilder(Customer, "c")
  .innerJoin(Order, "o", (j) => j.on(o.col("customerId"), "=", c.col("id")))
  .innerJoin(OrderItem, "oi", (j) => j.on(oi.col("orderId"), "=", o.col("id")))
  .selectRaw([c.col("name")])
  .addSelect(totalQty.as("totalQty"))
  .where(o.createdAt.gte(new Date("2026-01-01")))
  .groupBy([c.col("name")])
  .having(totalQty.gt(50))
  .addOrderBy(totalQty.desc())
  .getRawMany();
```

나가는 SQL은 이렇게 생겼습니다 (PostgreSQL + `SnakeNamingStrategy` 기준).

```sql
SELECT "c"."name", SUM("oi"."quantity") AS "totalQty"
FROM "customer" AS "c"
INNER JOIN "order" AS "o" ON "o"."customer_id" = "c"."id"
INNER JOIN "order_item" AS "oi" ON "oi"."order_id" = "o"."id"
WHERE "o"."created_at" >= $1
GROUP BY "c"."name"
HAVING SUM("oi"."quantity") > $2
ORDER BY SUM("oi"."quantity") DESC
-- parameters: ["2026-01-01T00:00:00.000Z", 50]
```

세 군데를 눈여겨볼 만합니다. `totalQty`라는 TypeScript 변수 하나가 SELECT에서는 `SUM(...) AS "totalQty"`로, HAVING과 ORDER BY에서는 별칭이 아닌 `SUM("oi"."quantity")` 표현식 그대로 다시 펼쳐져서 내려가요. 별칭을 재참조하지 않고 표현식을 풀어 쓰는 이유는 이식성 때문입니다 — 일부 DB는 HAVING에서 SELECT 별칭을 허용하지 않거든요. `o.createdAt.gte(new Date("2026-01-01"))`의 Date도 바인딩 파라미터 `$1`로 나가고, `50`은 `$2`로 붙습니다. 집계 쪽 전체 설명은 [집계 & 서브쿼리](./query-builder-aggregations.md)에 이어집니다.

## 크로스 엔티티 컬럼 해석

엔티티 인식 조인이든 관계 기반 조인이든, 조인된 뒤에는 어디서든 컬럼을 참조할 수 있습니다.

**`qAlias()` 스타일:**

```typescript
const u = qAlias(User, "u");
const p = qAlias(Post, "p");

// WHERE — QueryDSL 표현식 (프로퍼티 + 연산자 자동완성)
qb.where(u.name.eq("Alice"));
qb.where(u.age.gte(18));
qb.where(u.id.in([1, 2, 3]));
qb.where(u.deletedAt.isNull());
qb.where(u.email.isNotNull());
qb.where(u.age.between(18, 65));
qb.where(u.name.like("%alice%"));

// SELECT — .col()로 컬럼 참조
qb.selectRaw([p.col("title"), u.col("name")]);
qb.addSelect(u.col("email"), "authorEmail");

// ORDER BY / GROUP BY
qb.addOrderBy(u.col("name"), "ASC");
qb.groupBy([u.col("id"), p.col("category")]);
```

**`alias()` 스타일:**

```typescript
const u = alias(User, "u");
qb.where(u.col("name"), "Alice");
qb.where(u.col("age"), ">=", 18);
```

모든 참조는 별칭 레지스트리를 통해 해석됩니다. `SnakeNamingStrategy`를 쓰고 있다면 `u.col("firstName")`도 `u.firstName.eq(...)`도 동일하게 `"u"."first_name"`으로 변환돼요.

## 조인 타입 요약

| 메서드 | SQL | 언제 쓰나 |
|--------|-----|-----------|
| `leftJoin()` | `LEFT JOIN` | 조인 대상에 매칭이 없어도 왼쪽 행을 남기고 싶을 때 |
| `innerJoin()` | `INNER JOIN` | 양쪽 모두 매칭되는 행만 필요할 때 |
| `rightJoin()` | `RIGHT JOIN` | 조인 대상의 모든 행을 남기고 싶을 때 |
| `leftJoinRelation()` | `LEFT JOIN` | `@ManyToOne` / `@OneToMany` 메타데이터로 ON 자동 생성 |
| `innerJoinRelation()` | `INNER JOIN` | 관계 메타데이터로 ON 자동 생성 |

## 다음 단계

- [QueryDSL 표현식](./query-builder-querydsl.md) — `qAlias()`의 전체 연산자와 표현식
- [집계 & 서브쿼리](./query-builder-aggregations.md) — 조인 위에 얹는 GROUP BY / HAVING / 서브쿼리
- [Query Builder 개요](./query-builder.md) — 기본 사용법과 전체 지도
