# Write Buffer -- 기본편

## 즉시 저장의 문제점

`em.save()`를 쓰면 호출할 때마다 바로 DB에 쿼리가 날아가요:

```typescript
user.name = "Alice";
await em.save(User, user);     // → UPDATE users SET name='Alice' WHERE id=1
user.email = "alice@new.com";
await em.save(User, user);     // → UPDATE users SET email='alice@new.com' WHERE id=1
```

UPDATE 2번, 네트워크 왕복 2번, 트랜잭션 2번인데 -- 사실 UPDATE 하나로 충분해요. 주문 처리를 생각해 보면 더 심각해요: 사용자 생성, 주문 생성, 주문 항목 5개 생성, 재고 업데이트 5개. 총 12번의 쿼리가 나가요.

**Unit of Work** 패턴이 이 문제를 풀어 줍니다. 변경사항을 즉시 실행하지 않고 메모리에 모아 뒀다가, 한 번에 하나의 트랜잭션으로 흘려보냅니다. Stingerloom의 `WriteBuffer`는 이 패턴을 선택적으로 쓸 수 있게 붙여 둔 플러그인이에요.

## Setup

WriteBuffer는 opt-in 플러그인이에요. EntityManager에 추가하면 돼요:

```typescript
import { bufferPlugin } from "@stingerloom/orm";

await em.register({
  // ... connection options
  plugins: [bufferPlugin()],
});

// Create a buffer (your in-memory workspace)
const buf = em.buffer();
```

버퍼를 만들 때 옵션을 따로 넘겨서 기본값을 덮어쓸 수도 있어요:

```typescript
const buf = em.buffer({ cascade: true, batchInsert: true });
```

백그라운드 워커처럼 버퍼를 오래 유지하는 경우, `maxIdentityMapSize`로 Identity Map 상한을 걸 수 있어요:

```typescript
const buf = em.buffer({ maxIdentityMapSize: 1000 });
// 1000개 넘으면 오래된 clean 엔티티부터 자동으로 빠져요.
// dirty / NEW / REMOVED는 절대 안 빠져요.
```

이 시점부터 모든 읽기/쓰기는 `em` 대신 `buf`를 통해 해요.

---

## 핵심 개념

### Identity Map -- "같은 행, 같은 객체"

Identity Map이 없으면 이런 미묘한 버그가 생길 수 있어요:

```typescript
// Without Identity Map
const user1 = await em.findOne(User, { where: { id: 1 } });  // { id: 1, name: "Alice" }
const user2 = await em.findOne(User, { where: { id: 1 } });  // { id: 1, name: "Alice" }

user1.name = "Bob";
console.log(user2.name); // Still "Alice" — user2 is a DIFFERENT object!
await em.save(User, user2); // Oops — saves "Alice", overwriting the "Bob" change
```

`user1`과 `user2`는 같은 DB 행을 가리키지만, 서로 다른 JavaScript 객체예요. 하나를 수정해도 다른 쪽에 반영되지 않아서, 업데이트가 덮어씌워지는 문제가 생겨요.

Identity Map이 이걸 방지해요. 버퍼를 통해 로드된 모든 엔티티는 primary key로 추적돼요. 같은 행을 두 번 로드하면 **완전히 같은 객체 참조**를 반환해요:

```typescript
const buf = em.buffer();

const a = await buf.findOne(User, { where: { id: 1 } });
const b = await buf.findOne(User, { where: { id: 1 } });

console.log(a === b); // true — same JavaScript object
```

`find()`와 `findOne()` 사이에서도 동작해요. `find()`가 10명의 사용자를 반환할 때, 그 중 하나(id=1)가 이미 `findOne()`으로 로드됐다면, 기존 추적 인스턴스를 그대로 재사용해요.

내부적으로 Identity Map은 `"User:id=1"` 같은 키를 사용해요. 복합 primary key인 경우 `"Order:userId=1,productId=5"`가 돼요. 같은 PK를 가진 다른 객체를 `track()`하려 하면, 상태 충돌을 방지하기 위해 에러가 발생해요:

```
Identity conflict: another instance of "User" with PK (User:id=1) is already tracked
```

#### 메모리 관리

Identity Map은 `findOne()`, `find()`, `getReference()` 호출마다 계속 커져요. 요청 단위로 쓰고 버리는 버퍼라면 상관없지만, 오래 살아 있는 버퍼에서는 `maxIdentityMapSize`를 걸어두는 게 좋아요:

```typescript
const buf = em.buffer({ maxIdentityMapSize: 500 });

// 500개를 넘으면 가장 오래 접근하지 않은 clean 엔티티부터 빠져요.
// clean = snapshot과 현재 값이 같고, NEW/REMOVED가 아닌 엔티티.
// dirty 엔티티는 절대 안 빠져요 — flush 전 변경 사항은 안전해요.
```

빠진 엔티티는 `EntityState.DETACHED`가 돼요. 현재 크기는 `buf.size().identityMap`으로 확인할 수 있어요.

### Dirty Checking -- "변경된 것만 업데이트"

버퍼를 통해 엔티티를 로드하면, 그 시점의 모든 컬럼 값을 deep clone한 **snapshot**을 찍어요. `flush()` 시점에 현재 상태와 snapshot을 비교해서, 실제로 변경된 컬럼만 포함하는 UPDATE를 생성해요:

```typescript
const buf = em.buffer();
const user = await buf.findOne(User, { where: { id: 1 } });
// Snapshot taken: { id: 1, name: "Alice", email: "alice@ex.com", age: 25 }

user.name = "Bob";
// Current state:  { id: 1, name: "Bob",   email: "alice@ex.com", age: 25 }
// Diff:           { name: "Bob" }  ← only this column changed

await buf.flush();
```

```sql
UPDATE "user" SET "name" = $1 WHERE "id" = $2
-- parameters: ['Bob', 1]
-- NOTE: email and age are NOT in the SET clause — they didn't change
```

`em.save()`는 변경 여부와 관계없이 모든 컬럼을 UPDATE에 포함하는데, dirty checking은 변경된 것만 보내니까 더 효율적이에요.

flush가 성공하면 snapshot이 현재 값으로 갱신돼요. 이후 추가 변경 후 다시 flush할 수 있어요:

```typescript
user.email = "bob@new.com";
await buf.flush();
```

```sql
UPDATE "user" SET "email" = $1 WHERE "id" = $2
-- parameters: ['bob@new.com', 1]
-- name is NOT included — it was already "Bob" in the refreshed snapshot
```

비교는 deep equality를 사용해요: `Date`는 timestamp로, 중첩 객체는 값으로 비교하고, `null`과 `undefined`는 구분해요.

### Entity States -- 라이프사이클

버퍼가 추적하는 모든 엔티티 인스턴스에는 라이프사이클 상태가 있어요:

| State | 의미 | 어떻게 진입하나요 | 다음 상태 |
|-------|------|-------------------|-----------|
| `NEW` | INSERT 대기 중, 아직 DB에 없음 | PK 없는 객체에 `persist()` | → flush 후 `MANAGED` |
| `MANAGED` | 추적 중이며 DB와 동기화됨 | `find()`/`findOne()`으로 로드, 또는 flush됨 | → `DETACHED` 또는 `REMOVED` |
| `DETACHED` | 더 이상 버퍼가 추적하지 않음 | `detach()` 또는 `untrack()` | → `merge()`/`track()`으로 `MANAGED` |
| `REMOVED` | 다음 flush에서 DELETE 예정 | `remove()` | → flush 후 삭제됨 |

전체 라이프사이클 코드 예시:

