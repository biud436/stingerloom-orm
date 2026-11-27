# 쿼리 빌더: JOIN

`find()`로도 관계를 따라 즉시 로딩할 수 있습니다. 다만 `@ManyToOne` / `@OneToMany` / `@OneToOne`으로 선언해 둔 경로만 따라갈 수 있습니다.

쿼리 빌더는 여기서 더 나아갑니다. 쿼리 빌더로는 어떤 엔티티와도 조인할 수 있고 raw 테이블 이름만으로도 조인할 수 있습니다. 조인한 엔티티의 컬럼도 TypeScript 자동완성을 받으며 참조할 수 있습니다. 관계 메타데이터가 있으면 ON 절을 아예 생략할 수도 있습니다. 쿼리 빌더의 장점이 `find()`와 비교해 가장 잘 드러나는 부분이 바로 조인입니다.

조인을 쓰는 방식은 세 가지입니다. raw 문자열로 쓰는 방식부터 ON 절까지 자동으로 만드는 방식까지 있습니다.

> 참고: 이 페이지에서 쓰는 컬럼 참조 헬퍼는 `alias()`와 `qAlias()`입니다. 두 헬퍼의 전체 설명은 [QueryDSL 표현식](./query-builder-querydsl.md)에 있습니다.

## `alias()`: 타입 안전한 컬럼 참조

테이블을 조인하면 `"p.authorId"`, `"u.firstName"`처럼 여러 엔티티의 컬럼을 함께 참조하게 됩니다. 이런 문자열은 자동완성이 되지 않습니다. `alias()`가 이 문제를 해결합니다.

```typescript
import { alias } from "@stingerloom/orm";

const p = alias(Post, "p");
const u = alias(User, "u");

p.col("authorId");   // "p.authorId" 반환, 자동완성 ✓
u.col("firstName");  // "u.firstName" 반환, 자동완성 ✓
u.col("typo");       // ✗ 컴파일 에러: "typo"는 User의 키가 아님
```

`alias()`는 타입 있는 참조를 만듭니다. `.col()`의 인자는 `keyof T`로 제한됩니다. 그래서 에디터가 속성 이름을 자동완성합니다. 런타임에 `.col()`은 `"alias.property"` 문자열을 반환합니다. 쿼리 빌더는 별칭 레지스트리를 거쳐 이 문자열을 실제 데이터베이스 컬럼 이름으로 변환합니다.

`alias()` 참조는 `where()`, `selectRaw()`, `addOrderBy()`, `whereIn()`, `JoinOnBuilder.on()` 등 어디서든 쓸 수 있습니다.

## `qAlias()`: 연산자까지 타입 안전

더 직관적인 API가 필요하면 `qAlias()`를 쓰세요. `qAlias()`로는 엔티티 속성에 바로 접근하고 그 뒤에 조건 메서드를 이어 붙일 수 있습니다. `qAlias()`는 코드 생성 단계 없이 런타임 프록시로 동작합니다.

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

엔티티 속성은 각각 `ColumnExpression`이 됩니다. 조인에서 자주 쓰는 연산자는 다음과 같습니다.

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

`.eq()`와 `.neq()`는 피연산자를 정규화합니다. 그래서 생성되는 SQL은 항상 올바릅니다.
`null`은 `IS NULL` / `IS NOT NULL`로 바뀝니다. 결과가 항상 UNKNOWN이 되는 `= NULL`은
절대 만들지 않습니다. 배열은 `IN (...)` / `NOT IN (...)`으로 바뀝니다. 예를 들어
`u.deletedAt.neq(null)`은 `IS NOT NULL`을 생성하고 `u.role.neq(["a", "b"])`는
`NOT IN (?, ?)`을 생성합니다. 명시적 연산자 형태인 `where(col, "!=", null)` /
`where(col, "=", null)`에도 같은 변환이 적용됩니다.

집계, CASE, 윈도 함수, 날짜 함수 등을 포함한 전체 목록은 [QueryDSL 표현식](./query-builder-querydsl.md)에 있습니다.

`qAlias()`는 `alias()`의 `.col()`도 지원합니다. 그래서 두 스타일을 섞어 써도 됩니다.

```typescript
const u = qAlias(User, "u");
qb.where(u.firstName.eq("Alice"))       // QueryDSL 스타일
  .addOrderBy(u.col("lastName"), "ASC"); // alias() 스타일
```

## 엔티티 인식 조인 (권장)

