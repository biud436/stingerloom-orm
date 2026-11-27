# Write Buffer — Advanced

WriteBuffer의 고급 기능을 쓰려면 Identity Map, 변경 추적(dirty checking), 엔티티 상태, `flush()`를 먼저 이해해야 합니다. 아직 읽지 않았다면 [Write Buffer — Basics](./write-buffer.md)부터 읽으세요.

---

## Lazy Loading

### N+1 문제와 Lazy Loading이 필요한 이유

게시글과 작성자가 있는 블로그를 생각해 보겠습니다. 게시글 10개를 조회하면 대개 각 게시글의 작성자도 필요합니다. 방법은 두 가지입니다.

**즉시 로딩**(eager loading): 한 번에 전부 로드하기
```typescript
const posts = await buf.find(Post, { relations: ["author"] });
```
```sql
SELECT * FROM "post"
LEFT JOIN "user" ON "user"."id" = "post"."authorId"
-- 1 query, all data at once
```

**지연 로딩**(lazy loading): 필요할 때 로드하기
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

지연 로딩은 낭비처럼 보입니다. 쿼리 1개면 될 일을 11개로 실행하기 때문입니다. 그래도 지연 로딩이 필요한 이유가 있습니다.

관계 데이터를 아예 쓰지 않을 때도 있기 때문입니다. 목록 화면에는 게시글 제목만 필요할 수 있습니다. 이때 작성자 10명의 아바타, 소개, 설정까지 전부 즉시 로딩하면 대역폭과 메모리가 낭비됩니다. 지연 로딩은 실제로 접근할 때만 로드한다는 뜻입니다.

WriteBuffer는 관계 속성을 자동으로 지연 로딩 프록시(lazy proxy)로 초기화합니다. 로드되지 않은 관계에 접근하면 DB 쿼리가 실행됩니다. 그리고 로드된 엔티티는 버퍼의 Identity Map에 등록됩니다.

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

네 가지 관계 타입 모두에서 동작합니다.

| 관계 | 프록시가 반환하는 값 |
|----------|---------------------------|
| `@ManyToOne` | Promise → 단일 부모 엔티티 |
| `@OneToMany` | Promise → 자식 엔티티 배열 |
| `@OneToOne` | Promise → 단일 관련 엔티티 |
| `@ManyToMany` | Promise → 관련 엔티티 배열 (피벗 테이블을 먼저 조회) |

### Promise 함정 — 첫 번째 접근만 해당

JavaScript의 속성 getter는 언어 제약 때문에 동기적으로 동작합니다. 그래서 프록시는 DB 쿼리 결과를 동기적으로 반환할 수 없습니다. 첫 번째 접근이 Promise를 반환하는 것은 이 때문입니다.

```typescript
// ✗ WRONG — post.author is a Promise on first access
console.log(post.author.name);  // undefined!

// ✓ CORRECT — await the first access
const author = await post.author;
console.log(author.name);  // "Alice"
```

첫 번째 `await` 뒤에는 프록시가 실제 값으로 교체됩니다. 그 뒤의 접근은 모두 동기적입니다.

### Promise 함정을 피하는 세 가지 패턴

**1. `relations`로 즉시 로딩하기:** 프록시도 Promise도 없습니다.
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

**2. 첫 접근에서 항상 `await`하기:**
```typescript
const author = await post.author;
// From here, post.author is safe to use synchronously
```

**3. 직접 할당해서 프록시 교체하기:**
```typescript
post.comments = [myComment];  // proxy is replaced with your array
// No DB query, no Promise
```

### 직렬화는 안전해요 — 로드 안 된 관계는 건너뜁니다

로드되지 않은 지연 로딩 속성은 non-enumerable입니다. 그래서 `JSON.stringify`, 객체 스프레드, `Object.keys`, 로그 출력, 테스트 pretty-printer는 모두 그 속성을 건너뜁니다. 숨은 쿼리도 실행되지 않고 방치된 Promise도 생기지 않습니다.

```typescript
const post = await buf.findOne(Post, { where: { id: 1 } });

JSON.stringify(post);
// → {"id":1,"title":"..."}: "author"와 "comments"가 없고 쿼리도 실행되지 않습니다

await post.comments;      // 관계를 로드합니다
JSON.stringify(post);
// → {"id":1,"title":"...","comments":[...]}: 로드된 관계는 정상적으로 직렬화됩니다
```

