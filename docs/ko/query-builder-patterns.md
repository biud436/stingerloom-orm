# 쿼리 빌더: 편의 패턴

서비스 레이어에서 쿼리 빌더를 쓰다 보면 같은 모양의 코드가 반복됩니다. 크게 세 가지입니다.

- 선택적 필터를 `if` 블록으로 감싸기
- 같은 조건을 여러 메서드에서 복사-붙여넣기
- 관련 데이터의 존재 여부로 걸러내기

Stingerloom의 쿼리 빌더에는 이런 반복을 줄이는 헬퍼가 있습니다. 조건부 빌딩(`when`), 합성할 수 있는 변환(`pipe` / `scope`), 관계 기반 쿼리(`whereHas` / `withCount`), 서브쿼리 통합(`whereInSubquery` 등)이 그 예입니다.

## 조건부 빌딩: `when()`

쿼리 빌더에서 가장 흔한 보일러플레이트는 선택적 필터용 `if/else` 블록입니다. `when()`을 쓰면 이 블록이 필요 없습니다.

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

`when()`은 어떤 분기가 실행되든 `this`를 반환합니다. 그래서 체이닝이 끊기지 않습니다.

## 그룹 조건: `andWhereGroup()` / `orWhereGroup()`

`WHERE status = 'active' OR (role = 'admin' AND verified = true)` 같은 괄호 그룹이 필요할 때가 있습니다. 그룹이 없으면 연산자 우선순위가 틀어집니다. `andWhereGroup()`과 `orWhereGroup()`이 이 문제를 해결합니다.

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

그룹 빌더는 `whereIn()`, `whereNull()`, `whereNotNull()`, `whereBetween()`, `whereLike()` 등 메인 빌더와 같은 WHERE 헬퍼를 모두 지원합니다.

## 재사용 가능한 변환: `pipe()`

`pipe()`를 쓰면 쿼리 로직을 독립 함수로 꺼내 합성할 수 있습니다.

```typescript
// 재사용 가능한 변환 정의
function withPagination<T>(page: number, size: number) {
  return (qb: SelectQueryBuilder<T>) =>
    qb.offset((page - 1) * size).limit(size);
}

function withActiveFilter<T>(qb: SelectQueryBuilder<T>) {
  return qb.where("deletedAt", null);
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

### `whereHas()` / `whereNotHas()`: 관계 존재 필터

`whereHas()`는 엔티티의 관계 메타데이터에서 `EXISTS` 서브쿼리를 자동으로 만듭니다. SQL을 직접 쓸 필요가 없습니다.

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

`@ManyToOne`, `@OneToMany`, `@OneToOne` 관계를 지원합니다. 상관 조건은 데코레이터 메타데이터에서 자동으로 만들어집니다.

관련 엔티티에 `@DeletedAt`이 있으면 소프트 삭제된 행은 서브쿼리에서 제외됩니다. 그래서 댓글이 모두 소프트 삭제된 게시물은 `whereHas("comments")`에 걸리지 않습니다. 이 필터를 걷어내려면 `whereHas()`를 호출하기 전에 빌더에서 `withDeleted()`를 호출하세요. 그 관계에서만 걷어내려면 콜백에서 `sub.withDeleted()`를 호출하면 됩니다. `withCount()`도 같은 규칙을 따릅니다.

> 주의: `@ManyToMany`는 `whereHas` / `whereNotHas`의 대상이 아닙니다. `@ManyToMany` 관계를 넘기면 `OrmError`를 던집니다. `@ManyToMany` 관계는 조인 테이블을 문자열 조인으로 직접 연결하거나 `whereInSubquery()`로 풀어 쓰세요. `leftJoinRelation`도 `@ManyToMany`를 지원하지 않습니다([관계 조인](./query-builder-joins.md)).

### `withCount()`: 관계 카운트 컬럼

관계 카운트를 스칼라 서브쿼리로 SELECT 절에 추가합니다.

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .withCount("posts")                // 기본 별칭: "posts_count"
  .withCount("posts", "activeCount", (sub) =>
    sub.where("status", "published") // published만 카운트
  )
  .appendSql(sql`ORDER BY "posts_count" DESC`)
  .getRawMany();
// SELECT "u".*, (SELECT COUNT(*) FROM post ...) AS "posts_count", ...
```

