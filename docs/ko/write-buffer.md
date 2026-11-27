# Write Buffer: 기본편

## 즉시 저장의 문제점

`em.save()`는 호출할 때마다 데이터베이스에 바로 쿼리를 보냅니다.

```typescript
user.name = "Alice";
await em.save(User, user);     // → UPDATE users SET name='Alice' WHERE id=1
user.email = "alice@new.com";
await em.save(User, user);     // → UPDATE users SET email='alice@new.com' WHERE id=1
```

UPDATE가 2번 실행되고 라운드 트립과 트랜잭션도 2번씩 생깁니다. 하지만 실제로는 UPDATE 하나로 충분합니다. 주문 처리라면 문제가 더 커집니다. 사용자 생성, 주문 생성, 주문 항목 5개 생성, 재고 갱신 5개로 쿼리가 모두 12번 실행됩니다.

**Unit of Work** 패턴은 이 문제를 해결합니다. 변경 사항을 바로 실행하지 않고 메모리에 모아 둡니다. 그리고 나중에 트랜잭션 하나로 한 번에 실행합니다. Stingerloom의 `WriteBuffer`는 이 패턴을 필요할 때만 쓰도록 제공하는 플러그인입니다.

## 설정

WriteBuffer는 직접 켜야 하는(opt-in) 플러그인입니다. EntityManager에 추가하면 됩니다.

```typescript
import { bufferPlugin } from "@stingerloom/orm";

await em.register({
  // ... connection options
  plugins: [bufferPlugin()],
});

// Create a buffer (your in-memory workspace)
const buf = em.buffer();
```

버퍼를 만들 때 옵션을 따로 넘겨서 기본값을 덮어쓸 수도 있습니다.

```typescript
const buf = em.buffer({ cascade: true, batchInsert: true });
```

백그라운드 워커처럼 버퍼를 오래 유지한다면 `maxIdentityMapSize`로 Identity Map의 상한을 걸 수 있습니다.

```typescript
const buf = em.buffer({ maxIdentityMapSize: 1000 });
// 1000개를 넘으면 오래된 clean 엔티티부터 자동으로 빠집니다.
// dirty, NEW, REMOVED 엔티티는 절대 빠지지 않습니다.
```

이제부터 모든 읽기와 쓰기는 `em` 대신 `buf`로 합니다.

---

## 핵심 개념

### Identity Map: "같은 행, 같은 객체"

Identity Map이 없으면 다음과 같은 미묘한 버그가 생길 수 있습니다.

```typescript
// Without Identity Map
const user1 = await em.findOne(User, { where: { id: 1 } });  // { id: 1, name: "Alice" }
const user2 = await em.findOne(User, { where: { id: 1 } });  // { id: 1, name: "Alice" }

user1.name = "Bob";
console.log(user2.name); // Still "Alice" — user2 is a DIFFERENT object!
await em.save(User, user2); // Oops — saves "Alice", overwriting the "Bob" change
```

`user1`과 `user2`는 같은 행을 가리킵니다. 하지만 서로 다른 JavaScript 객체입니다. 그래서 하나를 수정해도 다른 쪽에 반영되지 않고 갱신 내용이 덮어씌워집니다.

Identity Map은 이 문제를 막습니다. 버퍼로 조회한 모든 엔티티는 기본 키로 추적됩니다. 같은 행을 두 번 조회하면 완전히 같은 객체 참조를 반환합니다.

```typescript
const buf = em.buffer();

const a = await buf.findOne(User, { where: { id: 1 } });
const b = await buf.findOne(User, { where: { id: 1 } });

console.log(a === b); // true — same JavaScript object
```

이 동작은 `find()`와 `findOne()` 사이에서도 같습니다. `find()`가 사용자 10명을 반환할 때 그중 id=1인 사용자를 이미 `findOne()`으로 조회했다면 기존에 추적 중인 인스턴스를 그대로 재사용합니다.