관계를 한 번 로드하거나 직접 할당하면 그 속성은 평범한 enumerable 값이 됩니다. 그리고 다른 필드처럼 직렬화됩니다. 그래서 직렬화 결과에는 항상 실제로 로드된 것만 들어갑니다. `res.json(entity)` 같은 API 응답이 예상하지 못한 지연 로딩 쿼리를 실행하는 일도 없습니다.

속성에 직접 접근할 때의 동작은 그대로입니다. `post.comments`를 읽으면 여전히 지연 로딩이 실행됩니다. 로드가 실패하면 `await`한 호출자에게는 Promise가 거부됩니다. 하지만 await 없이 버려진 동기 접근이 unhandled rejection으로 프로세스를 종료시키는 일은 없습니다. 그리고 다음에 접근할 때 쿼리를 다시 시도합니다.

버퍼의 쓰기 경로도 같은 원칙을 따릅니다. `flush()`, `detach()`, cascade 순회는 이미 로드된 관계만 순회합니다. 로드되지 않은 컬렉션을 확인하려고 flush 도중에 조회하는 일은 없습니다.

---

## Pessimistic Locking

### Dirty checking만으로 부족한 경우

변경 추적은 로드와 flush 사이에 내가 바꾼 값을 찾아냅니다. 그렇다면 그 사이에 다른 트랜잭션이 값을 바꾸면 어떻게 될까요?

```
Transaction A: read balance = 100
Transaction B: read balance = 100
Transaction A: balance -= 50, flush → UPDATE SET balance = 50
Transaction B: balance -= 30, flush → UPDATE SET balance = 70
                                       ↑ WRONG — should be 20!
```

트랜잭션 B는 A가 바꾼 값을 알지 못했습니다. 그래서 최종 잔액은 20이어야 하는데 70이 됐습니다. 이것이 **갱신 손실**(lost update) 문제입니다.

비관적 잠금(pessimistic locking)은 읽는 시점에 행을 잠가서 이 문제를 막습니다. 다른 트랜잭션은 잠금이 풀릴 때까지 기다려야 합니다.

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
| `PESSIMISTIC_WRITE` | `FOR UPDATE` | 배타 잠금: 다른 트랜잭션이 이 행을 읽거나 쓸 수 없음 |
| `PESSIMISTIC_READ` | `FOR SHARE` (PostgreSQL) / `LOCK IN SHARE MODE` (MySQL) | 공유 잠금: 다른 트랜잭션이 읽을 수는 있지만 쓸 수 없음 |

`lock` 옵션은 버퍼 없이 `em.findOne()`이나 `em.find()`에서도 바로 쓸 수 있습니다.

---

## Bulk DML

### updateMany / deleteMany — 엔티티별 추적이 필요 없을 때

조건에 맞는 많은 행을 한 번에 갱신하거나 삭제할 때가 있습니다. 이때 엔티티를 하나씩 로드할 필요는 없습니다. `active = false`로 바꾸려고 사용자 10,000명을 로드하면 지나치게 느립니다.

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

이 작업은 flush할 때 raw SQL 문으로 실행됩니다. 실행 순서는 추적 중인 엔티티의 연산이 모두 끝난 뒤입니다. 추적 중인 엔티티가 조건에 맞으면 버퍼는 메모리의 상태도 맞춰 둡니다.
- Bulk update: 조건에 맞는 추적 엔티티에 SET 값을 메모리에서도 적용합니다.
- Bulk delete: 조건에 맞는 추적 엔티티를 Identity Map에서 제거합니다.

### Batch INSERT — 여러 행을 하나의 구문으로

기본 설정에서는 사용자 3명을 persist하면 INSERT 3개가 따로 실행됩니다. `batchInsert: true`로 설정하면 multi-row INSERT 하나로 합쳐집니다.

```typescript
const buf = em.buffer({ batchInsert: true });

buf.persist(user1);
buf.persist(user2);
buf.persist(user3);

await buf.flush();
```

