# Write Buffer — Advanced

이 페이지는 WriteBuffer의 고급 기능을 다뤄요. 먼저 [Write Buffer — Basics](./write-buffer.md)를 읽고, Identity Map, dirty checking, 엔티티 상태, `flush()`를 이해한 뒤에 진행해 주세요.

---

## Lazy Loading

### N+1 문제와 Lazy Loading이 필요한 이유

블로그에 게시글과 작성자가 있다고 해볼게요. 게시글 10개를 불러오면, 각 게시글의 작성자 정보도 필요할 거예요. 두 가지 방법이 있어요:

**Eager loading** — 한 번에 전부 불러오기:
```typescript
const posts = await buf.find(Post, { relations: ["author"] });
```
```sql
SELECT * FROM "post"
LEFT JOIN "user" ON "user"."id" = "post"."authorId"
-- 1 query, all data at once
```

**Lazy loading** — 필요할 때 불러오기:
```typescript
const posts = await buf.find(Post);
// authors are NOT loaded yet — just the post columns

for (const post of posts) {
  const author = await post.author;  // DB query fires HERE
}
```
```sql
SELECT * FROM "post"
-- then, for each post:
SELECT * FROM "user" WHERE "id" = $1   -- post 1's author
SELECT * FROM "user" WHERE "id" = $2   -- post 2's author
-- ... 10 separate queries (the "N+1" problem)
```

Lazy loading은 비효율적으로 보여요 — 쿼리 1개면 될 걸 11개나 실행하니까요. 그런데 왜 존재할까요?

관계 데이터를 **안 쓸 때**도 있기 때문이에요. 목록 화면에서 게시글 제목만 필요한 경우, 작성자 10명의 아바타, 소개, 설정 등을 전부 불러오면 대역폭과 메모리 낭비예요. Lazy loading은 **실제로 접근할 때만 로드하겠다**는 뜻이에요.

WriteBuffer는 관계 프로퍼티를 자동으로 lazy proxy로 초기화해요. 로드되지 않은 관계에 접근하면 DB 쿼리가 실행되고, 로드된 엔티티는 버퍼의 Identity Map에 등록돼요.

### Lazy proxy의 동작 방식

```typescript
const buf = em.buffer();
const post = await buf.findOne(Post, { where: { id: 1 } });

// post.author is a lazy proxy — NOT the actual author object yet
const author = await post.author;
// → SELECT * FROM "user" WHERE "id" = $1  (the FK value)
// author is now tracked in the buffer's Identity Map

// After the first await, the proxy replaces itself with the actual value.
// Subsequent access is synchronous — no query, no Promise:
console.log(post.author.name);  // "Alice" — works directly
```

네 가지 관계 타입 모두에서 동작해요:

| Relation | Lazy proxy가 반환하는 값 |
|----------|---------------------------|
| `@ManyToOne` | Promise → 단일 부모 엔티티 |
| `@OneToMany` | Promise → 자식 엔티티 배열 |
| `@OneToOne` | Promise → 단일 관련 엔티티 |
| `@ManyToMany` | Promise → 관련 엔티티 배열 (pivot 테이블을 먼저 조회) |

### Promise 함정 — 첫 번째 접근만 해당

JavaScript 언어 제약 때문에, property getter는 동기적이에요. Lazy proxy가 DB 쿼리 결과를 동기적으로 반환할 수는 없어요. 그래서 첫 번째 접근은 **Promise**를 반환해요:

```typescript
// ✗ WRONG — post.author is a Promise on first access
console.log(post.author.name);  // undefined!

// ✓ CORRECT — await the first access
const author = await post.author;
console.log(author.name);  // "Alice"
```

첫 번째 `await` 이후에는 proxy가 실제 값으로 교체돼요. 이후 접근은 모두 동기적이에요.

### Promise 함정을 피하는 세 가지 패턴

**1. `relations`로 Eager load** — proxy도 Promise도 없어요:
```typescript
const post = await buf.findOne(Post, {
  where: { id: 1 },
  relations: ["author"],
});
```
```sql
SELECT * FROM "post"
LEFT JOIN "user" ON "user"."id" = "post"."authorId"
WHERE "post"."id" = $1
```
```typescript
console.log(post.author.name);  // "Alice" — works immediately, no await
```