조인하는 가장 깔끔한 방법은 엔티티 클래스를 첫 인자로 바로 넘기는 것입니다. 그러면 ORM이 테이블 이름을 자동으로 해석합니다. 그리고 `alias()`를 쓰면 camelCase 속성 이름도 자동완성됩니다.

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

- `leftJoin(User, "u", ...)`: 첫 인자는 엔티티 클래스입니다. ORM은 실제 테이블 이름(`user`)을 해석하고 `"u"` 별칭을 내부 레지스트리에 등록합니다.
- `join.on(p.col("authorId"), "=", u.col("id"))`: ON 조건에도 타입 있는 참조를 씁니다. `SnakeNamingStrategy`를 쓴다면 `authorId`는 `author_id`로 자동 변환됩니다.
- `selectRaw([p.col("title"), u.col("name")])`: 자동완성을 받으며 두 엔티티의 컬럼을 선택합니다.
- `where(u.col("age"), ">=", 18)`: 조인한 엔티티의 컬럼도 같은 방식으로 필터링합니다.

::: tip
자동완성이 필요 없다면 `where("u.age", ">=", 18)`처럼 문자열로 바로 써도 됩니다. 런타임 동작은 같습니다.
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

### Null 및 IN 조건: `onNull()`, `onNotNull()`, `onIn()`

아래 `JoinOnBuilder` 메서드 세 개를 쓰면 빌더를 벗어나지 않고 JOIN 범위를 더 좁힐 수 있습니다.

| 메서드 | SQL 조각 | 비고 |
|--------|---------|------|
| `onNull(ref)` | `ref IS NULL` | 매칭이 없는 행을 거르는 안티 조인에 유용 |
| `onNotNull(ref)` | `ref IS NOT NULL` | 조인 대상 쪽에 null이 아닌 값을 요구 |
| `onIn(ref, values)` | `ref IN (?, ?, ...)` | 값은 파라미터로 바인딩하고 문자열로 이어 붙이지 않음. 빈 배열이면 `1 = 0`을 생성 |

세 메서드는 모두 `on()` / `andOn()` / `onVal()`과 AND로 이어집니다. `ref` 인자는 `on()`과 같은 방식으로 `"alias.property"` 문자열을 해석합니다. 그래서 NamingStrategy와 `@Column({ name })` 매핑이 그대로 적용됩니다.

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

// 소프트 삭제되지 않은 작성자가 없는 게시물 찾기
const orphaned = await em
  .createQueryBuilder(Post, "p")
  .leftJoin(User, "u", (j) =>
    j.on("p.authorId", "=", "u.id")
     .onNull("u.deletedAt"),   // u.deleted_at IS NULL
  )
  .getMany();
```

### 범위 포함 ON: `onBetween()`

중첩 집합(nested set)이나 인터벌 트리 같은 범위 포함(range containment) 셀프 조인에는 `onBetween(ref, lowRef, highRef)`를 씁니다. `onBetween()`은 컬럼 값이 다른 컬럼 참조 두 개 사이에 있는지 비교합니다. `onValBetween(ref, low, high)`는 리터럴 경계값을 받아 파라미터로 바인딩합니다.

```typescript
// SELECT ... FROM category node JOIN category parent
//   ON node.lft BETWEEN parent.lft AND parent.rgt
const tree = await em
  .createQueryBuilder(Category, "node")
  .innerJoin(Category, "parent", (j) =>
    j.onBetween("node.lft", "parent.lft", "parent.rgt"),
  )
  .getRawMany();

