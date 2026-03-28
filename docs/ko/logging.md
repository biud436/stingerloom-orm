# Logging & Diagnostics

ORM이 내부에서 뭘 하는지 파악하고, 성능 문제를 찾고, 해결하는 데 필요한 진단 도구를 설명해요.

---

## Query Logging

### 쿼리 로깅이 왜 필요해요?

ORM이 SQL을 대신 작성해주니까 편하지만, 문제가 생기면 실제로 어떤 SQL이 나가는지 봐야 해요. 데이터가 이상하거나, 페이지가 느리거나, 트랜잭션 데드락이 걸릴 때 쿼리 로깅을 켜면 바로 확인할 수 있어요.

### 기본 설정

```typescript
await em.register({
  // ...
  logging: true,
});
```

### 출력 예시

로깅을 켜면 모든 SQL이 콘솔에 출력돼요:

```
[Query] SELECT "id", "name", "email" FROM "user" WHERE "is_active" = $1 [true]  (4ms)
[Query] SELECT "id", "title", "body", "author_id" FROM "post" WHERE "author_id" = $1 [42]  (7ms)
[Query] INSERT INTO "post" ("title", "body", "author_id") VALUES ($1, $2, $3) RETURNING "id" ["Hello World", "My first post", 42]  (12ms)
[Query] UPDATE "user" SET "last_login" = $1 WHERE "id" = $2 ["2026-03-22T10:00:00.000Z", 42]  (3ms)
[Query] DELETE FROM "post" WHERE "id" = $1 [17]  (2ms)
```

각 줄에 세 가지 정보가 들어있어요:

1. **SQL 구문** -- 파라미터 placeholder (`$1`, `$2`)가 포함돼요. 문자열 보간이 아니라 parameterized query라서 SQL injection이 방지돼요.
2. **파라미터 값** -- 대괄호 안에 순서대로 나와요.
3. **실행 시간** -- 밀리초 단위예요.

### 세부 설정

더 세밀하게 제어하려면 객체로 전달하면 돼요:

```typescript
await em.register({
  // ...
  logging: {
    queries: true,       // Print every SQL statement (same as logging: true)
    slowQueryMs: 500,    // Warn on queries exceeding 500ms
    nPlusOne: true,      // Enable N+1 query pattern detection
  },
});
```

### 프로그래밍 방식 접근

쿼리 로그를 구조화된 데이터로 가져올 수도 있어요:

```typescript
const log = em.getQueryLog();
// [
//   { entityName: "User", sql: "SELECT ...", durationMs: 4, timestamp: 1711234567890 },
//   { entityName: "Post", sql: "SELECT ...", durationMs: 7, timestamp: 1711234567920 },
// ]
```

성능 테스트에서 쿼리 수를 검증하거나, 커스텀 대시보드를 만들거나, 모니터링 시스템에 메트릭을 보낼 때 유용해요.

---

## N+1 Detection

### N+1 문제가 뭐예요?

ORM을 쓸 때 가장 흔한 성능 문제예요. 구체적인 예시로 설명할게요.

블로그에 게시글이 100개 있고, 각 게시글에 작성자가 있다고 해봐요. 모든 게시글과 작성자 이름을 표시하고 싶은 상황이에요.

**단순한 방식 (N+1 문제):**

```typescript
const posts = await em.find(Post, {}); // 1 query: SELECT * FROM post

for (const post of posts) {
  console.log(post.author.name);
  // Each access triggers: SELECT * FROM user WHERE id = ?
  // That is 100 more queries, one per post.
}
```

총 **101개 쿼리**. 쿼리당 10ms라면 1,010ms -- 게시글 목록 하나 보여주는 데 1초 이상 걸려요.

**해결 방법 (eager loading with JOIN):**

```typescript
const posts = await em.find(Post, {
  relations: ["author"],
});
// 1 query: SELECT post.*, user.* FROM post LEFT JOIN user ON post.author_id = user.id
```

총 **1개 쿼리**. 같은 데이터를 약 10ms에 가져와요. 100배 차이예요.

