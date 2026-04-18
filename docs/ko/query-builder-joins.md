# Query Builder — JOIN

`find()`로도 관계를 따라가며 eager load는 가능하지만, `@ManyToOne` /
`@OneToMany` / `@OneToOne`으로 선언한 경로만 탐색할 수 있어요. Query
builder는 한 발 더 나가서 — 어떤 엔티티든 (심지어 raw 테이블 이름으로도)
조인하고, 조인 경계 너머의 컬럼을 TypeScript 자동완성으로 참조하며,
관계 메타데이터가 있으면 ON 절을 아예 생략할 수 있어요. Query builder의
진가가 가장 뚜렷하게 드러나는 부분이에요.

세 단계의 JOIN을 지원해요.

> **참고** — 이 페이지에서 쓰는 컬럼 참조 헬퍼(`alias()`, `qAlias()`)의
> 전체 설명은 [QueryDSL 표현식](./query-builder-querydsl.md)에 있어요.
> 아래에서는 핵심만 다시 정리해요.

## `alias()` — 타입 안전한 컬럼 참조

테이블을 조인하면 여러 엔티티의 컬럼을 참조하게 돼요 — `"p.authorId"`, `"u.firstName"` 등. 이런 문자열에는 자동 완성이 안 돼요. `alias()` 함수가 이걸 해결해요:

```typescript
import { alias } from "@stingerloom/orm";

const p = alias(Post, "p");
const u = alias(User, "u");

p.col("authorId");   // "p.authorId" 반환 — 자동 완성 ✓
u.col("firstName");  // "u.firstName" 반환 — 자동 완성 ✓
u.col("typo");       // ✗ 컴파일 에러 — "typo"는 User의 키가 아님
```

`alias()`는 타입이 지정된 참조를 만들어요. `.col()` 메서드의 인자가 `keyof T`로 제한되므로 TypeScript가 프로퍼티명을 자동 완성해요. 런타임에는 `"alias.property"` 문자열을 반환하고, query builder의 alias 레지스트리가 실제 DB 컬럼명으로 변환해요.

`alias()` 참조는 어디서든 쓸 수 있어요 — `where()`, `selectRaw()`, `addOrderBy()`, `whereIn()`, `JoinOnBuilder.on()` 등.

## `qAlias()` — QueryDSL 스타일 표현식

더 직관적인 API를 원한다면, `qAlias()`로 엔티티 프로퍼티에 직접 접근하고 조건 메서드를 체이닝할 수 있어요 — JPA QueryDSL의 `QUser` 클래스와 비슷하지만, 코드 생성이 필요 없어요.

```typescript
import { qAlias } from "@stingerloom/orm";

const u = qAlias(User, "u");
const p = qAlias(Post, "p");

const posts = await em
  .createQueryBuilder(Post, "p")
  .leftJoin(User, "u", (j) => j.on(p.col("authorId"), "=", u.col("id")))
  .where(u.firstName.eq("Alice"))           // u.firstName 자동 완성 ✓
  .where(u.age.gte(18))                     // .gte() → >= 연산자
  .where(p.status.in(["active", "draft"]))  // .in() → IN (...)
  .where(u.deletedAt.isNull())              // .isNull() → IS NULL
  .getRawMany();
```

모든 엔티티 프로퍼티가 `ColumnExpression`이 돼요. 전체 연산자 목록은
[QueryDSL 표현식](./query-builder-querydsl.md)에 있고, 여기선 짧게:

| Method | SQL | 예시 |
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

각 메서드는 `ColumnCondition`을 반환하고, query builder가 alias 레지스트리를 통해 해석해요 — SnakeNamingStrategy도 완벽하게 지원해요.

`qAlias()`는 `alias()`의 `.col()`도 지원하므로, 스타일을 섞어 쓸 수 있어요:

```typescript
const u = qAlias(User, "u");
qb.where(u.firstName.eq("Alice"))     // QueryDSL 스타일
  .addOrderBy(u.col("lastName"), "ASC") // alias() 스타일 — 둘 다 동작
```