Identity Map은 내부에서 `"User:id=1"` 같은 키를 사용합니다. 복합 기본 키라면 `"Order:userId=1,productId=5"`가 됩니다. 멀티테넌시에서 같은 기본 키가 테넌트마다 다른 행을 가리키는 경우에는 키에 테넌트도 들어갑니다(`"acme|User:id=1"`). `tenant_column`과 PostgreSQL의 `search_path`, `schema_qualified`가 이런 경우입니다. 그래서 버퍼 하나를 여러 테넌트에서 써도 행이 섞이지 않습니다. 공유 테이블(`@NonTenantEntity()`, `@Entity({ schema })`)은 모든 테넌트에서 같은 키를 씁니다. 같은 기본 키를 가진 다른 객체를 `track()`하면 상태 충돌을 막으려고 `ORM_BUFFER_IDENTITY_CONFLICT` 코드의 `OrmError`를 던집니다.

```
Identity conflict: another instance of "User" with PK (User:id=1) is already tracked.
Suggestion: Use the existing tracked instance, or untrack() the old one first.
```

버퍼의 다른 메서드도 잘못된 호출을 같은 방식으로 보고합니다. 버퍼가 추적하지 않는 인스턴스로 `markDirty()`, `markReadOnly()`, `wrapCollection()`, `refresh()`를 호출하면 `ORM_BUFFER_NOT_TRACKED`를 던집니다. 기본 키가 없는 인스턴스로 `remove()`를 호출하면 `ORM_PRIMARY_KEY_NOT_FOUND`를 던집니다.

#### 메모리 관리

Identity Map은 `findOne()`, `find()`, `getReference()`를 호출할 때마다 계속 커집니다. 요청마다 쓰고 버리는 버퍼라면 상관없습니다. 하지만 오래 유지하는 버퍼에는 `maxIdentityMapSize`를 걸어 두는 것이 좋습니다.

```typescript
const buf = em.buffer({ maxIdentityMapSize: 500 });

// 500개를 넘으면 가장 오래 접근하지 않은 clean 엔티티부터 빠집니다.
// clean: 스냅샷과 현재 값이 같고 NEW나 REMOVED가 아닌 엔티티
// dirty 엔티티는 절대 빠지지 않습니다. 그래서 flush 전의 변경 사항은 안전합니다.
```

빠진 엔티티는 `EntityState.DETACHED`가 됩니다. 현재 크기는 `buf.size().identityMap`으로 확인합니다.

### 변경 추적: "변경된 것만 갱신"

버퍼로 엔티티를 조회하면 그 시점의 모든 컬럼 값을 깊은 복사(deep clone)한 **스냅샷**(snapshot)을 만듭니다. `flush()` 시점에는 현재 상태와 스냅샷을 비교해서 실제로 변경된 컬럼만 담은 UPDATE를 생성합니다.

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

조회한 `user`를 `em.save()`로 저장하면 인스턴스가 가진 모든 컬럼이 변경 여부와 관계없이 UPDATE에 담깁니다. `save()`는 넘겨받은 속성을 그대로 쓰기 때문입니다. 반면 변경 추적(dirty checking)은 변경된 컬럼만 보내므로 더 효율적입니다.

flush가 성공하면 스냅샷이 현재 값으로 갱신됩니다. 그 뒤에 다시 변경하고 flush할 수 있습니다.

```typescript
user.email = "bob@new.com";
await buf.flush();
```

```sql
UPDATE "user" SET "email" = $1 WHERE "id" = $2
-- parameters: ['bob@new.com', 1]
-- name is NOT included — it was already "Bob" in the refreshed snapshot
```

비교에는 깊은 동등성(deep equality)을 사용합니다. `Date`는 timestamp로 비교하고 중첩 객체는 값으로 비교합니다. `null`과 `undefined`는 구분합니다.

### 엔티티 상태: 생명주기