```typescript
const buf = em.buffer();

// 1. NEW — queued for INSERT
const user = new User();
user.name = "Alice";
buf.persist(user);
buf.getState(user);  // EntityState.NEW

// 2. MANAGED — flushed to DB, now tracked
await buf.flush();
buf.getState(user);  // EntityState.MANAGED
console.log(user.id); // auto-generated PK is written back to the object

// 3. Make changes — still MANAGED, but "dirty"
user.name = "Bob";
await buf.flush();
// → UPDATE "user" SET "name" = 'Bob' WHERE "id" = 1

// 4. REMOVED — marked for deletion
buf.remove(user);
buf.getState(user);  // EntityState.REMOVED

// 5. Flushed — DELETE executed, entity is gone
await buf.flush();
// → DELETE FROM "user" WHERE "id" = 1
```

---

## 엔티티 로딩

### findOne / find

`em.findOne()`, `em.find()`와 동일하게 동작하지만, 반환되는 모든 엔티티가 **자동으로 버퍼에 추적**돼요 -- snapshot 생성, Identity Map 등록까지 한 번에 처리해요:

```typescript
const buf = em.buffer();

const user = await buf.findOne(User, { where: { id: 1 } });
const posts = await buf.find(Post, { where: { authorId: 1 } });

buf.tracked();  // [user, ...posts] — all automatically tracked
```

```sql
SELECT * FROM "user" WHERE "id" = $1
SELECT * FROM "post" WHERE "authorId" = $1
```

일반 `em.find()`의 `FindOption` 속성을 그대로 쓸 수 있어요 -- `where`, `select`, `orderBy`, `relations` 등 전부 지원해요.

### getReference -- 쿼리 없이 FK 참조하기

전체 엔티티를 로드하지 않고 foreign key 참조만 필요할 때가 있어요. 예를 들어, Post를 만들면서 `authorId`를 설정해야 하는데 사용자 ID는 이미 알고 있는 경우:

```typescript
const buf = em.buffer();

// No database query — just creates { id: 5 } and registers in Identity Map
const author = buf.getReference(User, 5);

const post = new Post();
post.title = "Hello";
post.authorId = 5;
buf.persist(post);
await buf.flush();
```

```sql
INSERT INTO "post" ("title", "authorId") VALUES ($1, $2)
-- parameters: ['Hello', 5]
-- No SELECT for user — we just needed the ID
```

나중에 `buf.findOne(User, { where: { id: 5 } })`를 호출하면, `getReference()`가 만든 것과 같은 참조를 반환해요 -- Identity Map이 보장해요. 이때 `findOne()`은 여전히 데이터베이스를 조회해서 참조를 그 자리에서 하이드레이션합니다. 건드리지 않은 컬럼은 로드된 행 값으로 채워지고, 참조에 이미 써 둔 값은 dirty 상태를 유지해서 flush 때 그대로 반영됩니다.

전체 엔티티를 로드하지 않고도 참조를 바로 쓸 수 있도록, 두 가지 동작이 더 있어요.

- **참조에 쓴 값은 UPDATE로 flush됩니다.** 참조는 PK만 있는 baseline으로 스냅샷 추적되므로, 설정한 컬럼만 정확히 dirty로 감지됩니다:

  ```typescript
  const post = buf.getReference(Post, 10);
  post.title = "Patched";
  await buf.flush();
  // UPDATE "post" SET "title" = $1 WHERE "id" = $2 — SELECT 없이 바로
  ```

- **관계 프로퍼티도 동작합니다.** 관계는 lazy 프록시로 초기화돼요. `@OneToMany` / `@ManyToMany` / inverse `@OneToOne`은 참조의 PK로 바로 로드합니다. `@ManyToOne`과 owning `@OneToOne`은 PK만 있는 참조에 아직 없는 FK 값이 필요하므로, 첫 접근 때 참조 자신의 행을 먼저 하이드레이션한 뒤 대상을 로드합니다:

  ```typescript
  const post = buf.getReference(Post, 10);
  const author = await post.author; // post 행(FK) 조회 → author 행 조회
  ```

### track -- 엔티티 수동 등록

`buf`가 아닌 `em`을 통해 로드한 엔티티를 버퍼에서 추적하고 싶을 때 사용해요:

```typescript
const user = await em.findOne(User, { where: { id: 1 } });  // loaded outside buffer
buf.track(user);  // now tracked — snapshot taken, Identity Map registered

user.name = "updated";
await buf.flush();
```

```sql
UPDATE "user" SET "name" = $1 WHERE "id" = $2
-- parameters: ['updated', 1]
```

---

## 데이터 쓰기

### persist -- 인스턴스 기반 INSERT

`persist()`는 새 엔티티 인스턴스를 INSERT 대기열에 추가해요. primary key가 아직 없거나 `undefined`/`null`이어야 해요. flush 후에 DB가 생성한 PK가 원본 객체에 다시 써져요:

```typescript
const buf = em.buffer();

const user = new User();
user.name = "Alice";
user.email = "alice@example.com";
buf.persist(user);
// Nothing has hit the database yet — user is just queued

console.log(user.id);  // undefined — not inserted yet

await buf.flush();

console.log(user.id);  // 42 — auto-generated PK written back!
```

```sql
-- Inside the flush transaction:
INSERT INTO "user" ("name", "email") VALUES ($1, $2) RETURNING "id"
-- parameters: ['Alice', 'alice@example.com']
-- PostgreSQL: RETURNING gives us the generated id
-- MySQL: LAST_INSERT_ID() gives us the generated id
```

인스턴스에 이미 PK가 있으면, `persist()`는 기존 엔티티로 판단하고 dirty checking을 위해 `track()`으로 위임해요.

### save -- 일반 객체 INSERT

엔티티 인스턴스가 필요 없는 간단한 삽입:

```typescript
buf.save(User, { name: "Bob", email: "bob@example.com" });
await buf.flush();
```

```sql
INSERT INTO "user" ("name", "email") VALUES ($1, $2)
-- parameters: ['Bob', 'bob@example.com']
```

### remove -- 인스턴스 기반 DELETE

추적 중인 엔티티를 삭제 대상으로 표시해요:

```typescript
const user = await buf.findOne(User, { where: { id: 1 } });
buf.remove(user);
await buf.flush();
```

```sql
DELETE FROM "user" WHERE "id" = $1
-- parameters: [1]
```

`persist()`했지만 아직 flush하지 않은 엔티티를 `remove()`하면, 대기 중인 INSERT를 취소하는 것으로 끝나요 -- DB에 행이 없으니 DELETE가 필요 없어요.

### delete -- 조건 기반 DELETE

엔티티를 먼저 로드하지 않고 조건으로 삭제해요:

```typescript
buf.delete(User, { id: 1 });
await buf.flush();
```

```sql
DELETE FROM "user" WHERE "id" = $1
-- parameters: [1]
```

---

## Flush -- 실행의 순간

`flush()`에서 모든 일이 일어나요. 대기열에 쌓인 insert, update, delete가 **단일 트랜잭션**으로 실행돼요:

```typescript
const result = await buf.flush();
console.log(result);
// { updates: 2, inserts: 1, deletes: 0 }
```

```sql
BEGIN;

-- 1. Updates (dirty tracked entities)
UPDATE "user" SET "name" = $1 WHERE "id" = $2;
UPDATE "user" SET "email" = $3 WHERE "id" = $4;

-- 2. Inserts
INSERT INTO "post" ("title", "authorId") VALUES ($5, $6) RETURNING "id";

-- 3. (Collection diffs, cascade deletes, bulk operations if any)

COMMIT;
```

### 실행 순서

flush는 아래 순서대로 실행해요:

1. **UPDATE** -- dirty 추적 엔티티 (부모 먼저, 자식 나중)
2. **INSERT** -- persist된 인스턴스, 대기 중인 save (부모 먼저, 자식 나중)
3. **Collection diff** -- O2M orphan removal, M2M pivot table 동기화
4. **Cascade DELETE** -- 재귀적으로 수집된 자식들
5. **DELETE** -- 대기 중인 remove (자식 먼저, 부모 나중)
6. **Bulk UPDATE** -- `updateMany()` 연산
7. **Bulk DELETE** -- `deleteMany()` 연산

