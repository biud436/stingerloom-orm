# 로깅 & 진단

Stingerloom의 진단 도구는 ORM이 내부에서 하는 일을 보여 줍니다. 이 도구로 성능 문제를 찾고 해결합니다.

---

## 쿼리 로깅

### 쿼리 로깅이 필요한 이유

ORM은 SQL을 대신 작성하므로 편합니다. 하지만 문제가 생기면 데이터베이스에 실제로 보낸 SQL을 확인해야 합니다. 데이터가 이상할 때, 페이지가 느릴 때, 트랜잭션에 데드락이 걸렸을 때가 그렇습니다. 쿼리 로깅을 켜면 그 SQL이 바로 보입니다.

### 기본 설정

```typescript
await em.register({
  // ...
  logging: true,
});
```

### 출력 예시

로깅을 켜면 모든 SQL 문이 콘솔에 출력됩니다.

```
[Query] SELECT "id", "name", "email" FROM "user" WHERE "is_active" = $1 [true]  (4ms)
[Query] SELECT "id", "title", "body", "author_id" FROM "post" WHERE "author_id" = $1 [42]  (7ms)
[Query] INSERT INTO "post" ("title", "body", "author_id") VALUES ($1, $2, $3) RETURNING "id" ["Hello World", "My first post", 42]  (12ms)
[Query] UPDATE "user" SET "last_login" = $1 WHERE "id" = $2 ["2026-03-22T10:00:00.000Z", 42]  (3ms)
[Query] DELETE FROM "post" WHERE "id" = $1 [17]  (2ms)
```

각 줄에는 세 가지 정보가 있습니다.

1. **SQL 문**: 파라미터 플레이스홀더(`$1`, `$2`)가 들어 있습니다. 값을 문자열에 끼워 넣지 않고 파라미터화된 쿼리로 보내므로 SQL 인젝션을 막습니다.
2. **파라미터 값**: 대괄호 안에 순서대로 표시됩니다.
3. **실행 시간**: 밀리초 단위입니다.

### 세부 설정

더 세밀하게 제어하려면 항목별 플래그를 담은 객체를 넘깁니다.

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

`em.getQueryLog()`는 쿼리 로그를 구조화된 데이터로 반환합니다.

```typescript
const log = em.getQueryLog();
// [
//   { entityName: "User", sql: "SELECT ...", durationMs: 4, timestamp: 1711234567890 },
//   { entityName: "Post", sql: "SELECT ...", durationMs: 7, timestamp: 1711234567920 },
// ]
```

이 데이터는 성능 테스트에서 쿼리 수를 검증할 때 유용합니다. 커스텀 대시보드를 만들거나 모니터링 시스템에 메트릭을 보낼 때도 씁니다.

---

## N+1 감지

### N+1 문제

N+1 문제는 ORM을 쓰는 애플리케이션에서 가장 흔한 성능 문제입니다.

블로그에 게시글이 100개 있고 게시글마다 작성자가 있다고 가정합니다. 이제 모든 게시글을 작성자 이름과 함께 표시하려고 합니다.

**단순한 방식 (N+1 문제):**

```typescript
const posts = await em.find(Post, {}); // 1 query: SELECT * FROM post

for (const post of posts) {
  console.log(post.author.name);
  // Each access triggers: SELECT * FROM user WHERE id = ?
  // That is 100 more queries, one per post.
}
```

쿼리는 모두 101개입니다. 네트워크 라운드 트립(round trip)을 포함해 쿼리 하나에 10ms가 걸리면 모두 1,010ms입니다. 게시글 목록 하나를 보여 주는 데 1초가 넘게 걸리는 셈입니다.

**해결 방법 (JOIN으로 즉시 로딩):**

```typescript
const posts = await em.find(Post, {
  relations: ["author"],
});
// 1 query: SELECT post.*, user.* FROM post LEFT JOIN user ON post.author_id = user.id
```

쿼리는 1개입니다. 같은 데이터를 약 10ms에 조회합니다. 100배 차이입니다.

N+1 문제는 코드를 작성할 때는 잘못된 점이 보이지 않아서 까다롭습니다. 게시글이 5개뿐인 개발 환경에서는 잘 동작합니다. 문제는 프로덕션에서 데이터가 많아진 뒤에야 드러납니다. Stingerloom의 N+1 감지기는 이 문제를 자동으로 잡아냅니다.

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