버퍼가 추적하는 모든 엔티티 인스턴스에는 생명주기 상태가 있습니다.

| State | 의미 | 어떻게 진입하나요 | 다음 상태 |
|-------|------|-------------------|-----------|
| `NEW` | INSERT 대기 중, 아직 DB에 없음 | 기본 키 없는 객체에 `persist()` | → flush 후 `MANAGED` |
| `MANAGED` | 추적 중이며 DB와 동기화됨 | `find()`나 `findOne()`으로 조회했거나 flush됨 | → `DETACHED` 또는 `REMOVED` |
| `DETACHED` | 더 이상 버퍼가 추적하지 않음 | `detach()` 또는 `untrack()` | → `merge()`/`track()`으로 `MANAGED` |
| `REMOVED` | 다음 flush에서 DELETE 예정 | `remove()` | → flush 후 삭제됨 |

생명주기 전체를 코드로 보면 다음과 같습니다.

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

`em.findOne()`, `em.find()`와 똑같이 동작합니다. 다만 반환되는 모든 엔티티를 버퍼가 자동으로 추적합니다. 스냅샷 생성과 Identity Map 등록도 한 번에 처리합니다.

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

일반 `em.find()`의 `FindOption` 속성을 그대로 쓸 수 있습니다. `where`, `select`, `orderBy`, `relations` 등을 모두 지원합니다.

### getReference: 쿼리 없이 외래 키 참조하기

엔티티 전체를 조회하지 않고 외래 키 참조만 필요할 때가 있습니다. 예를 들어 Post를 만들면서 `authorId`를 설정해야 하고 사용자 ID는 이미 알고 있는 경우입니다.

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

나중에 `buf.findOne(User, { where: { id: 5 } })`를 호출하면 `getReference()`가 만든 것과 같은 참조를 반환합니다. 이는 Identity Map이 보장합니다. 이때도 `findOne()`은 데이터베이스를 조회해서 그 참조를 그 자리에서 하이드레이트합니다. 건드리지 않은 컬럼은 조회한 행의 값으로 채워집니다. 참조에 이미 써 둔 값은 dirty 상태를 유지하므로 flush할 때 그대로 반영됩니다.

엔티티 전체를 조회하지 않고도 참조를 바로 쓸 수 있게 하는 동작이 두 가지 더 있습니다.

- **참조에 쓴 값은 UPDATE로 flush됩니다.** 참조는 기본 키만 있는 기준 스냅샷으로 추적됩니다. 그래서 설정한 컬럼만 정확히 dirty로 감지됩니다. flush는 UPDATE를 실행하기 전에 SELECT 한 번으로 행이 실제로 있는지 확인합니다. 그래서 없는 행을 대상으로 한 쓰기가 경고 없이 사라지는 일은 없습니다. 이 조회로 참조도 하이드레이트됩니다.

  ```typescript
  const post = buf.getReference(Post, 10);
  post.title = "Patched";
  await buf.flush();
  // post 행 SELECT (존재 확인 + 하이드레이트) →
  // UPDATE "post" SET "title" = $1 WHERE "id" = $2
  ```

- **관계 속성도 동작합니다.** 관계는 지연 로딩 프록시로 초기화됩니다. `@OneToMany`, `@ManyToMany`, 역방향 측 `@OneToOne`은 참조의 기본 키로 바로 로드합니다. `@ManyToOne`과 소유 측 `@OneToOne`에는 외래 키 값이 필요합니다. 하지만 기본 키만 있는 참조에는 아직 이 값이 없습니다. 그래서 처음 접근할 때 참조 자신의 행을 먼저 하이드레이트한 뒤 대상을 로드합니다.

  ```typescript
  const post = buf.getReference(Post, 10);
  const author = await post.author; // post 행(외래 키) 조회 → author 행 조회
  ```

참조를 쓸 때 알아 둘 계약이 두 가지 있습니다.