N+1 문제가 교활한 이유는 코드를 작성할 때 문제가 안 보이기 때문이에요. 개발 환경에서 게시글 5개로는 잘 동작하고, 프로덕션에서 데이터가 많아져야 문제가 드러나요. Stingerloom의 N+1 감지기가 이걸 자동으로 잡아줘요.

### 설정

```typescript
await em.register({
  type: "postgres",
  // ...
  logging: {
    nPlusOne: true,
  },
});
```

### 동작 방식

`QueryTracker`가 EntityManager를 통과하는 모든 쿼리를 모니터링해요. 슬라이딩 타임 윈도우(기본 100ms) 내에서 같은 엔티티에 대한 쿼리 수를 세고, 임계값(기본 100ms 내 10회)을 넘으면 경고를 출력해요:

```
[QueryTracker] [N+1 WARNING] Entity "User" queried 15+ times in 100ms. Consider using eager loading or relations option.
```

경고는 엔티티별로 EntityManager 생명주기 동안 한 번만 발생해서 로그가 도배되지 않아요.

### 경고가 뜨면 이렇게 해결해요

**방법 1: find 호출 시 `relations` 옵션 사용:**

```typescript
// Before (N+1)
const posts = await em.find(Post, {});

// After (single JOIN query)
const posts = await em.find(Post, {
  relations: ["author"],
});
```

**방법 2: relation 데코레이터에 `eager: true` 설정:**

```typescript
@ManyToOne(() => User, { joinColumn: "author_id", eager: true })
author!: User;
```

`eager: true`로 설정하면 게시글을 조회할 때 항상 LEFT JOIN으로 작성자를 함께 가져와요. 관련 데이터가 거의 항상 필요한 경우에 쓰면 좋아요.

---

## Slow Query Warnings

### 느린 쿼리 감지가 왜 필요해요?

API 엔드포인트가 800ms에 응답하면 아무도 불평 안 해요. 하지만 트래픽이 늘어서 그 쿼리가 초당 50번 실행되면 데이터베이스가 포화돼요. 느린 쿼리 경고는 장애가 되기 전에 미리 알려줘요.

### 설정

```typescript
await em.register({
  // ...
  logging: {
    slowQueryMs: 500, // Warn on queries taking longer than 500ms
  },
});
```

### 경고 출력 예시

쿼리가 임계값을 초과하면:

```
[QueryTracker] [SLOW QUERY] 847ms: SELECT "id", "title", "body", "created_at" FROM "post" WHERE "body" LIKE '%search term%' ORDER BY "created_at" DESC
```

### 느린 쿼리를 발견하면 이렇게 해결해요

대부분 다음 중 하나에 해당해요:

**1. 인덱스 누락.** 테이블 전체를 스캔하는 대신 인덱스를 써야 해요. 필터링이나 정렬 대상 컬럼에 `@Index()`를 추가하세요.

```typescript
@Column({ type: "varchar", length: 255 })
@Index()
email!: string;
```

**2. 대용량 테이블 풀 스캔.** 수백만 행의 테이블에서 WHERE 없이 조회하거나, WHERE 조건이 인덱스와 매칭되지 않는 경우예요.

**3. 앞쪽 와일드카드 LIKE.** `WHERE body LIKE '%search%'`는 와일드카드가 앞에 있어서 인덱스를 쓸 수 없어요. Full-text search를 고려하세요.

**4. JOIN 인덱스 누락.** FK 컬럼에 인덱스가 없으면 JOIN할 때 전체 테이블을 스캔해요.

다음 섹션의 EXPLAIN으로 데이터베이스가 정확히 무엇을 하는지 진단할 수 있어요.

---

## EXPLAIN -- Query Plan Analysis

### EXPLAIN이 왜 중요해요?

쿼리가 느릴 때 EXPLAIN은 *왜* 느린지 알려줘요. 어떤 테이블을 스캔하는지, 어떤 인덱스를 사용(또는 무시)하는지, 몇 행을 검사하는지 보여줘요. EXPLAIN 없이는 추측이지만, EXPLAIN이 있으면 병목이 어디인지 정확히 알 수 있어요.