**`batchInsert` 없이** (라운드 트립 3번):
```sql
INSERT INTO "user" ("name", "email") VALUES ($1, $2) RETURNING "id";
INSERT INTO "user" ("name", "email") VALUES ($3, $4) RETURNING "id";
INSERT INTO "user" ("name", "email") VALUES ($5, $6) RETURNING "id";
```

**`batchInsert: true`** (그룹당 INSERT 한 번):
```sql
-- PostgreSQL (RETURNING이 생성된 키와 함께 각 행을 반환함)
INSERT INTO "user" ("name", "email")
VALUES ($1, $2), ($3, $4), ($5, $6)
RETURNING *

-- MySQL (키는 LAST_INSERT_ID()부터 이어지고 행은 SELECT 한 번으로 다시 조회함)
INSERT INTO `user` (`name`, `email`)
VALUES (?, ?), (?, ?), (?, ?);
SELECT ... FROM `user` WHERE `id` IN (?, ?, ?)
```

그룹은 `saveMany()`로 저장합니다. 그래서 각 행에는 `save()`와 똑같이 컬럼 기본값, 트랜스포머, JSON 값, `tenant_column`의 테넌트 컬럼, 생명주기 훅, 이벤트, 구독자가 적용됩니다. 그다음 버퍼는 생성된 키와 데이터베이스가 채운 값을 순서대로 각 인스턴스에 옮겨 적습니다.

다음과 같은 그룹은 여전히 `save()`로 한 행씩 저장합니다.

- 인스턴스가 하나뿐일 때
- 복합 기본 키일 때
- SQLite일 때
- `SINGLE_TABLE`이나 `JOINED` 계층의 엔티티일 때. 이 계층의 행에는 구분 값이 필요하고 `JOINED` 자식은 테이블 두 개에 나뉘어 있기 때문입니다.

인스턴스에 키가 이미 있으면 `saveMany()`도 한 행씩 저장합니다.

### Batch UPDATE — 여러 행을 하나의 구문으로

`batchUpdate: true`로 설정하면 같은 타입의 dirty 엔티티 여러 개를 `CASE WHEN`을 쓴 SQL 문 하나로 갱신합니다.

```typescript
const buf = em.buffer({ batchUpdate: true });

const users = await buf.find(User, {});
users[0].name = "Alice";
users[1].name = "Bob";
users[2].name = "Charlie";

await buf.flush();
```

**`batchUpdate` 없이** (라운드 트립 3번):
```sql
UPDATE "user" SET "name" = $1 WHERE "id" = $2;
UPDATE "user" SET "name" = $3 WHERE "id" = $4;
UPDATE "user" SET "name" = $5 WHERE "id" = $6;
```

**`batchUpdate: true`** (라운드 트립 1번):
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

`CASE WHEN` 식은 각 기본 키를 새 값에 매핑합니다. `ELSE "name"`은 매칭되지 않는 행이 원래 값을 유지하게 합니다. `WHERE IN`이 이미 갱신 범위를 제한하므로 이 절은 만일을 대비한 안전장치입니다.

---

## Flush Events

flush 중에 실행되는 콜백을 연산 타입별로 등록할 수 있습니다. 감사 로그, 캐시 무효화, 데이터 변경 뒤의 알림 전송에 유용합니다.

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
| `preUpdate` | 각 UPDATE 전 | `{ entity, instance, data }` (`data` = 변경된 컬럼만) |
| `postUpdate` | 각 UPDATE 후 | `{ entity, instance, data }` |
| `preDelete` | 각 DELETE 전 | `{ entity, criteria }` (`criteria` = WHERE 조건) |
| `postDelete` | 각 DELETE 후 | `{ entity, criteria }` |

이벤트는 배치 경로에서도 실행됩니다. `batchInsert`나 `batchUpdate`를 켜도 multi-row INSERT나 CASE WHEN UPDATE에 들어간 엔티티마다 `preInsert`/`postInsert` 쌍이나 `preUpdate`/`postUpdate` 쌍이 따로 실행됩니다. `preInsert`와 `preUpdate`는 배치 SQL 문을 만들기 전에 실행됩니다. 그래서 리스너에서 엔티티를 수정하면 그 값이 저장됩니다. 행 단위 경로와 같은 계약입니다.