- **존재하지 않는 행을 가리키는 참조는 명시적으로 실패합니다.** 하이드레이트가 실패하면 그냥 넘어가지 않고 `EntityNotFoundError`(`ORM_ENTITY_NOT_FOUND`)를 던집니다. 외래 키가 필요한 관계에 접근할 때든 flush 시점에 존재를 확인할 때든 같습니다. 이렇게 중단된 flush는 트랜잭션 전체를 롤백합니다. 그래서 함께 큐에 있던 다른 작업이 일부만 적용되는 일도 없습니다.

- **하이드레이트하기 전의 스칼라 컬럼은 `undefined`로 읽힙니다.** 참조는 하이드레이트되기 전까지 기본 키만 가진 객체입니다. 이때 `ref.title`을 읽으면 숨은 쿼리 없이 `undefined`가 반환됩니다. 스칼라 값을 읽으려면 먼저 하이드레이트하세요. `await buf.findOne(Post, { where: { id: 10 } })`가 같은 인스턴스를 그 자리에서 채웁니다.

### track: 엔티티 수동 등록

`buf`가 아니라 `em`으로 조회한 엔티티를 버퍼에서 추적하고 싶을 때 사용합니다.

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

### persist: 인스턴스 기반 INSERT

`persist()`는 새 엔티티 인스턴스를 INSERT 대기열에 추가합니다. 기본 키는 아직 없거나 `undefined`나 `null`이어야 합니다. flush가 끝나면 데이터베이스가 생성한 기본 키가 원본 객체에 다시 기록됩니다.

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

인스턴스에 auto-increment 기본 키가 이미 있으면 `persist()`는 기존 엔티티로 판단합니다. 그리고 dirty checking을 하도록 `track()`에 위임합니다.

애플리케이션이 정하는 키는 다릅니다. `@PrimaryColumn()` 키나 `@PrimaryGeneratedColumn("uuid")` 엔티티에 직접 넣은 uuid는 새 인스턴스에도 이미 들어 있습니다. 버퍼가 이미 추적하는 인스턴스가 아니면 `persist()`는 이 인스턴스를 큐에 넣습니다. 그리고 flush가 그 키의 행이 있는지 확인합니다. 행이 없으면 INSERT합니다. 행이 있으면 UPDATE하고 update로 집계합니다. 이때 키가 아닌 모든 컬럼을 변경 데이터로 담은 `preUpdate`와 `postUpdate` 이벤트가 발생합니다. `preview()`는 데이터베이스를 읽지 않으므로 이런 인스턴스를 INSERT로 표시합니다.

### save: 일반 객체 INSERT

엔티티 인스턴스가 필요 없는 간단한 삽입입니다.

```typescript
buf.save(User, { name: "Bob", email: "bob@example.com" });
await buf.flush();
```

```sql
INSERT INTO "user" ("name", "email") VALUES ($1, $2)
-- parameters: ['Bob', 'bob@example.com']
```

### remove: 인스턴스 기반 DELETE

추적 중인 엔티티를 삭제 대상으로 표시합니다.

```typescript
const user = await buf.findOne(User, { where: { id: 1 } });
buf.remove(user);
await buf.flush();
```

```sql
DELETE FROM "user" WHERE "id" = $1
-- parameters: [1]
```

`persist()`했지만 아직 flush하지 않은 엔티티를 `remove()`하면 대기 중인 INSERT를 취소하는 것으로 끝납니다. 데이터베이스에 행이 없으므로 DELETE가 필요 없습니다.

### delete: 조건 기반 DELETE

엔티티를 먼저 조회하지 않고 조건으로 삭제합니다.

```typescript
buf.delete(User, { id: 1 });
await buf.flush();
```

```sql
DELETE FROM "user" WHERE "id" = $1
-- parameters: [1]
```

---

## Flush: 실행의 순간