**2. 첫 접근 시 항상 `await`하기:**
```typescript
const author = await post.author;
// From here, post.author is safe to use synchronously
```

**3. 직접 할당으로 proxy 교체하기:**
```typescript
post.comments = [myComment];  // proxy is replaced with your array
// No DB query, no Promise
```

---

## Pessimistic Locking

### Dirty checking만으로 부족한 경우

Dirty checking은 로드와 flush 사이에 **내가** 변경한 것을 감지해요. 하지만 **다른 트랜잭션**이 그 사이에 변경하면 어떻게 될까요?

```
Transaction A: read balance = 100
Transaction B: read balance = 100
Transaction A: balance -= 50, flush → UPDATE SET balance = 50
Transaction B: balance -= 30, flush → UPDATE SET balance = 70
                                       ↑ WRONG — should be 20!
```

Transaction B는 A의 변경을 몰랐어요. 최종 잔액이 20이어야 하는데 70이 돼버렸어요. 이게 **lost update** 문제예요.

Pessimistic locking은 읽기 시점에 행을 잠가서 이 문제를 방지해요. 다른 트랜잭션은 잠금이 해제될 때까지 대기해요:

```typescript
import { LockMode } from "@stingerloom/orm";

const buf = em.buffer();

const user = await buf.findOne(User, {
  where: { id: 1 },
  lock: LockMode.PESSIMISTIC_WRITE,
});
```

```sql
SELECT * FROM "user" WHERE "id" = $1 FOR UPDATE
-- The row is now LOCKED — other transactions wait here
```

```typescript
user.balance -= 100;
await buf.flush();
```

```sql
UPDATE "user" SET "balance" = $1 WHERE "id" = $2
COMMIT
-- Lock released — other transactions can proceed
```

| Mode | SQL | 동작 |
|------|-----|------|
| `PESSIMISTIC_WRITE` | `FOR UPDATE` | **배타적 잠금** — 다른 트랜잭션이 이 행을 읽거나 쓸 수 없어요 |
| `PESSIMISTIC_READ` | `FOR SHARE` (PostgreSQL) / `LOCK IN SHARE MODE` (MySQL) | **공유 잠금** — 다른 트랜잭션이 읽을 수는 있지만 쓸 수 없어요 |

`lock` 옵션은 `em.findOne()`이나 `em.find()`에서도 직접 사용할 수 있어요 (버퍼 없이도요).

---

## Bulk DML

### updateMany / deleteMany — 엔티티별 추적이 필요 없을 때

조건에 따라 많은 행을 한 번에 업데이트하거나 삭제해야 할 때, 각 엔티티를 개별 로드할 필요가 없어요. `active = false`로 설정하려고 유저 10,000명을 로드하는 건 너무 비효율적이에요:

```typescript
const buf = em.buffer();

buf.updateMany(User, {
  where: { lastLogin: { lt: "2025-01-01" } },
  set: { active: false },
});

buf.deleteMany(Session, { expired: true });

await buf.flush();
```

```sql
BEGIN;

-- Bulk UPDATE (after all tracked entity operations)
UPDATE "user" SET "active" = $1
WHERE "lastLogin" < $2
-- parameters: [false, '2025-01-01']

-- Bulk DELETE
DELETE FROM "session" WHERE "expired" = $1
-- parameters: [true]

COMMIT;
```

이 작업들은 flush 시 raw SQL로 실행되며, 추적 중인 엔티티 연산 **이후에** 수행돼요. 추적 중인 엔티티가 조건에 해당하면, 버퍼가 메모리 상태도 동기화해요:
- Bulk update: 조건에 맞는 추적 엔티티에 SET 값이 메모리에서도 적용돼요
- Bulk delete: 조건에 맞는 추적 엔티티가 Identity Map에서 제거돼요

### Batch INSERT — 여러 행을 하나의 구문으로