### 순서가 왜 중요한가요?

User를 참조하는 FK가 있는 Post를 삽입한다고 해 봐요. Post가 User보다 먼저 삽입되면, FK 대상이 아직 없으니까 DB가 거부해요.

버퍼는 `@ManyToOne`과 `@OneToOne` 메타데이터를 분석해서 **의존성 그래프**를 만들고, topological sort로 이렇게 보장해요:

- **INSERT:** 부모가 먼저 (FK 대상이 존재하도록)
- **DELETE:** 자식이 먼저 (FK 제약 조건 위반 방지)

의존성 그래프에 순환이 있으면 감지한 뒤, 원래 순서로 graceful하게 fallback해요.

### Atomicity -- 전부 성공하거나, 전부 실패하거나

하나라도 실패하면 전체 트랜잭션이 롤백돼요:

```typescript
try {
  await buf.flush();
} catch (error) {
  // ALL operations are rolled back — the database is unchanged
  // The buffer's queues are preserved, so you can fix the issue and retry
  await buf.flush();  // try again
}
```

### preview -- Dry run

flush 전에, DB를 건드리지 않고 어떤 연산이 실행될지 미리 볼 수 있어요:

```typescript
const preview = buf.preview();
// [
//   { action: "update", entity: "User", where: { id: 1 }, data: { name: "Bob" } },
//   { action: "insert", entity: "Post", data: { title: "Hello" } },
// ]
```

### size -- 대기열 상태

대기 중인 작업량을 확인해요:

```typescript
const s = buf.size();
// { tracked: 5, inserts: 1, deletes: 0, persists: 2, bulkUpdates: 0, bulkDeletes: 0, identityMap: 8 }
```

---

## Cascade

`cascade: true`(기본값)일 때, 버퍼는 엔티티 관계를 따라 연산을 자동으로 전파해요. 부모를 persist하면 자식도 자동으로 insert되고, 부모를 remove하면 자식도 자동으로 delete돼요.

### Cascade persist -- "부모와 자식을 한 번에 INSERT"

부모 엔티티에 `cascade: ["insert"]`가 설정된 `@OneToMany` 자식이 있으면, 부모를 persist할 때 자식도 함께 insert돼요:

```typescript
const buf = em.buffer();

const post = new Post();
post.title = "Hello";
post.comments = [
  Object.assign(new Comment(), { body: "First!" }),
  Object.assign(new Comment(), { body: "Nice post" }),
];

buf.persist(post);
await buf.flush();
```

```sql
BEGIN;
-- Parent first (topological order)
INSERT INTO "post" ("title") VALUES ($1) RETURNING "id";
-- parameters: ['Hello']  → returns id = 42

-- Children second (FK automatically set to parent's generated PK)
INSERT INTO "comment" ("body", "postId") VALUES ($2, $3);
-- parameters: ['First!', 42]
INSERT INTO "comment" ("body", "postId") VALUES ($4, $5);
-- parameters: ['Nice post', 42]
COMMIT;
```

자식의 `postId`가 자동으로 `42`(부모의 생성된 PK)로 설정돼요. 직접 설정할 필요가 없어요.

### Cascade delete -- "부모와 자식을 한 번에 DELETE"

`cascade: ["delete"]`가 설정되어 있으면, 부모를 remove할 때 자식도 함께 삭제돼요:

```typescript
buf.remove(post);
await buf.flush();
```

```sql
BEGIN;
-- Children first (reverse topological order)
DELETE FROM "comment" WHERE "postId" = $1;
-- parameters: [42]

-- Parent last
DELETE FROM "post" WHERE "id" = $1;
-- parameters: [42]
COMMIT;
```

버퍼는 손자(grandchildren)까지 재귀적으로 cascade 대상을 수집한 뒤, 역 topological 순서로 삭제를 실행해요.

### 관계 타입별 지원하는 cascade 연산