엔티티 생명주기 훅은 flush가 `save()`나 `saveMany()`로 저장할 때 실행됩니다. `@BeforeInsert`, `@BeforeUpdate` 같은 데코레이터나 defineEntity의 `hooks`가 여기에 해당합니다. 모든 INSERT와 변경된 인스턴스의 UPDATE에서 훅이 실행됩니다. 다만 `batchUpdate`가 CASE WHEN SQL 문 하나로 합친 UPDATE에서는 훅이 실행되지 않습니다. 훅은 인스턴스의 컬럼 값을 담은 복사본에서 실행됩니다. 그래서 훅이 컬럼에 쓴 값은 저장된 뒤 인스턴스로 옮겨집니다. 반면 그 밖에 `this`에 넣은 값은 복사본에만 남습니다.

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

엔티티를 read-only로 지정하면 flush할 때 변경 추적을 건너뜁니다. 실수로 속성을 수정해도 변경 사항은 DB에 저장되지 않습니다.

```typescript
const buf = em.buffer();
const config = await buf.findOne(AppConfig, { where: { key: "site-name" } });
buf.markReadOnly(config);

config.value = "oops";   // mutation happens in memory...
await buf.flush();        // ...but NO UPDATE is generated

buf.isReadOnly(config);  // true
```

코드 테이블이나 설정 값 같은 참조 데이터처럼 버퍼로 절대 수정하면 안 되는 데이터에 사용하세요. 성능에도 약간 이점이 있습니다. 버퍼가 read-only 엔티티의 스냅샷 비교를 건너뛰기 때문입니다.

---

## Change Tracking Policy

### Dirty checking의 비용

`flush()`를 호출할 때마다 버퍼는 추적 중인 모든 엔티티의 현재 상태를 스냅샷과 비교합니다. 엔티티가 10개라면 순식간입니다. 하지만 10,000개라면 깊은 비교(deep equality)를 10,000번 해야 하므로 비용을 무시할 수 없습니다.

### DEFERRED_IMPLICIT (기본값) — 전부 검사

flush할 때 추적 중인 모든 엔티티의 변경 여부를 확인합니다. 어떤 상황에서도 정확하며 이 정책이 기본값입니다.

```typescript
const buf = em.buffer();
// changeTracking defaults to DEFERRED_IMPLICIT
const user = await buf.findOne(User, { where: { id: 1 } });
user.name = "updated";
await buf.flush();  // automatically detects the change
```

### DEFERRED_EXPLICIT — 명시적으로 지정한 것만 검사

명시적 추적에서는 직접 dirty로 표시한 엔티티만 검사합니다.

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

| 정책 | flush당 변경 검사 비용 | 적합한 경우 |
|--------|---------------------------|------------|
| `DEFERRED_IMPLICIT` | O(추적 중인 전체 엔티티) | 대부분의 애플리케이션 (추적 엔티티 1,000개 미만) |
| `DEFERRED_EXPLICIT` | O(표시된 엔티티만) | 읽기 위주 워크로드에서 추적 엔티티는 많지만 변경은 적은 경우 |

---

## Flush Modes

### 버퍼가 언제 자동으로 flush할까?

기본값인 `MANUAL`에서는 버퍼가 자동으로 flush하지 않습니다. 준비가 되면 직접 `flush()`를 호출해야 합니다. 그래서 새 사용자를 `persist()`한 뒤 바로 `find()`로 모든 사용자를 조회하면 새 사용자는 결과에 나타나지 않습니다. 아직 메모리에만 있기 때문입니다.

flush 모드에 따라 버퍼가 쿼리를 실행하기 전에 대기 중인 작업을 자동으로 flush할지가 달라집니다.

```typescript
import { FlushMode, bufferPlugin } from "@stingerloom/orm";

em.extend(bufferPlugin({ flushMode: FlushMode.AUTO }));
```