기본적으로 유저 3명을 persist하면 INSERT 3개가 개별 실행돼요. `batchInsert: true`로 설정하면 하나의 multi-row INSERT로 합쳐져요:

```typescript
const buf = em.buffer({ batchInsert: true });

buf.persist(user1);
buf.persist(user2);
buf.persist(user3);

await buf.flush();
```

**`batchInsert` 없이** (3 round-trip):
```sql
INSERT INTO "user" ("name", "email") VALUES ($1, $2) RETURNING "id";
INSERT INTO "user" ("name", "email") VALUES ($3, $4) RETURNING "id";
INSERT INTO "user" ("name", "email") VALUES ($5, $6) RETURNING "id";
```

**`batchInsert: true`** (1 round-trip):
```sql
-- PostgreSQL (RETURNING maps generated PKs back to each instance)
INSERT INTO "user" ("name", "email")
VALUES ($1, $2), ($3, $4), ($5, $6)
RETURNING "id"

-- MySQL (LAST_INSERT_ID() returns first ID, then increment for each row)
INSERT INTO `user` (`name`, `email`)
VALUES (?, ?), (?, ?), (?, ?)
```

Multi-row INSERT 후, 버퍼가 생성된 PK를 순서대로 각 인스턴스에 다시 써줘요.

### Batch UPDATE — 여러 행을 하나의 구문으로

`batchUpdate: true`로 설정하면, 같은 타입의 dirty 엔티티 여러 개를 `CASE WHEN`으로 한 번에 업데이트해요:

```typescript
const buf = em.buffer({ batchUpdate: true });

const users = await buf.find(User, {});
users[0].name = "Alice";
users[1].name = "Bob";
users[2].name = "Charlie";

await buf.flush();
```

**`batchUpdate` 없이** (3 round-trip):
```sql
UPDATE "user" SET "name" = $1 WHERE "id" = $2;
UPDATE "user" SET "name" = $3 WHERE "id" = $4;
UPDATE "user" SET "name" = $5 WHERE "id" = $6;
```

**`batchUpdate: true`** (1 round-trip):
```sql
UPDATE "user" SET
  "name" = CASE
    WHEN "id" = $1 THEN $2
    WHEN "id" = $3 THEN $4
    WHEN "id" = $5 THEN $6
    ELSE "name"
  END
WHERE "id" IN ($7, $8, $9)
```

`CASE WHEN`이 각 PK를 새 값에 매핑해요. `ELSE "name"`은 매칭되지 않는 행의 원래 값을 유지하는 안전장치예요 — `WHERE IN`이 이미 업데이트 범위를 제한하고 있지만요.

---

## Flush Events

Flush 중 연산 타입별로 콜백을 등록할 수 있어요. 감사 로그, 캐시 무효화, 데이터 변경 후 알림 전송 등에 유용해요:

```typescript
const buf = em.buffer();

buf.onFlushEvent("preUpdate", (event) => {
  console.log(`About to update ${event.entity.name}`, event.data);
  // event.data contains only the CHANGED columns
});

buf.onFlushEvent("postInsert", (event) => {
  console.log(`Inserted ${event.entity.name}`, event.instance);
  // event.instance is the entity with its generated PK
});
```

| Event | 실행 시점 | Payload |
|-------|-----------|---------|
| `preInsert` | 각 INSERT 전 | `{ entity, instance, data }` |
| `postInsert` | 각 INSERT 후 | `{ entity, instance, data }` |
| `preUpdate` | 각 UPDATE 전 | `{ entity, instance, data }` — `data` = 변경된 컬럼만 |
| `postUpdate` | 각 UPDATE 후 | `{ entity, instance, data }` |
| `preDelete` | 각 DELETE 전 | `{ entity, criteria }` — `criteria` = WHERE 조건 |
| `postDelete` | 각 DELETE 후 | `{ entity, criteria }` |

### 예시: 감사 로그

```typescript
buf.onFlushEvent("postUpdate", (event) => {
  auditLog.record({
    table: event.entity.name,
    action: "UPDATE",
    changes: event.data,     // { name: "Bob" } — only what changed
    timestamp: new Date(),
  });
});
```

---

## Read-only Entities