모든 작업은 `flush()`에서 실행됩니다. 대기열에 쌓인 insert, update, delete가 트랜잭션 하나로 실행됩니다.

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

flush는 다음 순서로 실행합니다.

1. **UPDATE**: dirty로 추적된 엔티티 (부모 먼저, 자식 나중)
2. **INSERT**: persist된 인스턴스와 대기 중인 save (부모 먼저, 자식 나중)
3. **Collection diff**: OneToMany의 orphan removal, ManyToMany의 피벗 테이블 동기화
4. **Cascade DELETE**: 재귀적으로 수집한 자식
5. **DELETE**: 대기 중인 remove (자식 먼저, 부모 나중)
6. **Bulk UPDATE**: `updateMany()` 연산
7. **Bulk DELETE**: `deleteMany()` 연산

### 순서가 중요한 이유

User를 참조하는 외래 키가 있는 Post를 삽입한다고 해 봅시다. Post가 User보다 먼저 삽입되면 외래 키 대상이 아직 없으므로 데이터베이스가 거부합니다.

버퍼는 `@ManyToOne`과 `@OneToOne` 메타데이터를 분석해서 의존성 그래프를 만듭니다. 그리고 위상 정렬(topological sort)로 다음 순서를 보장합니다.

- **INSERT**: 부모가 먼저 (외래 키 대상이 존재하도록)
- **DELETE**: 자식이 먼저 (외래 키 제약 조건 위반 방지)

의존성 그래프에 순환이 있으면 이를 감지하고 에러 없이 원래 순서로 넘어갑니다.

### 관계에서 외래 키 값 읽기

행의 `@ManyToOne` 키와 소유 측 `@OneToOne` 키는 인스턴스가 가진 값으로 기록합니다. 우선순위는 `save()`와 같습니다.

- 관계에 관련 인스턴스를 넣으면 그 인스턴스의 키를 씁니다.
- 관계에 값을 직접 넣으면 그 값을 키로 씁니다.
- 관계에 `null`을 넣으면 키를 비웁니다.
- 관계를 설정하지 않았다면 외래 키 속성을 씁니다. `authorId`나 조인 컬럼에 선언한 `@Column`이 여기에 해당합니다.

한 번도 로드하지 않은 관계, 즉 아직 지연 로딩 프록시인 관계는 저장된 키를 건드리지 않습니다.

```typescript
const post = await buf.findOne(Post, { where: { id: 1 } });
post.author = newAuthor;   // 같은 flush에서 persist하는 행
buf.persist(newAuthor);
await buf.flush();         // author INSERT 후 UPDATE post SET author_id = <새 id>
```

관련 인스턴스에 아직 키가 없으면 flush가 그 행을 INSERT한 뒤에 키를 기록합니다. 대상이 행보다 늦게 큐에 들어간 자기 참조도 마찬가지입니다. flush가 그 인스턴스를 끝내 기록하지 않으면 행을 키 없이 저장하지 않습니다. 대신 `flush()`가 `InvalidQueryError`를 던지고 롤백합니다. 관련 인스턴스를 `persist()`하거나 먼저 저장하세요.

### 원자성: 전부 성공하거나 전부 실패하거나

하나라도 실패하면 전체 트랜잭션이 롤백됩니다.

```typescript
try {
  await buf.flush();
} catch (error) {
  // ALL operations are rolled back — the database is unchanged
  // The buffer's queues are preserved, so you can fix the issue and retry
  await buf.flush();  // try again
}
```

### preview: 드라이 런

flush하기 전에 데이터베이스를 건드리지 않고 어떤 연산이 실행될지 미리 볼 수 있습니다.

```typescript
const preview = buf.preview();
// [
//   { action: "update", entity: "User", where: { id: 1 }, data: { name: "Bob" } },
//   { action: "insert", entity: "Post", data: { title: "Hello" } },
// ]
```

`preview()`는 `flush()`의 규칙을 그대로 따릅니다.