| Mode | 동작 | 사용 시점 |
|------|------|-----------|
| `MANUAL` | 자동 flush 없음. 직접 `flush()`를 호출합니다. | 완전한 제어, 최고의 성능. DB에 접근할 시점을 직접 결정합니다. |
| `AUTO` | 대기 중인 작업이 있으면 `find()`/`findOne()` 전에 자동으로 flush합니다. | 쿼리 결과에 대기 중인 변경이 항상 반영됩니다. 쿼리마다 약간의 오버헤드가 있습니다. |
| `COMMIT` | `MANUAL`의 deprecated 별칭입니다. 동작이 완전히 같습니다. | 새 코드에서는 사용하지 마세요. 버퍼는 트랜잭션 생명주기에 묶여 있지 않습니다. 그래서 JPA식 "커밋 시점 flush"를 지원할 수 없습니다. |
| `ALWAYS` | 대기 중인 작업이 없어도 모든 쿼리 전에 자동으로 flush합니다. | 디버깅 전용. DB와 버퍼가 항상 동기화됩니다. |

### 예시: AUTO mode

```typescript
const buf = em.buffer();  // flushMode: AUTO

buf.save(User, { name: "Alice" });
// Alice is queued but NOT in the database yet

const users = await buf.find(User, {});
// AUTO mode detects pending work → flush() → INSERT Alice → then SELECT
// Alice IS in the results
```

AUTO 모드를 쓰지 않을 때 결과에서 Alice를 보려면 `find()` 전에 `buf.flush()`를 호출해야 합니다.

---

## PersistentCollection

버퍼는 `@OneToMany`나 `@ManyToMany` 관계를 가진 엔티티를 추적할 때 컬렉션의 스냅샷을 저장합니다. 스냅샷에는 배열에 어떤 항목이 있는지가 기록됩니다. flush할 때는 현재 배열을 스냅샷과 비교해서 필요한 INSERT와 DELETE 연산을 생성합니다.

다만 주의할 점이 있습니다. 버퍼는 flush 시점에만 확인합니다. 배열에 항목을 push해도 버퍼는 컬렉션을 비교하기 전까지 그 사실을 모릅니다. `DEFERRED_EXPLICIT` 변경 추적 정책에서는 변경을 아예 놓칠 수도 있습니다.

`wrapCollection()`은 배열을 Proxy로 감싸서 이 문제를 해결합니다. 이 Proxy는 변경을 실시간으로 감지합니다.

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

Proxy는 배열을 변경하는 모든 메서드를 가로챕니다.
- `push`, `pop`, `shift`, `unshift`, `splice`
- `sort`, `reverse`, `fill`, `copyWithin`
- 인덱스 할당: `arr[0] = newValue`
- 길이 변경: `arr.length = 0`

`Array.isArray()`, 스프레드(`[...arr]`), 구조 분해 할당과도 완전히 호환됩니다.

---

## Nested Unit of Work

### 문제: 부분 롤백

실패할 수 있는 작업을 시도하면서도 전체 트랜잭션은 중단하고 싶지 않을 때가 있습니다.

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

중첩 버퍼는 연산을 `SAVEPOINT`로 감쌉니다. 세이브포인트는 트랜잭션 안의 "체크포인트"입니다. 중첩 버퍼가 실패하면 그 연산만 롤백되고 부모 버퍼의 작업은 보존됩니다.

세이브포인트는 트랜잭션 안에서만 존재합니다. 그래서 워크플로 전체를 `em.transaction()` 안에서 실행해야 합니다. 부모 버퍼든 중첩 버퍼든 모든 `flush()`는 자기 트랜잭션을 여는 대신 이 바깥 트랜잭션에 합류합니다.

```typescript
await em.transaction(async () => {
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
});
```

SQL 실행 순서는 다음과 같습니다.