엔티티를 read-only로 지정하면 flush 시 dirty checking을 건너뛰어요. 실수로 프로퍼티를 수정해도 변경 사항이 DB에 반영되지 않아요:

```typescript
const buf = em.buffer();
const config = await buf.findOne(AppConfig, { where: { key: "site-name" } });
buf.markReadOnly(config);

config.value = "oops";   // mutation happens in memory...
await buf.flush();        // ...but NO UPDATE is generated

buf.isReadOnly(config);  // true
```

참조 데이터(코드 테이블, 설정 값 등) 처럼 버퍼를 통해 절대 수정하면 안 되는 데이터에 사용하세요. 성능적으로도 약간의 이점이 있어요 — 버퍼가 read-only 엔티티의 snapshot 비교를 건너뛰니까요.

---

## Change Tracking Policy

### Dirty checking의 비용

`flush()`를 호출할 때마다, 버퍼는 추적 중인 모든 엔티티의 현재 상태를 snapshot과 비교해요. 엔티티 10개면 순식간이에요. 하지만 10,000개라면 — deep equality 비교 10,000번은 무시 못 해요.

### DEFERRED_IMPLICIT (기본값) — 전부 검사

추적 중인 모든 엔티티를 flush 시 변경 여부 확인해요. 모든 상황에서 정확하고, 기본값이에요:

```typescript
const buf = em.buffer();
// changeTracking defaults to DEFERRED_IMPLICIT
const user = await buf.findOne(User, { where: { id: 1 } });
user.name = "updated";
await buf.flush();  // automatically detects the change
```

### DEFERRED_EXPLICIT — 명시적으로 지정한 것만 검사

Explicit tracking에서는 직접 dirty로 표시한 엔티티만 검사해요:

```typescript
import { ChangeTrackingPolicy, bufferPlugin } from "@stingerloom/orm";

em.extend(bufferPlugin({
  changeTracking: ChangeTrackingPolicy.DEFERRED_EXPLICIT,
}));

const buf = em.buffer();
const user = await buf.findOne(User, { where: { id: 1 } });
user.name = "updated";

await buf.flush();  // NO UPDATE — user was not marked dirty

buf.markDirty(user);
await buf.flush();  // NOW the UPDATE executes
```

```sql
-- Only on the second flush:
UPDATE "user" SET "name" = $1 WHERE "id" = $2
-- parameters: ['updated', 1]
```

### 언제 어떤 정책을 쓸까

| Policy | flush당 dirty check 비용 | 적합한 경우 |
|--------|---------------------------|------------|
| `DEFERRED_IMPLICIT` | O(추적 중인 전체 엔티티) | 대부분의 애플리케이션 (추적 엔티티 1,000개 미만) |
| `DEFERRED_EXPLICIT` | O(표시된 엔티티만) | 읽기 위주 워크로드에서 추적 엔티티는 많지만 변경은 적은 경우 |

---

## Flush Modes

### 버퍼가 언제 자동으로 flush할까?

기본값(`MANUAL`)에서는 버퍼가 자동 flush하지 않아요 — 준비됐을 때 직접 `flush()`를 호출해야 해요. 그래서 새 유저를 `persist()`하고 바로 `find()`하면, 아직 메모리에만 있기 때문에 결과에 나타나지 않아요.

Flush mode는 쿼리 전에 버퍼가 대기 중인 작업을 자동 flush할지 제어해요:

```typescript
import { FlushMode, bufferPlugin } from "@stingerloom/orm";

em.extend(bufferPlugin({ flushMode: FlushMode.AUTO }));
```

| Mode | 동작 | 사용 시점 |
|------|------|-----------|
| `MANUAL` | 자동 flush 없음. 직접 `flush()`를 호출해요. | 완전한 제어, 최고의 성능. DB 접근 타이밍을 직접 결정해요. |
| `AUTO` | 대기 중인 작업이 있으면 `find()`/`findOne()` 전에 자동 flush해요. | 쿼리가 항상 대기 중인 변경을 반영해요. 쿼리당 약간의 오버헤드가 있어요. |
| `COMMIT` | `MANUAL`과 동일해요. | 일부 코드베이스에서 명시적 표현을 위한 별칭이에요. |
| `ALWAYS` | 대기 작업 유무와 관계없이 모든 쿼리 전에 자동 flush해요. | 디버깅 전용 — DB와 버퍼가 항상 동기화돼요. |