- 항목은 실행 순서대로 나열됩니다.
- read-only 엔티티는 제외됩니다. `DEFERRED_EXPLICIT` 변경 추적에서 dirty로 표시하지 않은 엔티티도 제외됩니다.
- 컬렉션 변경도 포함합니다. `@OneToMany` 배열에 추가한 자식의 cascade INSERT, orphan removal DELETE, `@ManyToMany` 피벗 테이블의 INSERT와 DELETE, `persist()`한 인스턴스의 cascade 자식이 모두 들어갑니다. 다른 부모로 옮긴 자식은 orphan removal DELETE에서 제외됩니다.

`preview()`는 엔티티를 절대 변경하지 않습니다.

`preview()`는 데이터베이스를 조회하지 않습니다. 그래서 flush 시점에만 알 수 있는 세 가지는 빠집니다.

- **Cascade DELETE 확장.** 큐에 쌓인 delete의 자식은 flush 시점에 데이터베이스 쿼리로 찾아냅니다. 그래서 큐에 있는 delete 항목만 나열됩니다.
- **데이터베이스가 생성하는 기본 키 값.** 아직 생성되지 않은 기본 키에서 파생되는 외래 키 값과 피벗 값은 항목 데이터에 없습니다. 연산 자체는 나열됩니다. 소유 측 `@OneToOne`의 외래 키 보정 UPDATE도 나열되지 않습니다.
- **dirty로 추적된 부모의 자식 cascade 재저장.** 이 작업은 나열되지 않습니다.

### size: 대기열 상태

대기 중인 작업량을 확인합니다.

```typescript
const s = buf.size();
// { tracked: 5, inserts: 1, deletes: 0, persists: 2, bulkUpdates: 0, bulkDeletes: 0, identityMap: 8 }
```

---

## Cascade

`cascade: true`이면 버퍼는 엔티티 관계를 따라 연산을 자동으로 전파합니다(기본값). 부모를 persist하면 자식도 자동으로 insert됩니다. 부모를 remove하면 자식도 자동으로 delete됩니다.

### Cascade persist: "부모와 자식을 한 번에 INSERT"

부모 엔티티에 `cascade: ["insert"]`가 설정된 `@OneToMany` 자식이 있으면 부모를 persist할 때 자식도 함께 insert됩니다.

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

자식의 `postId`는 부모의 생성된 기본 키인 `42`로 자동 설정됩니다. 직접 설정할 필요가 없습니다.

추적 중인 부모가 dirty 상태로 flush되면 cascade는 로드된 관계를 순회합니다. 하지만 실제로 변경된 자식만 씁니다. 변경되지 않은 자식은 완전히 건너뜁니다. UPDATE도, 생명주기 이벤트도, `@UpdateTimestamp` 갱신도 없습니다. dirty 자식은 정확히 한 번만 기록됩니다. 그리고 `preUpdate`와 `postUpdate` flush 이벤트도 한 쌍만 발생합니다. flush 결과에서 이런 cascade UPDATE는 `updates`로 집계됩니다. 새 자식의 cascade INSERT는 여전히 `inserts`로 집계됩니다.

### Cascade delete: "부모와 자식을 한 번에 DELETE"

`cascade: ["delete"]`가 설정되어 있으면 부모를 remove할 때 자식도 함께 삭제됩니다.

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

버퍼는 손자(grandchildren)까지 cascade 대상을 재귀적으로 수집합니다. 그리고 위상 정렬의 역순으로 삭제를 실행합니다.

### 관계 타입별 지원하는 cascade 연산

| Relation | Insert | Update | Delete | Orphan Removal |
|----------|--------|--------|--------|----------------|
| `@OneToMany` | 새 자식 자동 insert | dirty 자식 자동 update | 재귀 delete | 활성화 시 지원 |
| `@OneToOne` | 소유 측 자동 insert | 소유 측 자동 update | 외래 키 컬럼이 해석되면 지원 | 해당 없음 |
| `@ManyToMany` | 새 자식 + 피벗 행 | 해당 없음 | 해당 없음 | 피벗 행 제거 |