### 기본 사용법

```typescript
const result = await em.explain(User, {
  where: { email: "john@example.com" },
});

console.log(result.type);  // Access type (e.g., "ref" = using an index)
console.log(result.key);   // Which index (e.g., "idx_user_email")
console.log(result.rows);  // Estimated rows examined (e.g., 1)
console.log(result.cost);  // Estimated cost
```

### ExplainResult 필드

| Field | Description |
|-------|-------------|
| `type` | Access type -- 데이터베이스가 테이블을 읽는 방식 (아래 표 참고) |
| `key` | 옵티마이저가 실제 사용한 인덱스 (없으면 null) |
| `rows` | 검사할 행 수 추정값 |
| `cost` | 추정 비용 (MySQL: filtered percentage, PostgreSQL: total_cost) |
| `possibleKeys` | 옵티마이저가 고려한 인덱스 목록 |
| `raw` | 데이터베이스의 원시 출력 (객체 배열) |

### MySQL EXPLAIN 출력 읽는 법

`explain()`을 MySQL에서 호출하면 `EXPLAIN SELECT ...`를 실행해요. `type` 필드가 가장 중요해요:

| type value | Meaning | Performance |
|------------|---------|-------------|
| `const` | 최대 1행 매칭 (PK 또는 unique index lookup) | Best possible |
| `eq_ref` | 이전 테이블의 각 행에 대해 1행 읽기 (PK JOIN) | Excellent |
| `ref` | 매칭되는 인덱스 값의 모든 행 읽기 | Good |
| `range` | 인덱스를 사용해 지정 범위만 읽기 | Good |
| `index` | 풀 인덱스 스캔 (인덱스의 모든 항목 읽기) | Okay |
| `ALL` | 풀 테이블 스캔 (모든 행 읽기) | Worst -- 인덱스 추가 필요 |

**잘 인덱싱된 쿼리 예시 (MySQL)**

```typescript
const result = await em.explain(User, {
  where: { email: "john@example.com" },
});
// result.type = "ref"
// result.key  = "idx_user_email"
// result.rows = 1
```

`idx_user_email` 인덱스를 사용해 lookup하고 1행만 검사해요. 빨라요.

**풀 테이블 스캔 예시 (MySQL)**

```typescript
const result = await em.explain(User, {
  where: { bio: "likes cats" },  // no index on bio
});
// result.type = "ALL"
// result.key  = null
// result.rows = 50000
```

`bio` 컬럼에 인덱스가 없어서 50,000행을 전부 읽어요. 인덱스를 추가하거나 쿼리를 재검토해야 해요.

### PostgreSQL EXPLAIN 출력 읽는 법

PostgreSQL은 다른 용어를 사용해요. Stingerloom의 `type` 필드는 PostgreSQL의 node type에 매핑돼요:

| type value | Meaning | Performance |
|------------|---------|-------------|
| `Index Scan` | 인덱스를 읽고 매칭 행을 테이블에서 가져오기 | Good |
| `Index Only Scan` | 인덱스만 읽기 (필요한 컬럼이 모두 인덱스에 포함) | Best |
| `Bitmap Index Scan` | 매칭 행의 bitmap을 만들고 일괄 읽기 | Good for medium selectivity |
| `Seq Scan` | Sequential scan -- 모든 행 읽기 | Worst -- 인덱스 추가 필요 |

**인덱싱된 쿼리 예시 (PostgreSQL)**

```typescript
const result = await em.explain(User, {
  where: { email: "john@example.com" },
});
// result.type = "Index Scan"
// result.key  = "idx_user_email"
// result.rows = 1
// result.cost = 8.29
```

**Sequential scan 예시 (PostgreSQL)**

```typescript
const result = await em.explain(User, {
  where: { bio: "likes cats" },
});
// result.type = "Seq Scan"
// result.key  = null
// result.rows = 50000
// result.cost = 1234.00
```

PostgreSQL의 `cost`는 추정 I/O + CPU 작업량을 나타내는 추상 단위예요. 절대값보다는 인덱스 추가 전후의 비교가 중요해요.

