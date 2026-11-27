# Query Builder — 실행 & 결과

쿼리의 모양을 다 잡고 나면 실행과 결과 처리가 남습니다. 여기에 영향을 주는 것은 정렬, 페이지네이션, 비관적 잠금, 인덱스 힌트, 소프트 삭제 처리, 런타임 결과 검증입니다. 실행 메서드의 세 단계(`getMany` / `getPartialMany` / `getRawMany`)와 반복 쿼리의 컴파일도 여기에 속합니다.

## ORDER BY와 페이지네이션

정렬과 페이지네이션은 예상대로 동작합니다.

```typescript
// 타입 안전 ORDER BY: 컬럼 이름 자동 완성
qb.orderBy({ createdAt: "DESC", name: "ASC" });

// LIMIT / OFFSET
qb.limit(10).offset(20);

// skip / take: 같은 의미의 별칭
qb.skip(20).take(10);
```

데이터와 전체 개수가 함께 필요하면 `getManyAndCount()`를 씁니다. 이 메서드는 데이터 쿼리를 실행한 다음 카운트 쿼리를 실행하고 `[T[], number]`를 반환합니다. 두 쿼리를 차례로 실행하므로 연결이 하나뿐인 SQLite에서도 안전합니다.

```typescript
const [users, total] = await em
  .createQueryBuilder(User, "u")
  .where("isActive", true)
  .orderBy({ createdAt: "DESC" })
  .skip(20)
  .take(10)
  .getManyAndCount();

console.log(users.length); // 최대 10
console.log(total);        // 예: 235
```

### `paginate()` — 페이지 데이터와 메타데이터를 한 번에

`getManyAndCount()`는 `[rows, total]` 튜플만 반환합니다. 그래서 `totalPages`나
`hasNextPage` 같은 값은 엔드포인트마다 직접 계산해야 합니다. `paginate()`는
[`em.findWithPage()`](./pagination.md)의 쿼리 빌더 버전입니다. 1부터 시작하는 `page`와
`pageSize`를 넘기면 페이지 데이터와 함께 페이지네이션 메타데이터 전체를 반환합니다.

```typescript
const result = await em
  .createQueryBuilder(Post, "p")
  .leftJoin(User, "u", (j) => j.on("p.authorId", "=", "u.id"))
  .where("p.status", "published")
  .orderBy({ createdAt: "DESC" })
  .paginate({ page: 2, pageSize: 10 });

result.data;            // 2페이지의 Post[] (클래스 인스턴스)
result.total;           // 조건에 맞는 전체 행 수: LIMIT/OFFSET 무시
result.page;            // 2
result.pageSize;        // 10
result.totalPages;      // Math.ceil(total / pageSize)
result.hasNextPage;     // page < totalPages
result.hasPreviousPage; // page > 1
```

`page`/`pageSize`는 `findWithPage()`와 똑같이 정규화됩니다. 0 이하의 값이나 소수 값은
보정됩니다(기본값: `page` 1, `pageSize` 20). 빌더에 미리 설정한
`limit`/`offset`/`skip`/`take`는 페이지 윈도로 덮어씁니다. 하지만 원본 빌더는 바뀌지
않습니다. LIMIT/OFFSET은 복제본에 적용되기 때문입니다. 그래서 같은 인스턴스를 다시
페이지로 나누거나 재사용해도 됩니다.

특정 컬럼만 뽑는 목록 화면에서는 `paginatePartial()`을 쓰세요. 동작은 `paginate()`와 같습니다.
다만 `getPartialMany()`로 plain `Pick<T, K>` 객체를 반환합니다. 그래서 필수 컬럼을 빠뜨린
부분 `select()`도 허용됩니다. `getMany()` 기반인 `paginate()`는 이런 `select()`를 거부합니다.

```typescript
const page = await em
  .createQueryBuilder(Post, "p")
  .select(["id", "title"])
  .orderBy({ id: "DESC" })
  .paginatePartial({ page: 1, pageSize: 20 });

page.data; // Pick<Post, "id" | "title">[]: 엔티티가 아닌 plain object
```

> 커서 기반 페이지네이션, 스트리밍, 전략 선택 가이드는 [페이지네이션 & 스트리밍](./pagination.md)에 있습니다.

### `getCursor()` — 빌더에서 커서(키셋) 페이지네이션