### Cascade merge / detach / refresh

cascade가 켜져 있으면 이 연산들도 관계 그래프를 따라 전파됩니다.

```typescript
buf.merge(detachedPost);   // merges post + its tracked children
buf.detach(post);          // detaches post + its tracked children
await buf.refresh(post);   // reloads post + its tracked children from DB
```

---

## 상태 관리

### untrack / detach

둘 다 버퍼에서 엔티티를 제거합니다. 하지만 핵심적인 차이가 있습니다.

```typescript
buf.untrack(user);   // remove from tracking — NO cascade to related entities
buf.detach(user);    // remove from tracking — CASCADE to related entities
```

엔티티 하나만 추적을 중단하려면 `untrack()`을 사용하세요. 엔티티와 연결된 모든 것의 추적을 중단하려면 `detach()`를 사용하세요.

### detachByPk / detachAll

인스턴스 참조가 없을 때나 한꺼번에 떼어 내고 싶을 때 쓰는 변형입니다.

```typescript
// 기본 키만으로 떼어 내기: 외부 API에서 ID만 받은 경우에 유용합니다
buf.detachByPk(User, 7);
buf.detachByPk(OrderItem, { orderId: 1, productId: 42 }); // 복합 기본 키

// 추적 중인 모든 엔티티를 한 번에 떼어 내기
buf.detachAll();
```

`detachByPk()`는 Identity Map에서 같은 기본 키를 가진 인스턴스를 찾아 `detach()`에 위임합니다. 매칭되는 인스턴스가 없으면 아무 일도 하지 않으므로 안전합니다.

`detachAll()`은 추적 중인 모든 엔티티와 대기 중인 `persist` 큐를 한 번에 비웁니다. 그리고 각 인스턴스를 `DETACHED` 상태로 바꿉니다. `delete`, `bulkUpdate`, `bulkDelete`, `save` 같은 클래스 기반 큐와 조건 기반 큐는 그대로 둡니다. 이 큐까지 모두 비우려면 `clear()`를 쓰세요.

### merge

detach된 엔티티를 다시 연결합니다. 같은 기본 키로 추적 중인 인스턴스가 이미 있으면 detach된 값이 기존 인스턴스에 복사됩니다.

```typescript
// user was detached earlier, then modified outside the buffer
const detachedUser = { id: 1, name: "Updated Name" };
buf.merge(detachedUser);
// If User#1 is already tracked, its name is updated to "Updated Name"
// If not, the detached instance is tracked fresh
```

### refresh

데이터베이스에서 엔티티를 다시 조회해서 모든 필드를 그 자리에서 갱신합니다.

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

다른 프로세스가 해당 행을 수정했을 수 있고 최신 데이터가 필요할 때 유용합니다. 다른 프로세스가 삭제해서 행이 사라졌다면 `refresh()`는 `EntityNotFoundError`(`ORM_ENTITY_NOT_FOUND`)를 던집니다.

### clear

버퍼를 모두 비우는 옵션입니다. 추적 중인 모든 엔티티를 제거하고 Identity Map을 초기화합니다. 그리고 대기 중인 연산을 모두 버립니다.

```typescript
buf.clear();
// Identity Map: empty
// Tracked entities: none
// Queued inserts/deletes: none
```

---

## 다음 단계

- [Write Buffer: Advanced](./write-buffer-advanced.md): 지연 로딩, 잠금, 배치 DML, flush 모드, 중첩 UoW
- [Plugin System](./plugins.md): 커스텀 플러그인 작성
- [Transactions](./transactions.md): 직접 관리하는 트랜잭션과 데코레이터 기반 트랜잭션
- [API Reference](./api-reference.md): 전체 메서드 시그니처