### 예시: AUTO mode

```typescript
const buf = em.buffer();  // flushMode: AUTO

buf.save(User, { name: "Alice" });
// Alice is queued but NOT in the database yet

const users = await buf.find(User, {});
// AUTO mode detects pending work → flush() → INSERT Alice → then SELECT
// Alice IS in the results
```

AUTO mode 없이는 Alice를 결과에서 보려면 `find()` 전에 `buf.flush()`를 호출해야 해요.

---

## PersistentCollection

버퍼가 `@OneToMany`나 `@ManyToMany` 관계를 가진 엔티티를 추적할 때, 컬렉션의 snapshot(배열에 어떤 항목이 있는지)을 저장해요. Flush 시 현재 배열을 snapshot과 비교해서 적절한 INSERT/DELETE 연산을 생성해요.

미묘한 점이 있어요: 버퍼는 flush 시점에만 확인해요. 배열에 항목을 push해도, diff를 수행할 때까지 버퍼가 모를 수 있어요. `DEFERRED_EXPLICIT` change tracking에서는 아예 놓칠 수도 있고요.

`wrapCollection()`은 배열을 Proxy로 감싸서 변경을 실시간으로 감지하는 방법이에요:

```typescript
const buf = em.buffer();
const post = await buf.findOne(Post, {
  where: { id: 1 },
  relations: ["comments"],
});

buf.wrapCollection(post, "comments");

// Now mutations are detected immediately:
post.comments.push(new Comment({ body: "auto-detected!" }));
// The proxy fires onChange → marks the parent as dirty
```

Proxy는 모든 배열 변경 메서드를 가로채요:
- `push`, `pop`, `shift`, `unshift`, `splice`
- `sort`, `reverse`, `fill`, `copyWithin`
- Index 할당: `arr[0] = newValue`
- Length 변경: `arr.length = 0`

`Array.isArray()`, spread (`[...arr]`), 구조 분해 할당과 완전히 호환돼요.

---

## Nested Unit of Work

### 문제: 부분 롤백

실패할 수 있는 작업을 시도하되, 전체 트랜잭션은 중단하고 싶지 않을 때가 있어요:

```typescript
// Scenario: importing 100 products from a CSV
// Some products have invalid data — we want to skip them, not abort everything

const buf = em.buffer();

for (const row of csvRows) {
  // If this fails, we don't want to lose the 50 products we already processed
  buf.persist(toProduct(row));
}

await buf.flush();  // If ONE product fails, ALL 100 are rolled back!
```

### 해결: SAVEPOINT를 사용하는 중첩 버퍼

중첩 버퍼는 연산을 `SAVEPOINT`로 감싸요. SAVEPOINT는 트랜잭션 내의 "체크포인트"예요. 중첩 버퍼가 실패하면 그 연산만 롤백되고 — 부모 버퍼의 작업은 보존돼요.

```typescript
const buf = em.buffer();

for (const row of csvRows) {
  const nested = buf.beginNested();
  try {
    nested.save(Product, toProduct(row));
    await nested.flush();
    // → SAVEPOINT sp_nested_xxx → INSERT → (success: keep)
  } catch {
    // → ROLLBACK TO SAVEPOINT sp_nested_xxx
    // Only THIS product's INSERT is undone
    console.log(`Skipped invalid row: ${row.name}`);
  }
}

// Parent buffer's operations are unaffected
await buf.flush();
```

SQL 타임라인은 이렇게 돼요:

```sql
BEGIN;                                   -- parent transaction

SAVEPOINT sp_nested_1709234567_a3f2;     -- nested buffer 1
INSERT INTO "product" ...;               -- success
-- savepoint kept

SAVEPOINT sp_nested_1709234568_b4c1;     -- nested buffer 2
INSERT INTO "product" ...;               -- ERROR! constraint violation
ROLLBACK TO SAVEPOINT sp_nested_1709234568_b4c1;  -- only this INSERT undone

SAVEPOINT sp_nested_1709234569_c5d0;     -- nested buffer 3
INSERT INTO "product" ...;               -- success
-- savepoint kept

COMMIT;                                  -- products 1 and 3 saved, product 2 skipped
```

### 중첩 버퍼를 사용하면 좋은 경우

- **부분 롤백** — 전체 트랜잭션을 중단하지 않고 실패할 수 있는 작업 시도
- **조건부 삽입** — 제약 조건 위반이 아니면 삽입, 위반이면 건너뛰기
- **다단계 워크플로우** — 각 단계가 독립적으로 성공하거나 실패할 수 있음

---

## Accumulate and Retry Pattern

`retainAfterFlush: true` (기본값)로 설정하면, flush 성공 후 추적 중인 엔티티의 snapshot을 다시 찍어요. 이걸로 축적-flush-축적-flush 사이클을 구현할 수 있어요:

```typescript
const buf = em.buffer({ retainAfterFlush: true });
const user = await buf.findOne(User, { where: { id: 1 } });

// First batch of changes
user.name = "Alice";
await buf.flush();
```

```sql
UPDATE "user" SET "name" = $1 WHERE "id" = $2
-- parameters: ['Alice', 1]
-- snapshot refreshed: { id: 1, name: "Alice", email: "...", age: 25 }
```

```typescript
// Second batch — only NEW changes are flushed
user.age = 30;
await buf.flush();
```

```sql
UPDATE "user" SET "age" = $1 WHERE "id" = $2
-- parameters: [30, 1]
-- name is NOT included — it's already "Alice" in the refreshed snapshot
```

Flush가 실패하면 큐가 보존되어서, 문제를 수정하고 재시도할 수 있어요:

```typescript
try {
  await buf.flush();
} catch {
  // Fix the issue...
  await buf.flush();  // retries with the same queued operations
}
```

---

## Configuration Reference

모든 옵션은 `bufferPlugin()` (전역 기본값) 또는 `em.buffer()` (인스턴스별 오버라이드)에 전달할 수 있어요:

| Option | Type | Default | 설명 |
|--------|------|---------|------|
| `retainAfterFlush` | `boolean` | `true` | Flush 후 추적 엔티티의 snapshot을 갱신해서, 축적-flush 사이클을 사용할 수 있게 해요 |
| `cascade` | `boolean` | `true` | 관계 메타데이터를 통해 persist/remove/merge/detach를 전파해요 |
| `orphanRemoval` | `boolean` | `false` | 컬렉션 배열에서 제거된 O2M 자식을 자동 삭제해요 |
| `manyToManySync` | `boolean` | `true` | 컬렉션 변경 시 M2M pivot 테이블 행을 자동 동기화해요 |
| `flushMode` | `FlushMode` | `MANUAL` | 쿼리 전 자동 flush 시점 |
| `autoFlush` | `boolean` | `false` | `FlushMode.AUTO`의 단축 옵션 |
| `changeTracking` | `ChangeTrackingPolicy` | `DEFERRED_IMPLICIT` | 엔티티 dirty check 시점 |
| `batchInsert` | `boolean` | `false` | 같은 엔티티 타입의 INSERT 여러 개를 하나의 multi-row 구문으로 합쳐요 |
| `batchUpdate` | `boolean` | `false` | 같은 엔티티 타입의 UPDATE 여러 개를 하나의 CASE WHEN 구문으로 합쳐요 |
| `onFlush` | `(result) => void` | — | Flush 성공 후 콜백 |
| `logging` | `boolean` | `false` | 디버깅용 상세 라이프사이클 로그 |

---

## Next Steps

- [Write Buffer — Basics](./write-buffer.md) — 핵심 개념, Identity Map, dirty checking, flush
- [Plugin System](./plugins.md) — 커스텀 플러그인 작성
- [Events & Subscribers](./events.md) — 엔티티 라이프사이클 이벤트
- [API Reference](./api-reference.md) — 전체 메서드 시그니처