`QueryTracker`는 EntityManager를 거치는 모든 쿼리를 감시합니다. 그리고 슬라이딩 타임 윈도 안에서 같은 엔티티를 대상으로 한 쿼리 수를 셉니다. 윈도 크기의 기본값은 100ms입니다. 이 수가 임계값을 넘으면 경고를 출력합니다. 임계값의 기본값은 10회입니다.

```
[QueryTracker] [N+1 WARNING] Entity "User" queried 15+ times in 100ms. Consider using eager loading or relations option.
```

경고는 EntityManager가 살아 있는 동안 엔티티마다 한 번만 출력됩니다. 그래서 같은 경고가 로그를 뒤덮지 않습니다.

### N+1 경고 해결 방법

**방법 1: find 호출 시 `relations` 옵션 사용:**

```typescript
// Before (N+1)
const posts = await em.find(Post, {});

// After (single JOIN query)
const posts = await em.find(Post, {
  relations: ["author"],
});
```

**방법 2: 관계 데코레이터에 `eager: true` 설정:**

```typescript
@ManyToOne(() => User, (user) => user.posts, { eager: true })
@RelationColumn({ name: "author_id" })
author!: User;
```

`eager: true`를 설정하면 게시글을 조회할 때마다 LEFT JOIN으로 작성자를 함께 로드합니다. 그래서 `relations`를 매번 지정하지 않아도 됩니다. 관련 데이터가 거의 항상 필요할 때 쓰면 좋아요.

---

## 느린 쿼리 경고

### 느린 쿼리 감지가 필요한 이유

API 엔드포인트가 800ms에 응답해도 불평하는 사람은 없습니다. 하지만 트래픽이 늘어 그 쿼리가 초당 50번 실행되면 데이터베이스가 포화됩니다. 느린 쿼리 경고는 이런 문제가 장애로 번지기 전에 미리 알립니다.

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

쿼리가 임계값을 넘으면 다음 경고를 출력합니다.

```
[QueryTracker] [SLOW QUERY] 847ms: SELECT "id", "title", "body", "created_at" FROM "post" WHERE "body" LIKE '%search term%' ORDER BY "created_at" DESC
```

### 느린 쿼리 해결 방법

느린 쿼리는 대부분 다음 중 하나에 해당합니다.

**1. 인덱스 누락.** 쿼리가 인덱스를 쓰지 않고 테이블의 모든 행을 스캔합니다. 필터링이나 정렬에 쓰는 컬럼에 `@Index()`를 추가하세요.

```typescript
@Column({ type: "varchar", length: 255 })
@Index()
email!: string;
```

**2. 대용량 테이블 풀 스캔.** 수백만 행이 있는 테이블을 WHERE 절 없이 조회하는 경우입니다. WHERE 절이 어떤 인덱스와도 맞지 않는 경우도 여기에 해당합니다.

**3. 앞쪽 와일드카드 LIKE.** `WHERE body LIKE '%search%'`는 와일드카드가 앞에 있어서 인덱스를 쓰지 못합니다. 대신 전문 검색(full-text search)을 고려하세요.

**4. JOIN 인덱스 누락.** 외래 키 컬럼에 인덱스가 없으면 데이터베이스는 JOIN할 때 행마다 조인 대상 테이블 전체를 스캔합니다.

데이터베이스가 정확히 무엇을 하는지는 다음 절의 EXPLAIN으로 진단합니다.

---

## EXPLAIN: 실행 계획 분석

### EXPLAIN이 중요한 이유

쿼리가 느릴 때 EXPLAIN은 *왜* 느린지 알려 줍니다. EXPLAIN이 보여 주는 데이터베이스의 실행 계획에는 다음 내용이 나옵니다.

- 어떤 테이블을 스캔하는지
- 어떤 인덱스를 쓰거나 무시하는지
- 몇 행을 검사할 것으로 예상하는지

EXPLAIN 없이는 추측에 기대야 합니다. EXPLAIN을 보면 병목이 어디인지 정확히 드러납니다.

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
| `type` | 접근 방식(access type): 데이터베이스가 테이블을 읽는 방식입니다. 값의 뜻은 아래 표에 있습니다. |
| `key` | 옵티마이저가 실제로 사용한 인덱스(없으면 null) |
| `rows` | 검사할 행 수 추정값 |
| `cost` | 추정 비용(MySQL은 filtered 비율, PostgreSQL은 total_cost) |
| `possibleKeys` | 옵티마이저가 고려한 인덱스 목록 |
| `raw` | 데이터베이스가 출력한 원본 결과 전체(객체 배열) |

