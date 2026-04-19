# Query Builder — 편의 패턴

서비스 레이어에서 쿼리 빌더를 쓰다 보면 같은 모양의 코드가 반복됩니다. 크게 세 가지예요.

- 선택적 필터를 `if` 블록으로 감싸기
- 같은 조건을 여러 메서드에서 복사-붙여넣기
- 관련 데이터의 존재 여부로 걸러내기

이 페이지는 그 세 가지 반복을 정확히 겨냥한 헬퍼를 모아 놨습니다 — 조건부 빌딩(`when`), 합성 가능한 변환(`pipe` / `scope`), 관계 기반 쿼리(`whereHas` / `withCount`), 서브쿼리 통합(`whereInSubquery` 등).

## 조건부 빌딩 — `when()`

쿼리 빌더에서 가장 흔한 보일러플레이트가 선택적 필터용 `if/else` 블록입니다. `when()`이 이걸 없애 줘요.

```typescript
when(condition, fn)         // condition이 truthy면 fn 호출
when(condition, fn, elseFn) // truthy면 fn, falsy면 elseFn
```

condition은 boolean도 되고 지연 평가 함수 `() => boolean`도 됩니다.

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .when(!!searchName, (qb) =>
    qb.where("name", "LIKE", `%${searchName}%`)
  )
  .when(onlyActive, (qb) => qb.where("status", "active"))
  .when(sortByAge,
    (qb) => qb.orderBy({ age: "ASC" }),
    (qb) => qb.orderBy({ createdAt: "DESC" }),  // else 분기
  )
  .getMany();
```

`when()`은 어떤 분기가 실행되든 `this`를 돌려주니, 체이닝이 끊기지 않습니다.

## 그룹 조건 — `andWhereGroup()` / `orWhereGroup()`

`WHERE status = 'active' OR (role = 'admin' AND verified = true)` 같은 괄호 그룹이 필요할 때가 있죠. 그룹 없이는 연산자 우선순위가 틀어집니다. `andWhereGroup()`과 `orWhereGroup()`이 이걸 해결해요.

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
// AND 그룹: 그룹 안의 조건들이 AND로 묶임
qb.where("active", true)
  .andWhereGroup((g) =>
    g.where("age", ">=", 18)
     .where("role", "user")
  );
// WHERE "active" = true AND ("age" >= 18 AND "role" = 'user')
```

그룹 빌더는 메인 빌더와 같은 WHERE 헬퍼를 전부 지원합니다 — `whereIn()`, `whereNull()`, `whereNotNull()`, `whereBetween()`, `whereLike()`.

## 재사용 가능한 변환 — `pipe()`

`pipe()`로 쿼리 로직을 독립 함수로 꺼내 합성할 수 있습니다.

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

서비스 코드를 DRY하게 유지하는 강력한 패턴입니다. 프로젝트의 공통 쿼리 로직을 한 번 정의해 두고 어디서든 `pipe()`로 가져다 쓰세요.

## 관계 기반 쿼리

### `whereHas()` / `whereNotHas()` — 관계 존재 필터

`whereHas()`는 엔티티의 관계 메타데이터에서 `EXISTS` 서브쿼리를 자동으로 만들어 줍니다. 수동 SQL이 필요 없어요.

```typescript
// 댓글이 달린 게시글만
const posts = await em
  .createQueryBuilder(Post, "p")
  .whereHas("comments")
  .getMany();
// WHERE EXISTS (SELECT 1 FROM comment WHERE comment.post_id = p.id)
```

콜백으로 관련 엔티티에 조건을 얹을 수도 있습니다.

```typescript
// 최근 일주일 안에 댓글이 달린 게시글
const posts = await em
  .createQueryBuilder(Post, "p")
  .whereHas("comments", (sub) =>
    sub.where("createdAt", ">=", sevenDaysAgo)
  )
  .getMany();
```

`whereNotHas()`는 `NOT EXISTS`를 생성합니다.

```typescript
// 댓글이 없는 게시글
const drafts = await em
  .createQueryBuilder(Post, "p")
  .whereNotHas("comments")
  .getMany();
```

`@ManyToOne`, `@OneToMany`, `@OneToOne` 관계를 지원합니다. 상관 조건은 데코레이터 메타데이터에서 자동으로 풀립니다.

> **주의** — `@ManyToMany`는 `whereHas` / `whereNotHas` 대상에서 빠져 있습니다. `OrmError`가 나니, M2M에는 `leftJoinRelation` + `whereIn`이나 중간 테이블 직접 조인으로 우회하세요.

### `withCount()` — 관계 카운트 컬럼