```sql
BEGIN;                                   -- em.transaction()

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

중첩 flush가 성공한 뒤에 바깥 `em.transaction()` 자체가 실패하면 그 롤백이 중첩 작업까지 되돌립니다. 세이브포인트가 실제로 바깥 트랜잭션의 일부이기 때문입니다.

`em.transaction()`으로 감싸는 일을 생략하면 안 됩니다. 감싸지 않으면 모든 `flush()`가 각자 트랜잭션을 열고 바로 커밋합니다. 그러면 중첩 버퍼의 세이브포인트는 자기 flush 범위 밖으로 넓어지지 못합니다. 그래서 작업이 곧바로 따로 커밋되고 나중에 "부모"를 롤백해도 되돌릴 수 없습니다. 중첩 `flush()`가 바깥 트랜잭션 없이 실행되면 버퍼가 경고 로그를 남깁니다.

### 중첩 버퍼를 사용하면 좋은 경우

- **부분 롤백**: 전체 트랜잭션을 중단하지 않고 실패할 수 있는 작업을 시도할 때
- **조건부 삽입**: 제약 조건을 위반하지 않으면 삽입하고 위반하면 건너뛸 때
- **다단계 워크플로**: 각 단계가 따로 성공하거나 실패할 수 있을 때

---

## Accumulate and Retry Pattern

`retainAfterFlush`의 기본값은 `true`입니다. 이 설정에서는 flush가 성공한 뒤 버퍼가 추적 중인 엔티티의 스냅샷을 다시 찍습니다. 그래서 변경을 모았다가 flush하고 다시 모았다가 flush하는 사이클을 만들 수 있습니다.

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

flush가 실패하면 큐가 보존됩니다. 그래서 문제를 고친 뒤 다시 시도할 수 있습니다.

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

모든 옵션은 `bufferPlugin()`이나 `em.buffer()`에 넘길 수 있습니다. `bufferPlugin()`에 넘긴 값은 전역 기본값이 됩니다. 그리고 `em.buffer()`에 넘긴 값은 그 인스턴스에서만 기본값을 덮어씁니다.

| Option | Type | Default | 설명 |
|--------|------|---------|------|
| `retainAfterFlush` | `boolean` | `true` | flush 후 추적 엔티티의 스냅샷을 갱신합니다. 그래서 축적-flush 사이클을 쓸 수 있습니다 |
| `cascade` | `boolean \| BufferCascadeOptions` | `true` | 관계 메타데이터를 따라 persist/remove/merge/detach를 전파합니다. `{ persist, merge, remove, refresh }` 객체로 지정하면 작업별로 켜고 끌 수 있습니다 |
| `orphanRemoval` | `boolean` | `false` | 컬렉션 배열에서 제거된 `@OneToMany` 자식을 자동으로 삭제합니다 |
| `manyToManySync` | `boolean` | `true` | 컬렉션이 바뀌면 `@ManyToMany` 피벗 테이블의 행을 자동으로 동기화합니다 |
| `flushMode` | `FlushMode` | `MANUAL` | 쿼리 전 자동 flush 시점: `MANUAL`, `AUTO`, `ALWAYS` ([Flush Modes](#flush-modes) 참고) |
| `autoFlush` | `boolean` | `false` | `FlushMode.AUTO`의 단축 옵션 |
| `changeTracking` | `ChangeTrackingPolicy` | `DEFERRED_IMPLICIT` | 엔티티의 변경 여부를 검사하는 시점 |
| `batchInsert` | `boolean` | `false` | 같은 엔티티 타입의 INSERT 여러 개를 multi-row SQL 문 하나로 합칩니다 |
| `batchUpdate` | `boolean` | `false` | 같은 엔티티 타입의 UPDATE 여러 개를 CASE WHEN SQL 문 하나로 합칩니다 |
| `onFlush` | `(result) => void` | 없음 | flush 성공 후 실행할 콜백 |
| `logging` | `boolean` | `false` | 디버깅용 상세 생명주기 로그 |
| `maxIdentityMapSize` | `number` | 무제한 | Identity Map 크기 상한입니다. 상한을 넘으면 가장 오래 쓰지 않은 clean 항목부터 제거합니다. dirty, new, removed 엔티티는 제거하지 않습니다 |
| `validateBeforeFlush` | `boolean` | `false` | flush 전에 dirty 상태이거나 persist된 모든 엔티티에 검증 데코레이터를 실행합니다. 검증에 실패하면 `ValidationError`로 flush를 중단합니다 |

---

## Next Steps

- [Write Buffer — Basics](./write-buffer.md): 핵심 개념, Identity Map, 변경 추적(dirty checking), flush
- [Plugin System](./plugins.md): 커스텀 플러그인 작성
- [Events & Subscribers](./events.md): 엔티티 생명주기 이벤트
- [API Reference](./api-reference.md): 전체 메서드 시그니처