### MySQL EXPLAIN 출력 읽는 법

MySQL에서 `explain()`을 호출하면 Stingerloom은 `EXPLAIN SELECT ...`를 실행하고 그 결과를 반환합니다. 가장 중요한 필드는 `type`입니다.

| type value | Meaning | Performance |
|------------|---------|-------------|
| `const` | 일치하는 행이 최대 1개(기본 키 또는 고유 인덱스 조회) | Best possible |
| `eq_ref` | 이전 테이블의 행마다 이 테이블에서 1행 읽기(기본 키 JOIN) | Excellent |
| `ref` | 인덱스 값이 일치하는 행을 모두 읽기 | Good |
| `range` | 인덱스로 지정한 범위의 행만 읽기 | Good |
| `index` | 풀 인덱스 스캔(인덱스의 모든 항목 읽기) | Okay |
| `ALL` | 풀 테이블 스캔(테이블의 모든 행 읽기) | Worst: 인덱스 추가 필요 |

**잘 인덱싱된 쿼리 예시 (MySQL)**

```typescript
const result = await em.explain(User, {
  where: { email: "john@example.com" },
});
// result.type = "ref"
// result.key  = "idx_user_email"
// result.rows = 1
```

MySQL은 스캔하지 않고 `idx_user_email` 인덱스로 행을 찾습니다. 검사할 행도 1개로 예상하므로 이 쿼리는 빠릅니다.

**풀 테이블 스캔 예시 (MySQL)**

```typescript
const result = await em.explain(User, {
  where: { bio: "likes cats" },  // no index on bio
});
// result.type = "ALL"
// result.key  = null
// result.rows = 50000
```

`bio` 컬럼에 인덱스가 없어서 MySQL은 테이블의 50,000행을 전부 읽습니다. 인덱스를 추가하거나 쿼리를 다시 검토해야 합니다.

### PostgreSQL EXPLAIN 출력 읽는 법

PostgreSQL의 EXPLAIN 출력은 다른 용어를 씁니다. Stingerloom의 `type` 필드는 PostgreSQL의 노드 유형(node type)에 대응합니다.

| type value | Meaning | Performance |
|------------|---------|-------------|
| `Index Scan` | 인덱스를 읽은 뒤 일치하는 행을 테이블에서 읽기 | Good |
| `Index Only Scan` | 인덱스만 읽기(필요한 컬럼이 모두 인덱스에 있음) | Best |
| `Bitmap Index Scan` | 일치하는 행의 비트맵을 만든 뒤 한꺼번에 읽기 | Good for medium selectivity |
| `Seq Scan` | 순차 스캔(sequential scan): 테이블의 모든 행 읽기 | Worst: 인덱스 추가 필요 |

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

**순차 스캔 예시 (PostgreSQL)**

```typescript
const result = await em.explain(User, {
  where: { bio: "likes cats" },
});
// result.type = "Seq Scan"
// result.key  = null
// result.rows = 50000
// result.cost = 1234.00
```

PostgreSQL의 `cost`는 예상 I/O와 CPU 작업량을 나타내는 추상 단위입니다. 값이 낮을수록 좋습니다. 절댓값보다 인덱스를 추가하기 전후의 비교가 중요합니다.

> 참고: `explain()`은 MySQL, PostgreSQL, SQLite를 지원합니다. SQLite에서는 `EXPLAIN QUERY PLAN`을 실행합니다([EXPLAIN](./entity-manager-querying.md)).

---

## 쿼리 타임아웃

### 쿼리 타임아웃이 필요한 이유

타임아웃이 없는 쿼리는 시한폭탄입니다. 실수로 5천만 행을 스캔하는 쿼리가 실행되면 그 쿼리는 데이터베이스 연결을 끝없이 점유합니다. 잠금을 잡은 채 사용자 입력을 기다리는 트랜잭션도 마찬가지입니다. 연결 풀의 크기가 10이면 이런 쿼리 10개만으로 애플리케이션 전체가 멈춥니다.

쿼리 타임아웃은 서킷 브레이커(circuit breaker) 역할을 합니다. 쿼리가 N밀리초 안에 끝나지 않으면 쿼리를 중단하고 연결을 해제합니다.