// 리터럴 경계: 파라미터 바인딩
qb.innerJoin(Category, "sub", (j) => j.onValBetween("sub.lft", 1, 42));
```

`andOnBetween()`은 범위 조건을 하나 더 AND로 잇습니다. 세 메서드는 모두 별칭 레지스트리를 거쳐 참조를 해석합니다. 그래서 NamingStrategy와 `@Column({ name })` 매핑이 그대로 적용됩니다.

## 관계 기반 조인 (ON 자동 생성)

엔티티에 `@ManyToOne` / `@OneToMany` / `@OneToOne`을 선언했다면 ON 조건을 생략해도 됩니다. ORM이 관계 메타데이터에서 ON 조건을 만듭니다.

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

`innerJoinRelation()`도 있습니다.

관계 조인은 조인한 엔티티의 소프트 삭제 필터를 ON 절에 함께 붙입니다. `User`에 `@DeletedAt`이 있으면 `leftJoinRelation("author", "u")`는 `ON p.author_id = u.id AND u.deleted_at IS NULL`로 렌더링됩니다. 그래서 소프트 삭제된 작성자는 LEFT JOIN에서는 `null`로 하이드레이트되고 INNER JOIN에서는 게시물째 결과에서 빠집니다. `find(Post, { relations: ["author"] })`와 같은 결과입니다. `withDeleted()`는 루트 필터와 함께 이 필터도 걷어냅니다. 명시적인 `leftJoin(User, "u", on => ...)`에는 이 필터를 붙이지 않습니다. 이때 ON 절은 작성한 그대로 실행됩니다. 그래서 소프트 삭제된 행을 감사하는 쿼리(`onNotNull("u.deletedAt")`)도 그대로 쓸 수 있습니다.

> `@ManyToMany`는 `leftJoinRelation` / `innerJoinRelation`의 대상이 아닙니다. ORM은 조인 테이블을 자동으로 두 번 조인하지 않습니다. 그래서 `@ManyToMany` 관계를 조인하려면 조인 테이블을 문자열 조인으로 직접 잇거나 서브쿼리로 풀어 쓰세요. 같은 이유로 `whereHas`도 `@ManyToMany`를 지원하지 않습니다. 자세한 내용은 [편의 패턴 → `whereHas`](./query-builder-patterns.md#wherehas-wherenothas-관계-존재-필터)를 참고하세요.

## JoinAndSelect: 조인과 SELECT를 한 번에

조인한 엔티티의 모든 컬럼을 결과에 포함하려면 `*AndSelect` 변형을 쓰세요. 조인한 다음 컬럼을 일일이 SELECT하는 작업을 호출 한 번으로 줄여 줍니다. 그리고 엔티티 조회에서는 조인한 컬럼이 관계 속성으로 하이드레이트됩니다.

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

조인한 컬럼은 모두 `alias_column` 형태의 AS 별칭으로 선택됩니다(`` `u`.`id` AS `u_id` ``). 동시에 루트의 `alias.*`도 `alias_column` 형태의 별칭을 단 명시적 컬럼(`p_id`, `p_title`, …)으로 펼쳐집니다. 모든 컬럼에 고유한 접두사가 붙습니다. 그래서 조인한 컬럼이 같은 이름의 루트 컬럼을 덮어쓰는 일은 원천적으로 일어나지 않습니다. 양쪽 테이블에 모두 `id`가 있어도 문제없습니다.

### getMany() / getOne(): 관계 하이드레이트

엔티티 조회는 접두사가 붙은 컬럼을 관계 속성으로 다시 조립합니다.

- `@ManyToOne` / `@OneToOne`: 조인한 행이 중첩 객체가 됩니다. LEFT JOIN에서 매칭되는 행이 없으면 `null`입니다.
- `@OneToMany`: 루트 행을 기본 키 기준으로 중복 제거하고 그룹으로 묶습니다. 그리고 조인한 행을 배열로 모읍니다. 매칭되는 행이 없으면 빈 배열 `[]`입니다.

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .leftJoinRelationAndSelect("posts", "p")
  .getMany();
// [User { id: 1, posts: [Post {...}, Post {...}] }, User { id: 2, posts: [] }]
// User는 조인된 행마다 하나가 아니라 행 그룹마다 하나씩 생깁니다
```

### getRawMany(): 접두사 키

raw 조회는 접두사를 그대로 드러냅니다. 조인한 컬럼은 `u_id`, `u_username`, … 키로 들어옵니다. 루트 `*`가 펼쳐졌다면 루트 컬럼도 `p_id`, `p_title`, … 키로 들어옵니다.

```typescript
const rows = await em
  .createQueryBuilder(Post, "p")
  .leftJoinAndSelect(User, "u", (j) => j.on("p.authorId", "=", "u.id"))
  .getRawMany();
// [{ p_id: 1, p_title: "...", u_id: 7, u_name: "Alice", ... }]
```

::: warning 동작 변경
기존에 `getRawMany()`를 `*AndSelect`와 함께 쓰고 있었다면 키에 접근하는 코드를 고치세요. 이제 조인한 컬럼과 펼쳐진 루트 컬럼은 접두사 없는 키가 아니라 접두사 키로 들어옵니다. 접두사 없는 형태에서는 같은 이름의 컬럼이 경고 없이 사라졌습니다. 반면 접두사 형태는 모든 값을 보존합니다.
:::

### 엔티티 기반 조인의 관계 매칭