> **Note:** `explain()`은 MySQL과 PostgreSQL에서 지원돼요. SQLite에서는 `InvalidQueryError`가 발생해요.

---

## Query Timeout

### 쿼리 타임아웃이 왜 필요해요?

타임아웃 없는 쿼리는 시한폭탄이에요. 실수로 5천만 행을 스캔하는 쿼리가 실행되면 데이터베이스 커넥션을 무한정 점유해요. 커넥션 풀이 10개라면 이런 쿼리 10개만으로 전체 애플리케이션이 멈춰요.

쿼리 타임아웃은 circuit breaker 역할을 해요. "N밀리초 안에 안 끝나면 쿼리를 중단하고 커넥션을 해제해라"라는 거예요.

### 전역 설정

```typescript
await em.register({
  // ...
  queryTimeout: 5000, // 5-second timeout for all queries
});
```

### 개별 쿼리 오버라이드

배치 처리나 복잡한 리포트처럼 정당하게 오래 걸리는 쿼리는 전역 설정을 오버라이드할 수 있어요:

```typescript
const users = await em.find(User, {
  where: { isActive: true },
  timeout: 2000, // 2-second timeout for this query only
});
```

타임아웃이 발생하면 원본 SQL과 타임아웃 값이 포함된 `QueryTimeoutError`가 throw돼요.

### 데이터베이스 레벨에서의 동작

Stingerloom은 JavaScript 타이머가 아니라 데이터베이스의 네이티브 타임아웃 메커니즘을 사용해요. JavaScript `setTimeout`은 클라이언트 측 대기만 취소하고 서버에서는 쿼리가 계속 실행되기 때문에 중요한 차이예요.

| DB | SQL sent before the query | Effect |
|----|--------------------------|--------|
| MySQL | `SET max_execution_time = 5000` | MySQL 서버가 5000ms 후 쿼리 중단 |
| PostgreSQL | `SET LOCAL statement_timeout = '5000ms'` | PostgreSQL이 쿼리 중단; `SET LOCAL`은 현재 트랜잭션으로 범위 한정 |
| SQLite | Driver-level timeout | SQLite 드라이버가 타임아웃 적용 |

---

## Production Recommendations

| Setting | Development | Production | 이유 |
|---------|-------------|------------|------|
| `logging.queries` | `true` | `false` | 매 쿼리마다 I/O 오버헤드가 생겨요. 프로덕션에서는 모니터링 시스템이 처리해야 해요. |
| `logging.slowQueryMs` | `100` | `500`-`1000` | 개발 환경에서는 100ms 이상을 모두 잡아서 좋은 습관을 들이고, 프로덕션에서는 500ms-1s로 노이즈를 걸러요. |
| `logging.nPlusOne` | `true` | `true` | 오버헤드가 거의 없고(타임 윈도우 내 쿼리 카운트만 함), 프로덕션 데이터 규모에서만 드러나는 문제를 잡아줘요. 항상 켜두세요. |
| `queryTimeout` | -- | `5000`-`10000` | 개발 환경에서는 디버깅을 위해 쿼리를 완료시키고, 프로덕션에서는 폭주 쿼리가 커넥션 풀을 막기 전에 종료시켜야 해요. |

### 프로덕션 마인드셋 정리

개발 환경에서는 최대한의 가시성이 필요해요: 모든 쿼리 로깅, 100ms 이상 경고, 디버깅을 위해 쿼리 완료까지 대기.

프로덕션에서는 최소 노이즈와 최대 보호가 필요해요: 일반 쿼리 로깅은 APM 도구에 맡기고, 정말 느린 쿼리만 알림을 받고, 너무 오래 걸리면 강제 종료하고, N+1 감지는 항상 켜두세요. "스테이징에서는 괜찮았는데 프로덕션에서 느려요"의 가장 흔한 원인이에요.

---

## Next Steps

- [Configuration](./configuration.md) -- All connection and runtime options
- [Events & Subscribers](./events.md) -- React to entity lifecycle events
- [Production Guide](./production-guide.md) -- Connection pool monitoring, graceful shutdown