`getCursor()`는 [`em.findWithCursor()`](./pagination.md#cursor-based-pagination)의 쿼리 빌더 버전입니다. 빌더에 이미 조립된 쿼리에 키셋 페이지네이션을 적용하고 `CursorPaginationResult`를 반환합니다. WHERE 절, JOIN, 소프트 삭제 필터, 테넌트 범위가 모두 그대로 적용됩니다.

```typescript
interface CursorPaginationOption<T> {
  take?:      number;               // 페이지 크기 (기본값: 20)
  cursor?:    string;               // 이전 페이지의 cursor (첫 페이지는 생략)
  orderBy?:   keyof T & string;     // 정렬 컬럼: 엔티티 속성 이름 (기본값: 엔티티 기본 키)
  direction?: "ASC" | "DESC";       // 정렬 방향 (기본값: "ASC")
  // relations?: string[]은 findWithCursor 전용: getCursor()에 넘기면 InvalidQueryError
  // 빌더에서는 leftJoinRelationAndSelect()로 관계를 선언하세요
}

interface CursorPaginationResult<T> {
  data:        T[];
  hasNextPage: boolean;
  nextCursor:  string | null;  // Base64로 인코딩됨. hasNextPage가 false면 null
  count:       number;         // 현재 페이지 항목 수 (전체 수가 아님)
}
```

**기본 예제: 첫 페이지와 다음 페이지**

```typescript
// 첫 페이지
const first = await em
  .createQueryBuilder(Post, "p")
  .where("p.status", "published")
  .getCursor({ take: 20, orderBy: "id", direction: "ASC" });

first.data;        // Post[]: 최대 20개 행
first.hasNextPage; // 21번째 행이 존재하면 true
first.nextCursor;  // 다음 호출에 그대로 전달할 불투명한 Base64 문자열
first.count;       // 현재 페이지 반환 항목 수 (최대 20)

// 다음 페이지: cursor만 넘기고 나머지 빌더는 그대로 유지
if (first.hasNextPage) {
  const second = await em
    .createQueryBuilder(Post, "p")
    .where("p.status", "published")
    .getCursor({ take: 20, cursor: first.nextCursor! });
}
```

**전체 페이지를 순회하는 루프**

```typescript
let cursor: string | undefined;

do {
  const page = await em
    .createQueryBuilder(Post, "p")
    .where("p.status", "published")
    .orderBy({ createdAt: "DESC" })
    .getCursor({ take: 50, cursor, orderBy: "id" });

  await process(page.data);
  cursor = page.nextCursor ?? undefined;
} while (page.hasNextPage);
```

주요 동작은 다음과 같습니다.

- **부수 효과 없음**: `getCursor()`는 빌더의 내부 복제본에서 동작합니다. 원본 인스턴스는 바뀌지 않습니다. 그래서 재사용하거나 다시 페이지로 나눠도 됩니다.
- **`findWithCursor()`와 같은 키셋**: 페이지는 정렬 속성으로 정렬한 뒤 기본 키로 정렬합니다. 복합 키면 키 컬럼 전부로 정렬합니다. 각 페이지는 앞 페이지의 마지막 행 다음부터 시작합니다. ASC라면 `AND (<col> > ? OR (<col> = ? AND <pk> > ?) OR <col> IS NULL)` 조건이 붙습니다. 이 조건은 빌더의 다른 절과 같은 `andWhere()` 경로로 붙습니다. 이 방식에서는 정렬 값이 같은 행이 페이지 경계에 걸려도 빠지거나 두 번 나오지 않습니다.
- **정렬 컬럼 하나**: `orderBy`는 엔티티 속성 이름 하나여야 합니다. 빌더에 이미 있는 `orderBy()`는 키셋 키 뒤에 붙습니다. 하지만 기본 키가 유일하므로 순서를 바꾸지는 않습니다.
- **NULL 안전**: 모든 다이얼렉트에서 NULL 정렬 값은 오름차순이면 맨 뒤에 오고 내림차순이면 맨 앞에 옵니다. NULL 행에서 끝난 페이지도 그 행 다음부터 이어집니다.
- **잘못된 cursor는 에러**: null이 아닌 cursor 문자열을 디코딩하지 못하면 `InvalidQueryError`를 던집니다. 이전 `getCursor()` 호출이 반환한 `nextCursor` 값을 항상 그대로 쓰세요.
- **`orderBy` 기본값은 엔티티의 기본 키**: 생략하면 `getCursor()`가 엔티티의 기본 키 컬럼을 자동으로 찾습니다. `findWithCursor()`와 같은 방식입니다.

> 큰 테이블이나 실시간 피드에는 `paginate()`보다 `getCursor()`를 쓰세요. 이런 곳에서는 오프셋 기반 페이지네이션이 깊어질수록 느려집니다. 사용자가 임의의 페이지로 이동해야 하거나 전체 개수가 필요하면 `paginate()`를 쓰면 됩니다.

## 비관적 잠금

동시성이 높은 상황에서는 행을 읽는 동안 잠가서 다른 트랜잭션이 수정하지 못하게 해야 할 때가 있습니다.

```typescript
const user = await em
  .createQueryBuilder(User, "u")
  .where("id", 1)
  .forUpdate()
  .getOne();
// SELECT ... FROM "user" AS "u" WHERE "u"."id" = $1 FOR UPDATE
```

`forUpdate()`는 배타 잠금(`FOR UPDATE`)을 겁니다. 내 트랜잭션이 커밋될 때까지 다른 트랜잭션은 이 행을 읽지도 수정하지도 못합니다. `forShare()`는 공유 잠금을 겁니다. 다른 트랜잭션은 이 행을 읽을 수는 있지만 쓰지는 못합니다.

| 메서드 | SQL (PostgreSQL / SQLite) | SQL (MySQL) | 효과 |
|--------|--------------------------|-------------|------|
| `forUpdate()` | `FOR UPDATE` | `FOR UPDATE` | 배타 잠금: 읽기·쓰기 모두 차단 |
| `forShare()` | `FOR SHARE` | `LOCK IN SHARE MODE` | 공유 잠금: 쓰기만 차단 |

어떤 메서드를 쓸지는 다음 기준으로 고릅니다.

- 재고 차감이나 잔액 갱신처럼 방금 읽은 값을 그대로 갱신할 때는 `forUpdate()`를 씁니다. 다른 트랜잭션이 이 행을 먼저 읽는 것부터 막습니다.
- 외래 키 참조가 유효한지 확인만 할 때는 `forShare()`를 씁니다. 내가 쓰지는 않지만 다른 트랜잭션이 그 행을 삭제하면 안 되는 경우입니다.
- 작업 큐에서 다른 워커가 잡은 행은 건너뛰고 다음 행을 잡을 때는 `forUpdateSkipLocked()`를 씁니다(아래 참고).
- 잠금을 잡지 못하면 즉시 에러를 받아 사용자에게 재시도를 알릴 때는 `forUpdateNowait()`를 씁니다.

### NOWAIT과 SKIP LOCKED

동시성이 높은 상황에서는 잠금이 풀리기를 기다리는 일이 병목이 되기 쉽습니다. 고급 잠금 옵션 두 가지로 이미 잠긴 행을 만났을 때의 동작을 정할 수 있습니다.

**NOWAIT**: 잠금이 풀리기를 기다리지 않고 즉시 에러를 던집니다.

```typescript
const user = await em
  .createQueryBuilder(User, "u")
  .where("id", 1)
  .forUpdateNowait()
  .getOne();
// SELECT ... FOR UPDATE NOWAIT
// 다른 트랜잭션이 잠그고 있으면 즉시 에러
```

**SKIP LOCKED**: 이미 잠긴 행을 기다리지 않고 건너뜁니다. 여러 워커가 같은 테이블에서 작업을 꺼내 가는 잡 큐 패턴에 특히 잘 맞습니다.

```typescript
// 워커가 잠기지 않은 다음 작업을 꺼내 감
const job = await em
  .createQueryBuilder(Job, "j")
  .where("status", "pending")
  .orderBy({ createdAt: "ASC" })
  .limit(1)
  .forUpdateSkipLocked()
  .getOne();
// SELECT ... ORDER BY ... LIMIT 1 FOR UPDATE SKIP LOCKED
// 남은 작업이 전부 잠겨 있으면 null
```

네 가지 조합을 모두 제공합니다.

| 메서드 | SQL |
|--------|-----|
| `forUpdateNowait()` | `FOR UPDATE NOWAIT` |
| `forUpdateSkipLocked()` | `FOR UPDATE SKIP LOCKED` |
| `forShareNowait()` | `FOR SHARE NOWAIT` |
| `forShareSkipLocked()` | `FOR SHARE SKIP LOCKED` |

::: warning
NOWAIT과 SKIP LOCKED는 MySQL 8.0 이상, MariaDB 10.6 이상, PostgreSQL 9.5 이상이 필요합니다. MariaDB에는 `FOR SHARE`가 없으므로 공유 잠금 변형은 `LOCK IN SHARE MODE NOWAIT` / `LOCK IN SHARE MODE SKIP LOCKED`로 나갑니다. MariaDB인지는 `type: "mariadb"`나 서버 버전으로 판별합니다.

SQLite에는 행 단위 잠금이 없습니다. 동시성 모델이 데이터베이스 단위입니다(`BEGIN EXCLUSIVE`). 쿼리 빌더는 다이얼렉트와 관계없이 SQL에 `FOR UPDATE`를 그대로 붙입니다. 그래서 SQLite에서 잠금 메서드를 호출하면 실행 시점에 SQL 문법 에러가 납니다. 여러 다이얼렉트에서 실행되는 코드라면 `em.getDriver().isSqlite()` / `isMySqlFamily()`로 분기하세요.
:::

## 인덱스 힌트

MySQL에서는 옵티마이저가 쓸 인덱스를 제안할 수 있습니다. 옵티마이저가 최적이 아닌 인덱스를 고를 때 유용합니다.

```typescript
const orders = await em
  .createQueryBuilder(Order, "o")
  .where("status", "pending")
  .useIndex("idx_order_status")
  .getMany();
// MySQL: SELECT ... FROM `order` USE INDEX (`idx_order_status`) WHERE ...
```

MySQL 인덱스 힌트는 세 종류입니다.

| 메서드 | SQL | 효과 |
|--------|-----|------|
| `useIndex(name)` | `USE INDEX (name)` | 옵티마이저에 인덱스 제안 |
| `forceIndex(name)` | `FORCE INDEX (name)` | 특정 인덱스 사용 강제 |
| `ignoreIndex(name)` | `IGNORE INDEX (name)` | 특정 인덱스 제외 |

MySQL이 아닌 드라이버에서도 이 호출은 받아들여집니다. 하지만 생성되는 SQL에서는 빠지고 경고도 나오지 않습니다. 같은 코드를 여러 다이얼렉트에 배포한다면 `em.getDriver().isMySqlFamily()`로 다이얼렉트를 확인한 뒤 호출하세요.

PostgreSQL에서는 `hint()` 메서드로 [pg_hint_plan](https://pg-hint-plan.readthedocs.io/) 스타일 힌트를 넣습니다. 여러 번 호출하면 힌트가 쌓여 `/*+ ... */` 블록 하나로 합쳐집니다.

```typescript
const orders = await em
  .createQueryBuilder(Order, "o")
  .where("status", "pending")
  .hint("IndexScan(o idx_order_status)")
  .hint("Leading(o c)")                       // 힌트 누적
  .getMany();
// PostgreSQL: /*+ IndexScan(o idx_order_status) Leading(o c) */ SELECT ...
```

힌트 문자열은 주석 안에 그대로 들어갑니다. 그래서 힌트에 `*/`가 들어 있으면 `InvalidQueryError`를 던집니다. 그대로 두면 주석이 거기서 끝나고 나머지가 SQL로 실행되기 때문입니다.

::: warning
`hint()`는 `pg_hint_plan` 확장이 설치되고 활성화된 PostgreSQL에서만 실제로 효과가 있습니다. 확장이 없으면 힌트는 그냥 주석으로 처리되어 옵티마이저가 보지 못합니다. SQLite는 쿼리 힌트를 전혀 지원하지 않습니다.
:::

## Soft Delete 처리

엔티티에 `@DeletedAt` 컬럼이 있으면 쿼리 빌더가 소프트 삭제된 행을 자동으로 제외합니다. 같은 필터가 관계 조인의 대상 테이블에도 붙습니다. `leftJoinRelation*` / `innerJoinRelation*`에서는 이 필터가 ON 절에 들어갑니다. `whereHas()` / `whereNotHas()` / `withCount()` 서브쿼리 안에도 붙습니다. 다만 명시적인 `leftJoin(Entity, alias, on)`은 직접 쓴 ON 절을 그대로 씁니다. 소프트 삭제된 행을 모든 곳에서 포함하려면 다음과 같이 씁니다.

```typescript
qb.withDeleted();
```

관계 서브쿼리는 선언되는 시점의 소프트 삭제 설정을 따릅니다. 그래서 서브쿼리에서도 필터를 걷어내려면 `whereHas()`보다 먼저 `withDeleted()`를 호출하세요. 특정 관계에서만 걷어내려면 콜백에서 `whereHas("comments", (sub) => sub.withDeleted())`처럼 쓰면 됩니다.

## 테넌트 스코프 우회 — `withoutTenantScope()`

`tenant_column` 멀티테넌시 전략에서는 테넌트 범위 엔티티로 만든 모든 빌더 쿼리에 `tenant_id = <현재 테넌트>` 조건이 자동으로 붙습니다. 쿼리 단위로 우회하려면 다음과 같이 씁니다.

```typescript
const allTenantUsers = await em
  .createQueryBuilder(User, "u")
  .withoutTenantScope()
  .getMany();
// SELECT ... FROM "user" "u"  (테넌트 조건 없음)
```

관리자 대시보드, 백그라운드 재조정 잡, 데이터 마이그레이션처럼 여러 테넌트의 데이터를 봐야 하는 작업에 쓰는 정식 escape hatch입니다. 전략이 `tenant_column`이 아니거나 엔티티가 `@NonTenantEntity()`이면 아무 일도 하지 않습니다. 컨텍스트 전체에서 우회하려면 `MetadataContext.runUnscoped()`를 쓰세요.

## Escape Hatch

타입 있는 API가 닿지 않는 곳이 있습니다. 이때 빌더를 떠나지 않고 raw SQL로 내려가는 메서드가 두 가지 있습니다.

```typescript
qb
  .where("status", "active")
  .appendSql(sql`ORDER BY "posts_count" DESC NULLS LAST`)
  .getRawMany();
```

- `appendSql(fragment)`: 조립된 쿼리 끝에 `Sql` 조각을 끼워 넣습니다. 타입 있는 API가 다루지 못하는 절에 유용합니다(예: SELECT 별칭으로 정렬, 커스텀 `WINDOW` 정의).
- `asSubquery(alias)`: 빌더를 `Sql`로 바꿉니다. 이 `Sql`은 `RawQueryBuilder.from()`이나 `Conditions.exists()`에 넘길 수 있습니다. 파라미터 바인딩도 보존됩니다.

## `getCount()` / `exists()` — 선택 상태는 무시됨

이 두 메서드는 SELECT를 처음부터 다시 만듭니다(`SELECT COUNT(*) ...`, `SELECT 1 ... LIMIT 1`). `WHERE`, `JOIN`, `GROUP BY`, `HAVING`은 그대로 씁니다. 하지만 `addSelect()` / `withCount()` / `addSelectSubquery()`로 더한 것은 아무 표시 없이 버려집니다.

```typescript
const total = await em
  .createQueryBuilder(User, "u")
  .where("isActive", true)
  .addSelect(sql`COUNT(*)`, "extra")  // getCount()에서는 버려짐
  .getCount();
// SELECT COUNT(*) AS "count" FROM "user" "u" WHERE "isActive" = true
```

의도한 동작입니다. 하지만 다른 곳에서 `addSelect`를 붙인 빌더에 `.getCount()`를 체이닝한다면 프로젝션이 카운트에 반영된다고 기대하지 마세요.

### GROUP BY가 있는 `getCount()`는 그룹 수를 셉니다

그룹화된 쿼리는 그룹마다 한 행을 반환합니다. 그래서 `getCount()`는 `HAVING`을 통과한 그룹의 개수를 반환합니다. `findAndCount()` / `findWithPage()`가 `FindOption.groupBy`에 적용하는 규칙과 같습니다. 덕분에 `getManyAndCount()`, `getPartialManyAndCount()`, `paginate()`, `paginatePartial()`의 `total`이 함께 반환되는 그룹 행과 어긋나지 않습니다.

```typescript
const groups = await em
  .createQueryBuilder(Order, "o")
  .groupBy(["status"])
  .having(sql`COUNT(*) >= ${2}`)
  .getCount();
// SELECT COUNT(*) AS "count"
// FROM (SELECT 1 FROM "order" AS "o" GROUP BY "o"."status" HAVING COUNT(*) >= $1) AS "grouped_src"
```

그룹의 개수가 아니라 각 그룹의 크기가 필요하면 집계를 명시적으로 투영하고 행을 읽으세요.

```typescript
const o = qAlias(Order, "o");
const sizes = await em
  .createQueryBuilder(Order, "o")
  .select(["status"])
  .addSelect(o.id.count().as("cnt"))
  .groupBy(["status"])
  .getRawMany();
// [{ status: "paid", cnt: 5 }, { status: "pending", cnt: 1 }, ...]
```

## 결과 검증 — `validate()`

컴파일 시점의 타입 좁히기는 많은 실수를 잡아 줍니다. 하지만 데이터베이스가 실제로 반환하는 값까지 확인하지는 못합니다. 문자열을 기대한 컬럼에 `null`이 올 수도 있습니다. 드라이버의 특성 때문에 숫자가 문자열로 올 수도 있습니다. 이 틈은 **validator**를 붙여 메웁니다. validator는 모든 행이 애플리케이션 코드에 닿기 전에 한 번 더 검사합니다.

가장 단순한 형태는 평범한 함수입니다.

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name"])
  .validate((row) => {
    if (!row.name) throw new Error("name must not be empty");
    return row;
  })
  .getPartialMany();
```

각 행은 validator를 거칩니다. 함수가 에러를 던지면 전체 호출이 그 에러로 거부됩니다. 함수가 정상적으로 반환하면 그 행이 결과에 들어갑니다. 기본값은 validator가 없는 상태이고 이때 오버헤드는 0입니다. validator는 `getPartialMany()`와 `getMany()`에서 모두 동작합니다.

validator 함수로 데이터를 변환해도 됩니다. 함수가 반환한 값이 실제 결과가 됩니다.

```typescript
.validate((row) => ({
  ...row,
  name: row.name.trim().toLowerCase(),
}))
```

### Zod로 스키마 검증하기

검증 함수를 손으로 쓰기는 번거롭습니다. [zod](https://zod.dev)를 쓰고 있다면 스키마를 그대로 넘기세요. 쿼리 빌더는 `.parse()` 메서드가 있는 객체를 모두 스키마로 인식합니다.

```typescript
import { z } from "zod";

const UserRow = z.object({
  id: z.number(),
  name: z.string().min(1),
});

const users = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name"])
  .validate(UserRow)
  .getPartialMany();
```

행이 zod 스키마를 통과하지 못하면 호출은 `ZodError`를 던집니다. 이 에러에는 어떤 필드가 왜 실패했는지 자세히 담깁니다. 이 검증으로 데이터 문제를 가장 이른 시점에 잡습니다. 문자열을 기대한 자리에 NULL이 오거나 숫자를 기대한 자리에 문자열이 오는 경우가 그 예입니다.

Zod의 `.transform()`도 그대로 동작합니다. 그래서 검증과 변환을 한 번에 처리할 수 있습니다.

```typescript
const NormalizedUser = z.object({
  id: z.number(),
  name: z.string().transform((s) => s.toUpperCase()),
  email: z.string().email(),
});

const users = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name", "email"])
  .validate(NormalizedUser)
  .getPartialMany();
// [{ id: 1, name: "ALICE", email: "alice@example.com" }, ...]
```

`.strict()`는 예상하지 못한 필드가 더 있는 행을 거부합니다. 스키마 드리프트를 감지할 때 유용합니다.

```typescript
const StrictUser = z.object({ id: z.number(), name: z.string() }).strict();

// id, name 이외의 컬럼이 오면 에러를 던짐
.validate(StrictUser)
```

`.parse(data)` 메서드가 있는 라이브러리라면 무엇이든 호환됩니다. zod 말고도 io-ts, superstruct 같은 라이브러리를 쓸 수 있습니다.

### `validate()`와 `selectSchema()` — 뭘 쓸까

두 메서드는 비슷해 보이지만 역할이 다릅니다.

| | `.validate(schema)` | `.selectSchema(schema)` |
|-|---------------------|-------------------------|
| 런타임 검증 | ✓ | ✓ |
| 데이터 변환 (`transform`) | ✓ | ✓ |
| 반환 타입 좁히기 | ✗: 현재 타입 유지 | ✓: `z.infer<schema>`로 좁힘 |
| 타입의 근거 | 호출자가 선언한 `TResult`를 신뢰 | 스키마에서 타입을 도출 |
| 주 쓰임새 | "호출자 타입은 이미 맞고 런타임 값만 한 번 더 확인" | "스키마에서 타입을 도출해 SELECT 모양을 확정" |

규칙은 간단합니다. 런타임 검증만 필요하면 `validate()`를 쓰고 타입 추론까지 스키마에 맡기려면 `selectSchema()`를 씁니다. `selectSchema`의 자세한 설명과 예제는 [QueryDSL 표현식](./query-builder-querydsl.md)의 "TypeScript 친화 이스케이프 해치" 절에 있습니다.

### 배열 단위 검증 — `validateArray()`

개별 행이 아니라 결과 집합 전체를 검사해야 할 때도 있습니다. 결과 수의 상한을 두거나 결과가 비어 있지 않은지 확인하는 경우입니다.

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name"])
  .validateArray((rows) => {
    if (rows.length === 0) throw new Error("expected at least one user");
    if (rows.length > 1000) throw new Error("result set too large");
    return rows;
  })
  .getPartialMany();
```

Zod 배열 스키마도 쓸 수 있습니다.

```typescript
const UsersArray = z
  .array(z.object({ id: z.number(), name: z.string() }))
  .min(1)
  .max(100);

const users = await qb
  .select(["id", "name"])
  .validateArray(UsersArray)
  .getPartialMany();
```

### 행 검증과 배열 검증 섞어 쓰기

한 쿼리에 `validate()`와 `validateArray()`를 함께 붙여도 됩니다. 행 단위 검증이 먼저 실행되고 그다음 배열 단위 검증이 실행됩니다.

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name"])
  .validate(z.object({             // 1. 각 행 검증 + 변환
    id: z.number(),
    name: z.string().transform((s) => s.trim()),
  }))
  .validateArray((rows) => {       // 2. 배열 전체 제약
    if (rows.length > 100) throw new Error("too many results");
    return rows;
  })
  .getPartialMany();
```

### 언제 검증을 쓸까

검증은 행마다 함수 호출이 더해지므로 공짜가 아닙니다. 비용보다 효과가 큰 상황은 다음과 같습니다.

| 상황 | 검증? | 이유 |
|------|-------|------|
| 내부 서비스, 스키마를 신뢰 | 아니오 | 속도가 더 중요 |
| 사용자 데이터를 반환하는 API 엔드포인트 | 예 | null / 타입 불일치를 클라이언트에 닿기 전에 차단 |
| 느슨한 소스 데이터를 다루는 ETL 파이프라인 | 예 | 잘못된 데이터의 전파 차단 |
| 역직렬화 버그 디버깅 | 일시적으로 예 | 정확히 어떤 행/필드가 문제인지 특정 |

대부분의 내부 쿼리에는 기본값이 맞습니다. 기본값은 validator가 없고 오버헤드도 0입니다. 검증은 데이터가 신뢰 경계를 넘는 지점에 더하면 됩니다.

## 쿼리 실행하기

쿼리를 다 만들었으면 이제 실행할 차례입니다. 쿼리 빌더는 실행 메서드를 세 단계로 제공합니다. 단계마다 안전성과 타입 보장이 다릅니다.

**Safe: 필수 컬럼을 검증하는 클래스 인스턴스**

| 메서드 | 반환 | 설명 |
|--------|------|------|
| `getMany()` | `T[]` | 클래스 인스턴스. `select()` 사용 시 필수 컬럼 검증 |
| `getOne()` | `T \| null` | 단일 인스턴스 또는 null (자동으로 `LIMIT 1`) |
| `getOneOrFail()` | `T` | 단일 인스턴스 (결과 없으면 `EntityNotFoundError`) |
| `getManyAndCount()` | `[T[], number]` | 인스턴스 배열 + 총 개수 (두 쿼리 순차 실행) |
| `paginate(opts?)` | `PagePaginationResult<T>` | 오프셋 한 페이지(인스턴스) + 페이지네이션 메타데이터 |
| `getMap(keyColumn)` | `Map<T[K], TResult>` | `getMany()`를 실행하고 결과를 `keyColumn` 기준 Map으로 인덱싱. 중복 키는 마지막 행이 남음 |
| `pluck(column)` | `T[K][]` | `getMany()`를 실행하고 특정 컬럼 값만 flat 배열로 반환. 행 순서 보존 |

`getMap()`과 `pluck()`은 모두 `getMany()` 위에서 동작하는 얇은 터미널 메서드입니다. 쿼리는 정확히 한 번만 실행합니다. 빌더에 있는 WHERE / JOIN / ORDER BY / LIMIT / 소프트 삭제 / 테넌트 범위도 그대로 따릅니다.

```typescript
// getMap: 컬럼 기준 O(1) 조회
const byId = await em
  .createQueryBuilder(User, "u")
  .where("isActive", true)
  .getMap("id");

byId.get(5);        // id가 5인 활성 사용자, 없으면 undefined
byId.has(99);       // 해당 id의 활성 사용자가 없으면 false

// pluck: 특정 컬럼 값만 flat 배열로
const emails = await em
  .createQueryBuilder(User, "u")
  .where("isActive", true)
  .orderBy({ createdAt: "ASC" })
  .pluck("email");
// -> ["alice@example.com", "bob@example.com", ...]
```

이 메서드들은 행을 항상 엔티티 클래스 인스턴스로 역직렬화합니다. 그래서 `instanceof`가 동작하고 클래스 메서드도 쓸 수 있습니다. 결과를 `em.save()`에 그대로 넘겨도 됩니다. `select()`로 일부 컬럼을 고를 때는 not-null 컬럼이 반드시 포함돼야 합니다. 그렇지 않으면 `OrmError`를 던집니다.

**Partial: 타입 있는 plain object (Pick)**

| 메서드 | 반환 | 설명 |
|--------|------|------|
| `getPartialMany()` | `TResult[]` | `Pick<T, K>`로 좁혀진 plain object |
| `getPartialOne()` | `TResult \| null` | 단일 plain object 또는 null |
| `getPartialManyAndCount()` | `[TResult[], number]` | plain object 배열 + 총 개수 |
| `paginatePartial(opts?)` | `PagePaginationResult<TResult>` | 오프셋 한 페이지(plain object) + 페이지네이션 메타데이터 |

역직렬화도 필수 컬럼 검증도 하지 않습니다. `select(["id", "name"])`를 쓰면 반환 타입이 `Pick<T, "id" | "name">[]`로 좁혀집니다. 그래서 선택하지 않은 컬럼에 접근하면 컴파일 에러가 납니다. 결과를 `em.save()`에는 넘기지 마세요.

**Raw: plain object + 선택적 값 변환**

| 메서드 | 반환 | 설명 |
|--------|------|------|
| `getRawMany<T>(options?)` | `T[]` | plain object (타입 인자 없으면 `Record<string, unknown>`) |
| `getRawOne<T>(options?)` | `T \| null` | 단일 plain object 또는 null |

결과에 엔티티에 없는 계산 컬럼이 섞일 때 씁니다(예: `addSelect(sql`COUNT(*)`, "cnt")`). 역직렬화는 하지 않습니다.

#### 값 변환 — `coerce`

드라이버는 raw 결과를 다이얼렉트마다 다른 형태로 반환합니다. `mysql2`는 `DECIMAL`을 문자열로 반환하고 `SUM` / `AVG` 집계 결과도 문자열로 반환합니다. `pg`는 `NUMERIC` / `bigint`를 문자열로 반환합니다. 날짜는 드라이버 옵션에 따라 `Date`로 오거나 문자열로 옵니다. raw 경로에서 정수가 반올림되는 일은 없습니다. ±2^53을 넘는 `BIGINT`는 모든 드라이버에서 10진수 문자열로 도착합니다. `mysql2`와 `better-sqlite3`는 값이 범위 안이면 number를 반환합니다. `"bigint"` 태그는 이 문자열을 네이티브 `BigInt`로 바꿉니다. `coerce` 옵션은 컬럼마다 원하는 primitive 타입을 선언합니다. 그러면 ORM이 값을 정규화하므로 호출하는 곳에서 `Number(row.x)`를 손으로 적지 않아도 됩니다.

```typescript
const rows = await qb
  .select([day.as("day"), completed.as("completedCount"), est.as("estimate")])
  .getRawMany<{ day: Date; completedCount: number; estimate: number }>({
    coerce: { day: "date", completedCount: "number", estimate: "number" },
  });
// rows[0].completedCount는 진짜 number이고 rows[0].day는 진짜 Date
```

지원하는 타입 태그는 `"number"`, `"bigint"`, `"string"`, `"date"`, `"json"`, `"boolean"`입니다. `null` / `undefined`는 그대로 통과합니다. `coerce`에 없는 컬럼은 드라이버가 반환한 값을 그대로 유지합니다. `getRawOne()`도 같은 옵션을 받습니다.

**유틸: 집계와 분석**

| 메서드 | 반환 | 설명 |
|--------|------|------|
| `getCount()` | `number` | 같은 WHERE/JOIN으로 `COUNT(*)`. LIMIT/OFFSET 무시 |
| `exists()` | `boolean` | 조건에 맞는 행이 있는지 여부 (`SELECT 1 ... LIMIT 1` 사용) |
| `getExists()` | `boolean` | `exists()`의 별칭. 다른 `get*` 터미널과 이름 규칙을 맞춤 |
| `getSum(column)` | `number` | 같은 범위에서 `SUM(column)`. 결과가 없으면 0 |
| `getAvg(column)` | `number` | 같은 범위에서 `AVG(column)`. 결과가 없으면 0 |
| `getMin(column)` | `number` | 같은 범위에서 `MIN(column)`. 결과가 없으면 0 |
| `getMax(column)` | `number` | 같은 범위에서 `MAX(column)`. 결과가 없으면 0 |
| `explain()` | `ExplainResult` | 빌드된 SELECT의 실행 계획 (MySQL / PostgreSQL / SQLite 지원) |

모든 집계 터미널(`getSum`, `getAvg`, `getMin`, `getMax`, `getCount`)은 SELECT 절을 처음부터 다시 작성합니다. 그래서 `addSelect()` 투영은 무시됩니다. WHERE / JOIN / 소프트 삭제 / 테넌트 범위만 유지됩니다. `getCount()`는 여기에 GROUP BY / HAVING까지 반영해서 그룹 수를 반환합니다([위 절](#group-by가-있는-getcount-는-그룹-수를-셉니다) 참고). 스칼라 집계인 `getSum`, `getAvg`, `getMin`, `getMax`는 값 하나를 반환하므로 GROUP BY / HAVING을 무시합니다.

`explain()`은 `EntityManager.explain()`과 같은 방식으로 동작합니다. 빌드된 SQL 앞에 드라이버의 `EXPLAIN` 문법을 붙이고 같은 `ExplainResult` 형태를 반환합니다(`rows`, `type`, `possibleKeys`, `key`, `cost`). 이 메서드는 MySQL, PostgreSQL, SQLite에서 동작하고 SQLite에서는 `EXPLAIN QUERY PLAN`을 씁니다. 그 밖의 드라이버에서 호출하면 `InvalidQueryError`를 던집니다.

```typescript
// 존재 여부 확인: get* 스타일
const hasExpired = await em
  .createQueryBuilder(Session, "s")
  .where("expiresAt", { lt: new Date() })
  .getExists();  // .exists()와 동일

// 쿼리 플랜
const plan = await em
  .createQueryBuilder(Order, "o")
  .where("status", "pending")
  .explain();
console.log(plan.rows);      // 예상 행 수
console.log(plan.key);       // 선택된 인덱스
```

고르는 기준은 다음과 같습니다. 기본은 `getMany()`입니다. 컴파일 시점의 타입 좁히기가 필요한 읽기 전용 DTO에는 `getPartialMany()`를 씁니다. `addSelect`나 계산 컬럼이 섞인 쿼리에는 `getRawMany()`를 씁니다.

디버깅할 때는 `getSql()`로 쿼리를 실행하지 않고 SQL 문자열과 파라미터를 꺼내 볼 수 있습니다.

```typescript
const { text, values } = qb.getSql();
console.log(text);   // SELECT "u"."id", ... WHERE "u"."is_active" = ?
console.log(values);  // [true]
```

> 참고: `getSql()` 출력의 `?` 플레이스홀더는 읽기 쉽게 하려는 표시입니다. 실제로 실행되는 쿼리는 드라이버 규약에 맞는 파라미터를 씁니다(PostgreSQL은 `$1`, `$2`, MySQL은 `?`).

### 필수 컬럼 검증

`getMany()`는 `select()`를 쓸 때 not-null 컬럼이 모두 포함됐는지 확인합니다. 그래서 필수 필드가 `undefined`인 불완전한 클래스 인스턴스가 만들어지지 않습니다.

```typescript
@Entity()
class User {
  @PrimaryGeneratedColumn()         // autoIncrement: 생략 가능
  id!: number;

  @Column({ type: "varchar" })      // not-null: 필수
  name!: string;

  @Column({ nullable: true })       // nullable: 생략 가능
  bio!: string | null;

  @Column({ default: "active" })    // 기본값 있음: 생략 가능
  status!: string;
}

// ✓ OK: 유일한 필수 컬럼인 "name"이 포함됨
await qb.select(["name"]).getMany();

// ✗ OrmError MISSING_REQUIRED_COLUMNS: "name" 누락
await qb.select(["bio"]).getMany();

// ✓ getPartialMany()는 검증을 건너뜀
await qb.select(["bio"]).getPartialMany();  // OK: plain object
```

컬럼이 **필수**로 분류되려면 다음이 모두 참이어야 합니다.

- `nullable`이 `true`가 아님
- `default` 값이 없음
- `autoIncrement`가 아님 (예: `@PrimaryGeneratedColumn`)

### 메서드별 사용 시나리오

| 상황 | 메서드 | 이유 |
|------|--------|------|
| `em.save()`에 넘길 데이터 | `getMany()` | 전체 생명주기를 지원하는 클래스 인스턴스 |
| EntitySubscriber / 생명주기 훅 | `getMany()` | 클래스 인스턴스만 `listenTo()`에 매칭 |
| 읽기 전용 API 응답 | `getPartialMany()` | 타입 있는 DTO, 컴파일 시점 안전, 가벼움 |
| 집계 / 계산 컬럼 | `getRawMany()` | `addSelect(sql`COUNT(*)`, "cnt")`는 `Pick`으로 타이핑 불가 |
| 존재 여부 확인 | `exists()` | boolean만 반환. 데이터는 조회하지 않음 |

`em.find()`에 `select` 옵션을 주면 반환 타입도 같은 방식으로 좁혀집니다([선택하지 않은 컬럼은 어떻게 되나요?](./entity-manager-querying.md#선택하지-않은-컬럼은-어떻게-되나요)). 그래서 타입 있는 투영에 쿼리 빌더가 꼭 필요하지는 않습니다.

## 같은 쿼리를 미리 만들어 두기 — `prepare()`

같은 모양의 쿼리가 값만 바뀌며 반복될 때는 SQL을 한 번만 만들어 두고 재사용할 수 있습니다. 배치 잡에서 ID 수백 개로 상세 쿼리를 실행하는 경우가 전형적인 예입니다.

```typescript
import { p } from "@stingerloom/orm";
import sql from "sql-template-tag";

const findById = em
  .createQueryBuilder(User, "u")
  .where(sql`u.id = ${p("id")}`)
  .prepare<{ id: number }>();

for (const id of userIds) {
  const user = await findById.executeOne({ id });
  // SQL 문자열은 한 번만 생성하고 이후에는 파라미터만 교체
}
```

`SelectQueryBuilder`에서 투영한 일부 컬럼만 타입에 맞춰 받으려면 `preparePartial()`을 쓰세요. 그러면 `TResult`가 `Pick<...>`로 좁혀집니다. `RawQueryBuilder`에도 같은 모양의 `.prepare(em)`이 있습니다.

> 주의: 쿼리 구조 자체가 달라지면 `prepare()`는 효과가 없습니다. 필터가 선택적으로 붙는 검색 엔드포인트처럼 SQL 골격이 매번 바뀌는 경우에는 `when()` / `pipe()`가 맞습니다.

언제 효과가 있는지와 `WriteBuffer`나 배치 쓰기와 어떻게 다른지는 [쿼리 미리 만들어두기](./entity-manager-advanced.md#쿼리-미리-만들어두기-em-compile-qb-prepare)에 있습니다.

## 실전 예제 — 필터 검색 + 페이지네이션

지금까지 본 내용을 합쳐 봅시다. 선택적인 필터를 받아 페이지네이션된 결과를 총 개수와 함께 반환하는 검색 엔드포인트입니다.

```typescript
import { qAlias } from "@stingerloom/orm";

async function searchPosts(filters: {
  authorName?: string;
  category?: string;
  minLikes?: number;
  page: number;
  pageSize: number;
}) {
  const p = qAlias(Post, "p");
  const u = qAlias(User, "u");

  const qb = em
    .createQueryBuilder(Post, "p")
    .select(["id", "title", "createdAt"])
    .leftJoin(User, "u", (join) =>
      join.on(p.col("authorId"), "=", u.col("id"))
    );

  // 각 필터는 선택 사항: 값이 있을 때만 조건 추가
  if (filters.authorName) {
    qb.where(u.name.like(`%${filters.authorName}%`));
  }
  if (filters.category) {
    qb.andWhere(p.category.eq(filters.category));
  }
  if (filters.minLikes) {
    qb.andWhere(p.likeCount.gte(filters.minLikes));
  }

  const [posts, total] = await qb
    .orderBy({ createdAt: "DESC" })
    .skip(filters.page * filters.pageSize)
    .take(filters.pageSize)
    .getPartialManyAndCount();

  return { posts, total, page: filters.page, pageSize: filters.pageSize };
}
```

`qAlias()`를 쓰면 쿼리 빌더가 자연스럽게 읽힙니다. `u.name.like(...)`, `p.category.eq(...)`가 그 예입니다. TypeScript가 속성 이름과 조건 메서드를 모두 자동 완성합니다. 그래서 오타는 컴파일 에러로 잡힙니다.

`when()`을 쓰면 `if` 블록을 아예 없앨 수 있습니다.

```typescript
const [posts, total] = await em
  .createQueryBuilder(Post, "p")
  .select(["id", "title", "createdAt"])
  .leftJoin(User, "u", (join) =>
    join.on(p.col("authorId"), "=", u.col("id"))
  )
  .when(!!filters.authorName, (qb) =>
    qb.where(u.name.like(`%${filters.authorName}%`))
  )
  .when(!!filters.category, (qb) =>
    qb.where(p.category.eq(filters.category))
  )
  .when(!!filters.minLikes, (qb) =>
    qb.where(p.likeCount.gte(filters.minLikes))
  )
  .orderBy({ createdAt: "DESC" })
  .skip(filters.page * filters.pageSize)
  .take(filters.pageSize)
  .getPartialManyAndCount();
```

`when()`, `pipe()`, scope 같은 편의 헬퍼는 [편의 패턴](./query-builder-patterns.md)에 있습니다.

## 다음 단계

- [편의 패턴](./query-builder-patterns.md): `when`, `pipe`, scope, `whereHas`, `withCount`
- [QueryDSL 표현식](./query-builder-querydsl.md): 타입 있는 조건 / 프로젝션 표현
- [페이지네이션 & 스트리밍](./pagination.md): 커서 페이지네이션, 스트리밍
- [Query Builder 개요](./query-builder.md): 기본 사용법과 전체 지도