### 전역 설정

```typescript
await em.register({
  // ...
  queryTimeout: 5000, // 5-second timeout for all read queries
});
```

### 개별 쿼리 오버라이드

배치 처리나 복잡한 리포트처럼 오래 걸릴 수밖에 없는 쿼리도 있습니다. 이런 쿼리에서는 `timeout` 옵션으로 전역 타임아웃을 오버라이드합니다.

```typescript
const users = await em.find(User, {
  where: { isActive: true },
  timeout: 2000, // 2-second timeout for this query only
});
```

타임아웃이 발생하면 ORM은 `QueryTimeoutError`를 던집니다. 에러 메시지에는 타임아웃 값이 들어갑니다. 취소를 알린 드라이버 에러는 `cause`에 담깁니다.

### 데이터베이스 레벨에서의 동작

Stingerloom은 JavaScript 타이머가 아니라 데이터베이스의 네이티브 타임아웃 기능을 씁니다. 이 차이는 중요합니다. JavaScript의 `setTimeout`은 클라이언트 쪽 대기만 취소합니다. 취소한 뒤에도 서버에서는 쿼리가 계속 실행되어 데이터베이스 자원을 낭비합니다.

| DB | SQL sent before the query | Effect |
|----|--------------------------|--------|
| MySQL | `SET max_execution_time = 5000` | MySQL 서버가 5000ms 뒤 쿼리를 중단합니다. |
| PostgreSQL | `SET LOCAL statement_timeout = '5000ms'` | PostgreSQL이 쿼리를 중단합니다. `SET LOCAL`이므로 설정은 현재 트랜잭션에만 적용됩니다. |
| SQLite | Driver-level timeout | SQLite 드라이버가 타임아웃을 적용합니다. |

---

## 프로덕션 권장 설정

| Setting | Development | Production | 이유 |
|---------|-------------|------------|------|
| `logging.queries` | `true` | `false` | 모든 쿼리를 로그로 남기면 쿼리마다 I/O 오버헤드가 생깁니다. 프로덕션에서는 stdout이 아니라 모니터링 시스템이 이 일을 맡아야 합니다. |
| `logging.slowQueryMs` | `100` | `500`-`1000` | 개발 환경에서는 100ms를 넘는 쿼리를 모두 잡아 좋은 습관을 들입니다. 프로덕션에서는 500ms-1s로 노이즈를 거르고 정말 문제가 되는 쿼리만 잡습니다. |
| `logging.nPlusOne` | `true` | `true` | I/O 없이 타임 윈도 안에서 쿼리 수만 세므로 오버헤드가 거의 없습니다. 그리고 프로덕션 데이터 규모에서만 드러나는 문제를 잡아냅니다. 항상 켜 두세요. |
| `queryTimeout` | 설정하지 않음 | `5000`-`10000` | 개발 환경에서는 디버깅하려면 쿼리가 끝까지 실행되어야 합니다. 프로덕션에서는 폭주하는 쿼리가 연결 풀을 막기 전에 종료해야 합니다. 5-10초는 정상적인 쿼리에는 충분한 시간입니다. 그리고 연쇄 장애를 막을 만큼 짧습니다. |

### 프로덕션 마인드셋 정리

개발 환경에서는 가시성이 최대한 높아야 합니다. 모든 쿼리를 로그로 남기고 100ms를 넘는 쿼리에 경고를 냅니다. 쿼리는 중단하지 않고 끝까지 실행해서 디버깅합니다.

프로덕션에서는 노이즈를 최소로 줄이고 보호는 최대로 높입니다.

- 일반 쿼리 로그는 APM 도구에 맡깁니다.
- 정말 느린 쿼리만 경고로 받습니다.
- 너무 오래 걸리는 쿼리는 강제로 종료합니다.
- N+1 감지는 항상 켜 둡니다. N+1 패턴은 "스테이징에서는 괜찮았는데 프로덕션에서 느려요"라는 문제의 가장 흔한 원인입니다.

---

## 다음 단계

- [설정](./configuration.md): 연결 옵션과 런타임 옵션 전체
- [이벤트 & 구독자](./events.md): 엔티티 생명주기 이벤트에 반응하기
- [프로덕션 가이드](./production-guide.md): 연결 풀 모니터링, graceful shutdown