카운트 별칭은 SELECT 목록에만 있는 컬럼이고 엔티티 속성이 아닙니다. `orderBy({ posts_count: "DESC" })`로 정렬하면 키가 FROM 별칭으로 한정되어 `"u"."posts_count"`가 됩니다. 이 컬럼은 존재하지 않으므로 데이터베이스가 쿼리를 거부합니다. 대신 한 단계 낮은 `appendSql(sql\`ORDER BY "alias" ...\`)`를 쓰세요. 그래야 별칭이 그대로 남습니다.

개수를 엔티티에 직접 담으려면 `find()`의 `withCount` 옵션으로 조회하세요. [관련 행 개수 세기](./relations.md#관련-행-개수-세기-withcount)를 참고하세요.

### `loadRelation()`: 간결한 관계 로딩

`leftJoinRelationAndSelect()`의 단축 메서드입니다. 두 번째 인자로 별칭을 지정할 수 있습니다. 생략하면 관계 이름이 그대로 별칭이 됩니다.

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

### `addSelectSubquery()`: SELECT 절 스칼라 서브쿼리

상관 서브쿼리를 계산 컬럼으로 추가합니다.

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

### 상관 서브쿼리: `(outer) => subQb` 팩토리

`addSelectSubquery()`, `whereExistsSubquery()`, `whereNotExistsSubquery()`는 팩토리 `(outer) => subQb`도 받습니다. `outer("alias.prop")` 리졸버는 바깥 쿼리 컬럼의 식별자를 이스케이프해서 `Sql` 조각으로 반환합니다. 그래서 서브쿼리는 타입 있는 API로 바깥 행을 참조할 수 있습니다. `sql` 문자열에 다이얼렉트별 식별자를 직접 적을 필요가 없습니다. 그리고 상관 조건 안에서도 NamingStrategy와 `@Column({ name })` 매핑이 그대로 동작합니다.

```typescript
import { qAlias } from "@stingerloom/orm";

const a = qAlias(Category, "a");

// 중첩 집합 트리에서 노드별 하위 게시글 수
const nodes = await em
  .createQueryBuilder(Category, "node")
  .addSelectSubquery(
    (outer) =>
      em.createQueryBuilder(Post, "p")
        .selectRaw(["COUNT(*)"])
        .innerJoin(Category, "a", (j) => j.on("p.categoryId", "=", "a.id"))
        // `a.lft`는 서브쿼리 자신의 별칭 레지스트리(위의 `a` 조인)에서 해석되므로
        // NamingStrategy / @Column({ name }) 매핑이 적용됩니다. `node.lft` /
        // `node.rgt`는 바깥 행에서 `outer()`로 참조합니다. 양쪽 모두 타입이 있습니다.
        .where(a.lft.between(outer("node.lft"), outer("node.rgt"))),
    "postCount",
  )
  .getRawMany();
// → (SELECT COUNT(*) FROM "post" AS "p" INNER JOIN "category" AS "a"
//      ON "p"."category_id" = "a"."CTGR_SQ"
//    WHERE "a"."LFT_NO" BETWEEN "node"."LFT_NO" AND "node"."RGT_NO") AS "postCount"
```

`outer()`는 `Sql` 조각을 반환하므로 `.between()`을 비롯한 모든 조건 값에 바로 넣을 수 있습니다. `sql` 템플릿은 필요 없습니다. `outer()`는 바깥 행의 컬럼에만 쓰세요. 서브쿼리 자신의 별칭은 그 서브쿼리의 `qAlias`로 해석하세요. 그래야 양쪽이 각자 올바른 레지스트리를 거쳐 매핑됩니다.

### 중첩 집합 트리: depth와 breadcrumb를 raw SQL 없이

같은 `onBetween()` 셀프 조인에 SELECT 절의 집계 산술을 더하면 중첩 집합의 고전적인 "depth = 조상 수 − 1" 쿼리를 타입 있는 빌더로 표현할 수 있습니다.

```typescript
const node = qAlias(Category, "node");

// 모든 노드의 depth: COUNT(조상) - 1, 노드별 그룹화
const tree = await em
  .createQueryBuilder(Category, "node")
  .select([
    node.id.as("id"),
    node.name.as("name"),
    node.name.count().sub(1).as("depth"), // COUNT("node"."CTGR_NM") - 1
  ])
  .innerJoin(Category, "parent", (j) =>
    j.onBetween("node.left", "parent.left", "parent.right"),
  )
  .groupBy(["node.left"])
  .addOrderBy("node.left", "ASC")
  .getRawMany();
```

breadcrumb 경로는 반대로 조상(`parent`)의 이름을 SELECT합니다. 조인한 별칭을 참조하는 프로젝션은 빌드할 때 해석됩니다. 그래서 `select([parent.name.as(...)])`가 `parent`를 등록하는 `innerJoin`보다 먼저 와도 됩니다.

```typescript
const parent = qAlias(Category, "parent");

const crumbs = await em
  .createQueryBuilder(Category, "node")
  .select([parent.name.as("name")])
  .innerJoin(Category, "parent", (j) =>
    j.onBetween("node.left", "parent.left", "parent.right"),
  )
  .where(node.name.eq("A1"))
  .addOrderBy("parent.left", "ASC")
  .getRawMany();
// crumbs.map((r) => r.name).join(" > ") → "Root > A > A1"
```

같은 팩토리는 `EXISTS`에서도 동작합니다.

```typescript
const usersWithBigOrders = await em
  .createQueryBuilder(User, "u")
  .whereExistsSubquery((outer) =>
    em.createQueryBuilder(Order, "o")
      .select(["id"])
      .where(sql`"o"."user_id" = ${outer("u.id")}`)
      .where("total", ">=", 100),
  )
  .getMany();
```

## Scope: 이름 붙은 쿼리 조각

스코프는 엔티티의 static 속성으로 정의합니다.

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

스코프는 `where()`, `when()`, `pipe()`, `whereHas()` 등 다른 빌더 메서드와 자유롭게 섞어 쓸 수 있습니다. 스코프는 본질적으로 쿼리 빌더를 받는 함수일 뿐입니다. `pipe()`가 일회용 함수라면 스코프는 엔티티에 붙어 있는 이름 있는 `pipe`라고 보면 됩니다.

없는 스코프 이름으로 `applyScope()`를 호출하면 사용할 수 있는 스코프 목록이 담긴 `OrmError`를 던집니다.

### 실전: 워커 큐에서 안전하게 한 건 집기

스코프를 잠금과 함께 쓰면 백그라운드 워커 패턴이 한 줄로 정리됩니다. `forUpdateSkipLocked()`는 다른 워커가 잠근 행을 건너뜁니다. 그래서 여러 워커가 경합 없이 같은 테이블에서 작업을 꺼내 쓸 수 있습니다.

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
    .forUpdateSkipLocked()        // 잠긴 행은 건너뜀 → 경합 없음
    .getOne();
}
```

이 쿼리는 트랜잭션 안에서 실행해야 잠금이 의미가 있습니다. 잠금 옵션의 드라이버 호환성은 [실행 & 결과 → NOWAIT과 SKIP LOCKED](./query-builder-execution.md#nowait과-skip-locked)를 참고하세요.

## 베이스 쿼리 복사: `clone()`

같은 베이스 쿼리에서 여러 갈래의 쿼리를 만든다면 베이스 쿼리를 한 번 만들어 두고 갈래마다 `clone()`을 씁니다.

```typescript
const base = em
  .createQueryBuilder(Order, "o")
  .where("isArchived", false)
  .leftJoinAndSelect("customer", "c");

const recent = await base.clone().where("createdAt", ">=", thirtyDaysAgo).getMany();
const flagged = await base.clone().where("flagged", true).getMany();
```

`clone()`은 얕은 복사입니다. `whereClauses`, `joinClauses` 같은 배열은 새로 만듭니다. 하지만 별칭 레지스트리와 속성/컬럼 맵은 참조를 공유합니다. 복사본에 `where`/`join`/`select`를 더 체이닝하는 것은 안전합니다. 다만 복사본에서 컬럼 메타데이터 자체를 수정하지는 마세요.

## 다음 단계

- [실행 & 결과](./query-builder-execution.md): 페이지네이션, 잠금, 검증, `prepare()`
- [QueryDSL 표현식](./query-builder-querydsl.md): 타입 있는 조건 / 프로젝션 레퍼런스
- [Raw SQL & CTE](./raw-sql.md): UNION, 재귀 CTE, DISTINCT ON
- [페이지네이션 & 스트리밍](./pagination.md): 커서 / 오프셋 / 스트림 전략
- [EntityManager](./entity-manager.md): 빌더 밖에서 하는 일상적인 CRUD
- [Query Builder 개요](./query-builder.md): 전체 지도로 돌아가기