SELECT 절에 관계 카운트를 스칼라 서브쿼리로 얹습니다.

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .withCount("posts")                // 기본 별칭: "posts_count"
  .withCount("posts", "activeCount", (sub) =>
    sub.where("status", "published") // published만 카운트
  )
  .orderBy({ posts_count: "DESC" } as any)
  .getRawMany();
// SELECT "u".*, (SELECT COUNT(*) FROM post ...) AS "posts_count", ...
```

`orderBy`의 `as any`가 신경 쓰이는 데는 이유가 있습니다. `posts_count`는 엔티티 프로퍼티가 아니라 런타임에 붙는 파생 컬럼이라 `keyof User` 자동완성 대상이 아니거든요. `withCount` 결과로 정렬하려면 `as any`를 달거나, 아래처럼 raw 정렬 + `getRawMany()` 조합이 타입 측면에서 더 깔끔합니다.

```typescript
import sql from "sql-template-tag";

qb.withCount("posts")
  .addOrderBy(sql`"posts_count"`, "DESC");
```

### `loadRelation()` — 간결한 관계 로딩

`leftJoinRelationAndSelect()`의 단축어예요. 두 번째 인자로 별칭을 지정할 수 있고, 생략하면 관계 이름이 그대로 별칭이 됩니다.

```typescript
// 원래 형태
qb.leftJoinRelationAndSelect("author", "author")
  .leftJoinRelationAndSelect("comments", "comments");

// 단축
qb.loadRelation("author").loadRelation("comments");

// 같은 관계를 두 각도로 조인해야 하면 별칭 필수
qb.loadRelation("posts", "recentPosts")
  .loadRelation("posts", "draftPosts");
```

## 서브쿼리 통합

### `whereInSubquery()` / `whereNotInSubquery()`

`SelectQueryBuilder`를 `WHERE IN` 서브쿼리로 씁니다.

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

`SelectQueryBuilder`를 `EXISTS` 서브쿼리로 씁니다.

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

### `addSelectSubquery()` — SELECT 절 스칼라 서브쿼리

상관 서브쿼리를 계산 컬럼으로 얹습니다.

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

## Scope — 이름 붙은 쿼리 조각

엔티티에 static 프로퍼티로 스코프를 정의할 수 있습니다.

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

`applyScope()`로 적용합니다.

```typescript
const users = await repo
  .createQueryBuilder("u")
  .applyScope("active")
  .applyScope("recent")
  .getMany();
```

스코프는 다른 빌더 메서드와도 자유롭게 섞입니다 — `where()`, `when()`, `pipe()`, `whereHas()` 전부. 본질적으로는 쿼리 빌더를 받는 함수일 뿐이에요. `pipe()`가 "일회용 함수"라면 스코프는 "엔티티에 붙어 있는, 이름 붙은 `pipe`"라고 보면 됩니다.

없는 스코프 이름으로 `applyScope()`를 호출하면 사용 가능한 스코프 목록과 함께 `OrmError`가 발생합니다.

### 실전 — 워커 큐에서 안전하게 한 건 집기

스코프를 잠금과 합치면 백그라운드 워커 패턴이 한 줄로 정리됩니다. `forUpdateSkipLocked()`는 다른 워커가 잠근 행을 건너뛰니까, 여러 워커가 경합 없이 같은 테이블에서 작업을 꺼내 쓸 수 있어요.

```typescript
@Entity()
class Job {
  @PrimaryGeneratedColumn() id!: number;
  @Column() status!: string;
  @Column() createdAt!: Date;

  static scopes = {
    pending: (qb: SelectQueryBuilder<Job>) =>
      qb.where("status", "pending").orderBy({ createdAt: "ASC" }),
  };
}

async function claimNext(): Promise<Job | null> {
  return em.createQueryBuilder(Job, "j")
    .applyScope("pending")
    .limit(1)
    .forUpdateSkipLocked()        // 잠긴 행은 건너뜀 → 경합 제로
    .getOne();
}
```

트랜잭션 안에서 실행해야 잠금이 의미가 있습니다. 잠금 옵션의 드라이버 호환성은 [실행 & 결과 → NOWAIT과 SKIP LOCKED](./query-builder-execution.md#nowait과-skip-locked)를 보세요.

## 다음 단계

- [실행 & 결과](./query-builder-execution.md) — 페이지네이션, 잠금, 검증, `prepare()`
- [QueryDSL 표현식](./query-builder-querydsl.md) — 타입드 조건 / 프로젝션 레퍼런스
- [Raw SQL & CTE](./raw-sql.md) — UNION, 재귀 CTE, DISTINCT ON
- [페이지네이션 & 스트리밍](./pagination.md) — 커서 / 오프셋 / 스트림 전략
- [EntityManager](./entity-manager.md) — 빌더 바깥의 일상 CRUD
- [Query Builder 개요](./query-builder.md) — 전체 지도로 돌아가기