루트 엔티티에 조인 대상과 연결된 관계 속성이 있으면 `leftJoinAndSelect(Entity, alias, on)`은 조인 대상을 그 관계 속성에 자동으로 매칭합니다. 매칭되면 `*RelationAndSelect` 없이도 위와 똑같이 하이드레이트됩니다. 매칭되는 관계가 없어도 컬럼에는 별칭 접두사가 붙으므로 덮어쓰기는 일어나지 않습니다. 다만 중첩 객체는 만들어지지 않으니 `getRawMany()`로 조회하세요.

## 문자열 기반 조인 (raw)

뷰, 서브쿼리, raw 테이블처럼 엔티티 메타데이터가 없는 대상과 조인할 때는 테이블 이름을 문자열로 그대로 넘길 수 있습니다.

```typescript
qb.leftJoin("audit_log", "al", sql`"p"."id" = "al"."post_id"`);
```

## 멀티 테이블 조인

조인을 여러 개 이어 붙이면 엔티티 그래프를 따라갈 수 있습니다.

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

## 실전: B2B 매출 리포트 (3단 조인 + 집계)

조인을 두 개 이상 쓰는 전형적인 경우는 리포트용 쿼리입니다. 예를 들어 "2026년 이후 주문 가운데 총 주문 수량이 50개를 넘는 고객을 수량 내림차순으로" 조회한다고 해 봅시다. 이 쿼리에는 조인과 집계가 함께 들어갑니다.

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

PostgreSQL과 `SnakeNamingStrategy`를 기준으로 생성되는 SQL은 다음과 같습니다.

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

`totalQty`가 쓰인 세 군데를 눈여겨볼 만합니다. TypeScript 변수 `totalQty` 하나가 SELECT에서는 `SUM(...) AS "totalQty"`가 됩니다. 반면 HAVING과 ORDER BY에서는 별칭 대신 `SUM("oi"."quantity")` 표현식이 그대로 다시 펼쳐집니다. 별칭을 다시 참조하지 않고 표현식을 풀어 쓰는 이유는 이식성입니다. 일부 데이터베이스는 HAVING에서 SELECT 별칭을 허용하지 않기 때문입니다. `o.createdAt.gte(new Date("2026-01-01"))`의 Date 값은 바인딩 파라미터 `$1`이 됩니다. 그리고 `50`은 `$2`로 바인딩됩니다. 집계의 전체 설명은 [집계 & 서브쿼리](./query-builder-aggregations.md)에 있습니다.

## 크로스 엔티티 컬럼 해석

엔티티 인식 조인이든 관계 기반 조인이든 조인한 뒤에는 어디서든 그 엔티티의 컬럼을 참조할 수 있습니다.

**`qAlias()` 스타일:**

```typescript
const u = qAlias(User, "u");
const p = qAlias(Post, "p");

// WHERE: QueryDSL 표현식 (속성 + 연산자 자동완성)
qb.where(u.name.eq("Alice"));
qb.where(u.age.gte(18));
qb.where(u.id.in([1, 2, 3]));
qb.where(u.deletedAt.isNull());
qb.where(u.email.isNotNull());
qb.where(u.age.between(18, 65));
qb.where(u.name.like("%alice%"));

// SELECT: .col()로 컬럼 참조
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

모든 참조는 별칭 레지스트리를 거쳐 해석됩니다. `SnakeNamingStrategy`를 쓰고 있다면 `u.col("firstName")`도 `u.firstName.eq(...)`도 똑같이 `"u"."first_name"`으로 변환됩니다.

## 조인 타입 요약

| 메서드 | SQL | 사용 시점 |
|--------|-----|-----------|
| `leftJoin()` | `LEFT JOIN` | 조인 대상에 매칭이 없어도 왼쪽 행을 남기고 싶을 때 |
| `innerJoin()` | `INNER JOIN` | 양쪽 모두 매칭되는 행만 필요할 때 |
| `rightJoin()` | `RIGHT JOIN` | 조인 대상의 모든 행을 남기고 싶을 때 |
| `leftJoinRelation()` | `LEFT JOIN` | `@ManyToOne` / `@OneToMany` 메타데이터로 ON 자동 생성 |
| `innerJoinRelation()` | `INNER JOIN` | 관계 메타데이터로 ON 자동 생성 |

## 다음 단계

- [QueryDSL 표현식](./query-builder-querydsl.md): `qAlias()`의 전체 연산자와 표현식
- [집계 & 서브쿼리](./query-builder-aggregations.md): 조인 위에 얹는 GROUP BY / HAVING / 서브쿼리
- [Query Builder 개요](./query-builder.md): 기본 사용법과 전체 지도