## Entity-Aware Join (추천)

테이블 조인의 가장 좋은 방법은 **엔티티 클래스**를 직접 전달하는 거예요. ORM이 테이블명을 자동으로 해석하고, `alias()`로 camelCase 프로퍼티명을 자동 완성할 수 있어요.

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

- `leftJoin(User, "u", ...)` — 첫 번째 인자가 **엔티티 클래스**예요. ORM이 실제 테이블명(`user`)을 자동 해석하고, `"u"` alias를 내부 레지스트리에 등록해요.
- `join.on(p.col("authorId"), "=", u.col("id"))` — ON 조건에서 **타입이 지정된 프로퍼티 참조**를 사용해요. `SnakeNamingStrategy` 사용 시 `authorId` → `author_id`로 자동 변환돼요.
- `selectRaw([p.col("title"), u.col("name")])` — 자동 완성이 되는 크로스 엔티티 컬럼 선택이에요.
- `where(u.col("age"), ">=", 18)` — WHERE 조건에서도 조인된 엔티티의 컬럼을 자동 완성으로 참조할 수 있어요.

::: tip
자동 완성 없이 문자열로 직접 작성할 수도 있어요 — `where("u.age", ">=", 18)`. 런타임에서 두 형태는 동일해요.
:::

`JoinOnBuilder` 콜백은 여러 조건과 리터럴 값을 지원해요:

```typescript
qb.leftJoin(User, "u", (join) =>
  join
    .on(p.col("authorId"), "=", u.col("id"))       // 컬럼 = 컬럼
    .andOn(u.col("status"), "=", p.col("status"))   // 추가 조건
    .onVal(u.col("isActive"), "=", true)             // 컬럼 = 리터럴 값
);
```

## Relation 기반 Join (ON 자동 생성)

`@ManyToOne` / `@OneToMany` / `@OneToOne` 데코레이터가 있으면 ON 조건을 생략할 수 있어요. ORM이 relation 메타데이터에서 자동으로 생성해요.

```typescript
// Post에 @ManyToOne(() => User) author: User; 가 있다면

const posts = await em
  .createQueryBuilder(Post, "p")
  .leftJoinRelation("author", "u")     // 자동: ON p.author_id = u.id
  .where("u.name", "LIKE", "%John%")
  .getMany();
```

양방향 모두 동작해요:

```typescript
// User에 @OneToMany(() => Post, { mappedBy: "author" }) posts: Post[]; 가 있다면

const users = await em
  .createQueryBuilder(User, "u")
  .leftJoinRelation("posts", "p")      // 자동: ON u.id = p.author_id
  .where("p.status", "published")
  .getMany();
```

`innerJoinRelation()`도 사용할 수 있어요.

## JoinAndSelect — Join + 자동 SELECT

조인된 엔티티의 모든 컬럼을 결과에 포함하고 싶을 때 `*AndSelect` 변형을 사용하세요. 조인 + 모든 컬럼 수동 선택을 한 번에 해줘요.

```typescript
// 수동: join + selectRaw
qb.leftJoin(User, "u", (j) => j.on("p.authorId", "=", "u.id"))
  .selectRaw(["p.id", "p.title", "u.id", "u.name", "u.email"]);

// 자동: joinAndSelect
const results = await em
  .createQueryBuilder(Post, "p")
  .leftJoinAndSelect(User, "u", (j) => j.on("p.authorId", "=", "u.id"))
  .where("p.status", "published")
  .getRawMany();
```

모든 `*AndSelect` 변형:

| Method | 설명 |
|--------|------|
| `leftJoinAndSelect(Entity, alias, onBuilder)` | LEFT JOIN + 조인된 컬럼 자동 SELECT |
| `innerJoinAndSelect(Entity, alias, onBuilder)` | INNER JOIN + 조인된 컬럼 자동 SELECT |
| `leftJoinRelationAndSelect(property, alias)` | Relation LEFT JOIN + 자동 SELECT |
| `innerJoinRelationAndSelect(property, alias)` | Relation INNER JOIN + 자동 SELECT |

Relation 기반 예제:

```typescript
const results = await em
  .createQueryBuilder(Post, "p")
  .leftJoinRelationAndSelect("author", "u")
  .getRawMany();
```

## String 기반 Join (Raw)

엔티티 메타데이터가 없는 경우(view, 서브쿼리, raw 테이블 조인)에는 여전히 문자열 테이블명을 전달할 수 있어요.

```typescript
qb.leftJoin("audit_log", "al", sql`"p"."id" = "al"."post_id"`);
```

## 멀티 테이블 Join

여러 조인을 체이닝해서 엔티티 그래프를 탐색할 수 있어요:

```typescript
const p = qAlias(Post, "p");
const u = qAlias(User, "u");
const c = qAlias(Comment, "c");

const results = await em
  .createQueryBuilder(Post, "p")
  .leftJoin(User, "u", (j) => j.on(p.col("authorId"), "=", u.col("id")))
  .leftJoin(Comment, "c", (j) => j.on(c.col("postId"), "=", p.col("id")))
  .selectRaw([p.col("title"), u.col("name"), c.col("content")])
  .where(u.age.gte(18))                   // QueryDSL 스타일
  .where(c.content.isNotNull())            // QueryDSL 스타일
  .addOrderBy(u.col("name"), "ASC")
  .limit(50)
  .getRawMany();
```

## Cross-Entity 컬럼 해석

엔티티 조인(entity-aware 또는 relation 기반) 후, 어디서든 컬럼을 참조할 수 있어요.

**`qAlias()` 사용 (QueryDSL 스타일):**

```typescript
const u = qAlias(User, "u");
const p = qAlias(Post, "p");

// WHERE — QueryDSL 표현식 (프로퍼티 + 연산자 자동 완성)
qb.where(u.name.eq("Alice"));                     // equals
qb.where(u.age.gte(18));                           // >=
qb.where(u.id.in([1, 2, 3]));                     // IN
qb.where(u.deletedAt.isNull());                   // IS NULL
qb.where(u.email.isNotNull());                    // IS NOT NULL
qb.where(u.age.between(18, 65));                  // BETWEEN
qb.where(u.name.like("%alice%"));                 // LIKE

// SELECT — .col()로 컬럼 참조
qb.selectRaw([p.col("title"), u.col("name")]);
qb.addSelect(u.col("email"), "authorEmail");

// ORDER BY / GROUP BY
qb.addOrderBy(u.col("name"), "ASC");
qb.groupBy([u.col("id"), p.col("category")]);
```

**`alias()` 사용 (.col() 스타일):**

```typescript
const u = alias(User, "u");
qb.where(u.col("name"), "Alice");
qb.where(u.col("age"), ">=", 18);
```

모든 참조는 alias 레지스트리를 통해 해석돼요 — `u.col("firstName")` 또는 `u.firstName.eq(...)` 모두 `SnakeNamingStrategy` 사용 시 `"u"."first_name"`으로 변환돼요.

## Join 타입 요약

| Method | SQL | 언제 쓰나요 |
|--------|-----|-------------|
| `leftJoin()` | `LEFT JOIN` | 조인 테이블에 매칭이 없어도 행을 포함할 때 |
| `innerJoin()` | `INNER JOIN` | 양쪽 테이블 모두 매칭되는 행만 필요할 때 |
| `rightJoin()` | `RIGHT JOIN` | 조인 테이블의 모든 행을 포함할 때 |
| `leftJoinRelation()` | `LEFT JOIN` | `@ManyToOne` / `@OneToMany` 메타데이터로 ON 자동 생성 |
| `innerJoinRelation()` | `INNER JOIN` | relation 메타데이터로 ON 자동 생성 |

## 다음 단계

- [QueryDSL 표현식](./query-builder-querydsl.md) — `qAlias()`의 전체 연산자 표현
- [집계 & 서브쿼리](./query-builder-aggregations.md) — 조인된 엔티티 위에서의 GROUP BY / HAVING / 서브쿼리
- [Query Builder 개요](./query-builder.md) — 기본 사용법과 전체 지도