| Relation | Insert | Update | Delete | Orphan Removal |
|----------|--------|--------|--------|----------------|
| `@OneToMany` | 새 자식 자동 insert | dirty 자식 자동 update | 재귀 delete | 활성화 시 지원 |
| `@OneToOne` | owning side 자동 insert | owning side 자동 update | joinColumn 설정 시 지원 | -- |
| `@ManyToMany` | 새 자식 + pivot row | -- | -- | pivot row 제거 |

### Cascade merge / detach / refresh

cascade가 활성화되어 있으면, 이 연산들도 관계 그래프를 따라 전파돼요:

```typescript
buf.merge(detachedPost);   // merges post + its tracked children
buf.detach(post);          // detaches post + its tracked children
await buf.refresh(post);   // reloads post + its tracked children from DB
```

---

## 상태 관리

### untrack / detach

둘 다 버퍼에서 엔티티를 제거하지만, 핵심적인 차이가 있어요:

```typescript
buf.untrack(user);   // remove from tracking — NO cascade to related entities
buf.detach(user);    // remove from tracking — CASCADE to related entities
```

특정 엔티티 하나만 추적을 중단하려면 `untrack()`을, 엔티티와 연결된 모든 것의 추적을 중단하려면 `detach()`를 사용해요.

### detachByPk / detachAll

인스턴스 레퍼런스를 들고 있지 않을 때, 또는 한꺼번에 떼고 싶을 때 쓰는 변형이에요.

```typescript
// PK만으로 떼기 — 외부 API에서 ID만 받아온 경우 유용해요
buf.detachByPk(User, 7);
buf.detachByPk(OrderItem, { orderId: 1, productId: 42 }); // 복합 PK

// 추적 중인 모든 엔티티를 한 번에 떼기
buf.detachAll();
```

`detachByPk()`는 Identity Map에서 같은 PK를 가진 인스턴스를 찾아 `detach()`로 위임해요. 매칭되는 게 없으면 no-op 이라서 안전해요.

`detachAll()`은 추적 중인 모든 엔티티 + 대기 중인 `persist` 큐를 한 번에 비우고, 각 인스턴스를 `DETACHED` 상태로 전환해요. `delete` / `bulkUpdate` / `bulkDelete` / `save` 같은 클래스/조건 기반 큐는 그대로 두기 때문에, 큐까지 통째로 비우려면 `clear()`를 쓰세요.

### merge

detach된 엔티티를 다시 연결해요. 같은 PK의 추적 인스턴스가 이미 있으면, detach된 값이 기존 인스턴스에 복사돼요:

```typescript
// user was detached earlier, then modified outside the buffer
const detachedUser = { id: 1, name: "Updated Name" };
buf.merge(detachedUser);
// If User#1 is already tracked, its name is updated to "Updated Name"
// If not, the detached instance is tracked fresh
```

### refresh

DB에서 엔티티를 다시 로드해서, 모든 필드를 제자리에서 업데이트해요:

```typescript
await buf.refresh(user);
// Re-queries the DB for user's PK
// Updates all fields on the existing object
// Takes a new snapshot for dirty checking
```

```sql
SELECT * FROM "user" WHERE "id" = $1
-- parameters: [1]
```

다른 프로세스가 해당 행을 수정했을 수 있고, 최신 데이터가 필요할 때 유용해요.

### clear

핵폭탄 옵션 -- 모든 추적 엔티티 제거, Identity Map 초기화, 대기 중인 연산 전부 폐기:

```typescript
buf.clear();
// Identity Map: empty
// Tracked entities: none
// Queued inserts/deletes: none
```

---

## 다음 단계

- [Write Buffer -- Advanced](./write-buffer-advanced.md) -- Lazy loading, locking, batch DML, flush modes, nested UoW
- [Plugin System](./plugins.md) -- 커스텀 플러그인 작성
- [Transactions](./transactions.md) -- 수동 및 데코레이터 기반 트랜잭션
- [API Reference](./api-reference.md) -- 전체 메서드 시그니처
