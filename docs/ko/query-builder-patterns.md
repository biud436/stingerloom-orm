# Query Builder — 편의 패턴

이 페이지는 Stingerloom query builder를 차별화하는 헬퍼들을 모아놨어요
— 조건부 빌딩, 그룹 조건, 합성 가능한 변환, relation 기반 쿼리,
subquery 통합, 재사용 가능한 scope까지.

## 조건부 빌딩 — `when()`

Query builder에서 가장 흔한 보일러플레이트는 선택적 필터를 위한 `if/else` 블록이에요. `when()`이 이걸 없애줘요:

```typescript
when(condition, fn)         // condition이 truthy면 fn 호출
when(condition, fn, elseFn) // truthy면 fn, falsy면 elseFn 호출
```

condition은 boolean이나 lazy 함수 `() => boolean` 모두 가능해요:

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .when(!!searchName, (qb) =>
    qb.where("name", "LIKE", `%${searchName}%`)
  )
  .when(onlyActive, (qb) => qb.where("status", "active"))
  .when(sortByAge,
    (qb) => qb.orderBy({ age: "ASC" }),
    (qb) => qb.orderBy({ createdAt: "DESC" }),  // else
  )
  .getMany();
```

`when()`은 항상 `this`를 반환하므로 어떤 분기가 실행되든 체이닝이 이어져요.

## 그룹 조건 — `andWhereGroup()` / `orWhereGroup()`

`WHERE status = 'active' OR (role = 'admin' AND verified = true)` 같은 괄호 그룹이 필요할 때가 있어요. 그룹 없이는 연산자 우선순위가 틀어져요. `andWhereGroup()`과 `orWhereGroup()`이 이걸 해결해요:

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .where("status", "active")
  .orWhereGroup((g) =>
    g.where("role", "admin").where("verified", true)
  )
  .getMany();
// WHERE "status" = 'active' OR ("role" = 'admin' AND "verified" = true)
```

```typescript
// AND 그룹: 그룹 안의 모든 조건이 AND로 결합돼요
qb.where("active", true)
  .andWhereGroup((g) =>
    g.where("age", ">=", 18)
     .where("role", "user")
  );
// WHERE "active" = true AND ("age" >= 18 AND "role" = 'user')
```

그룹 빌더는 메인 빌더와 같은 WHERE 헬퍼를 지원해요: `whereIn()`, `whereNull()`, `whereNotNull()`, `whereBetween()`, `whereLike()`.

## 재사용 가능한 변환 — `pipe()`

`pipe()`로 재사용 가능한 쿼리 로직을 독립 함수로 추출하고 합성할 수 있어요:

```typescript
// 재사용 가능한 변환 정의
function withPagination<T>(page: number, size: number) {
  return (qb: SelectQueryBuilder<T>) =>
    qb.offset((page - 1) * size).limit(size);
}

function withActiveFilter<T>(qb: SelectQueryBuilder<T>) {
  return qb.where("deletedAt", "IS NULL", null);
}

// 합성해서 사용
const users = await repo
  .createQueryBuilder("u")
  .pipe(withActiveFilter)
  .pipe(withPagination(2, 20))
  .getMany();
```

서비스 코드를 DRY하게 유지하는 데 강력한 패턴이에요. 프로젝트의 공통 쿼리 패턴을 한 번 정의하고, 어디서든 `pipe()`로 사용하세요.

## Relation 기반 쿼리

### `whereHas()` / `whereNotHas()` — Relation 존재 필터

`whereHas()`는 엔티티의 relation 메타데이터로부터 `EXISTS` 서브쿼리를 자동 생성해요. 수동 SQL 불필요:

```typescript
// 댓글이 있는 게시글만
const posts = await em
  .createQueryBuilder(Post, "p")
  .whereHas("comments")
  .getMany();
// WHERE EXISTS (SELECT 1 FROM comment WHERE comment.post_id = p.id)
```

콜백으로 관련 엔티티에 조건을 추가할 수 있어요:

```typescript
// 최근 댓글이 있는 게시글
const posts = await em
  .createQueryBuilder(Post, "p")
  .whereHas("comments", (sub) =>
    sub.where("createdAt", ">=", sevenDaysAgo)
  )
  .getMany();
```

`whereNotHas()`는 `NOT EXISTS`를 생성해요:

```typescript
// 댓글이 없는 게시글
const drafts = await em
  .createQueryBuilder(Post, "p")
  .whereNotHas("comments")
  .getMany();
```

`@ManyToOne`, `@OneToMany`, `@OneToOne` relation 모두 지원해요. 상관 조건은 데코레이터 메타데이터에서 자동으로 해석돼요.

### `withCount()` — Relation 카운트 컬럼

SELECT절에 relation 카운트를 스칼라 서브쿼리로 추가해요:

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .withCount("posts")                // 기본 alias: "posts_count"
  .withCount("posts", "activeCount", (sub) =>
    sub.where("status", "published") // published만 카운트
  )
  .orderBy({ posts_count: "DESC" } as any)
  .getRawMany();
// SELECT "u".*, (SELECT COUNT(*) FROM post ...) AS "posts_count", ...
```

### `loadRelation()` — 간편한 Relation 로딩

`leftJoinRelationAndSelect()`의 간결한 단축어예요:

```typescript
// 대신:
qb.leftJoinRelationAndSelect("author", "author")
  .leftJoinRelationAndSelect("comments", "comments");

// 이렇게:
qb.loadRelation("author").loadRelation("comments");
```

## Subquery 통합

### `whereInSubquery()` / `whereNotInSubquery()`

`SelectQueryBuilder`를 `WHERE IN` 서브쿼리로 사용해요:

```typescript
const activeUserIds = em
  .createQueryBuilder(User, "u2")
  .select(["id"])
  .where("status", "active");

const posts = await em
  .createQueryBuilder(Post, "p")
  .whereInSubquery("authorId", activeUserIds)
  .getMany();
// WHERE "p"."author_id" IN (SELECT "u2"."id" FROM "user" AS "u2" WHERE ...)
```

### `whereExistsSubquery()` / `whereNotExistsSubquery()`

`SelectQueryBuilder`를 `EXISTS` 서브쿼리로 사용해요:

```typescript
const correlated = em
  .createQueryBuilder(Order, "o")
  .select(["id"])
  .where(sql`"o"."user_id" = "u"."id"`)
  .where("total", ">=", 100);

const bigSpenders = await em
  .createQueryBuilder(User, "u")
  .whereExistsSubquery(correlated)
  .getMany();
```

### `addSelectSubquery()` — SELECT절 스칼라 서브쿼리

상관 서브쿼리를 계산 컬럼으로 추가해요:

```typescript
const latestComment = em
  .createQueryBuilder(Comment, "c")
  .select(["content"])
  .where(sql`"c"."post_id" = "p"."id"`)
  .orderBy({ createdAt: "DESC" })
  .limit(1);

const posts = await em
  .createQueryBuilder(Post, "p")
  .addSelectSubquery(latestComment, "latestComment")
  .getRawMany();
// SELECT "p".*, (SELECT ... LIMIT 1) AS "latestComment" FROM ...
```

## Scopes — 재사용 가능한 쿼리 조각

엔티티에 static 프로퍼티로 named scope를 정의해요:

```typescript
@Entity()
class User {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar" }) name!: string;
  @Column({ type: "varchar" }) status!: string;

  static scopes = {
    active: (qb: SelectQueryBuilder<User>) =>
      qb.where("status", "active"),
    recent: (qb: SelectQueryBuilder<User>) =>
      qb.orderBy({ createdAt: "DESC" }).limit(10),
    verified: (qb: SelectQueryBuilder<User>) =>
      qb.where("emailVerified", true),
  };
}
```

`applyScope()`로 적용해요:

```typescript
const users = await repo
  .createQueryBuilder("u")
  .applyScope("active")
  .applyScope("recent")
  .getMany();
```

Scope는 다른 모든 빌더 메서드와 합성돼요 — `where()`, `when()`, `pipe()`, `whereHas()` 등. 본질적으로 query builder를 받는 함수일 뿐이에요.

존재하지 않는 scope 이름으로 `applyScope()`를 호출하면 사용 가능한 scope 목록과 함께 `OrmError`가 발생해요.

## 다음 단계

- [실행 & 결과](./query-builder-execution.md) — 페이지네이션, 잠금, 검증, `prepare()`
- [QueryDSL 표현식](./query-builder-querydsl.md) — 타입드 조건 / 프로젝션 표현
- [Query Builder 개요](./query-builder.md) — 기본 사용법과 전체 지도
