# EntityManager -- CRUD 기본

Stingerloom에서 데이터베이스를 건드리는 일은 전부 **EntityManager**를 거칩니다. 생성, 조회, 수정, 삭제 — 네 가지가 모두 이 한 클래스 위에서 일어나요.

```typescript
import { EntityManager } from "@stingerloom/orm";

const em = new EntityManager();
```

이 장은 기본 CRUD 라이프사이클만 다룹니다. 페이지네이션과 집계 같은 조회 쪽 기능은 [Querying & Pagination](./entity-manager-querying.md), 배치 쓰기·upsert·트랜잭션은 [Writes & Transactions](./entity-manager-writes.md)에 정리되어 있어요.

---

## 연결하기 -- register()

### register()가 필요한 이유

쿼리가 실제로 날아가려면 세 가지가 먼저 준비돼야 합니다. DB에 연결이 열려 있어야 하고, ORM이 엔티티 클래스의 구조(컬럼, 타입, 관계)를 알고 있어야 하고, 실제 테이블이 엔티티 정의와 맞아떨어져야 해요. `register()`가 이 셋을 한 번에 처리합니다.

```typescript
import "reflect-metadata";
import { EntityManager } from "@stingerloom/orm";
import { User } from "./user.entity";
import { Post } from "./post.entity";

const em = new EntityManager();

await em.register({
  type: "postgres",          // "mysql" | "postgres" | "sqlite"
  host: "localhost",
  port: 5432,
  username: "postgres",
  password: "password",
  database: "mydb",
  entities: [User, Post],
  synchronize: true,
});
```

### register() 내부 동작

`register()`는 내부적으로 세 단계를 밟습니다.

**1단계 — 연결.** 커넥션 풀을 엽니다. 재사용 가능한 연결 묶음이라, 여러 쿼리가 서로 기다리지 않고 동시에 나갈 수 있어요. 풀 크기는 `pool` 옵션으로 조절합니다.

**2단계 — 메타데이터 스캔.** 엔티티 클래스에 붙인 데코레이터(`@Entity`, `@Column`, `@ManyToOne` 등)를 읽어 내부 메타데이터 맵을 채웁니다. "`User` 클래스는 `user` 테이블에 대응하고, 컬럼은 `id`/`name`/`email`이고, `id`는 자동 증가 기본 키다" 같은 사실들을 이 단계에서 한 번에 학습해요.

**3단계 — 스키마 동기화.** `synchronize`가 켜져 있으면 메타데이터와 실제 테이블을 비교해 DDL을 만들어 냅니다.

```sql
-- PostgreSQL: "user" 테이블이 아직 없는 경우
CREATE TABLE IF NOT EXISTS "user" (
  "id" SERIAL NOT NULL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL,
  "email" VARCHAR(255) NOT NULL
);

-- MySQL equivalent
CREATE TABLE IF NOT EXISTS `user` (
  `id` INT NOT NULL PRIMARY KEY AUTO_INCREMENT,
  `name` VARCHAR(255) NOT NULL,
  `email` VARCHAR(255) NOT NULL
);
```

테이블이 이미 존재하지만 엔티티에 정의된 컬럼이 빠져 있으면 추가해요:

```sql
-- PostgreSQL
ALTER TABLE "user" ADD "avatar" VARCHAR(255) NULL;

-- MySQL
ALTER TABLE `user` ADD `avatar` VARCHAR(255) NULL;
```

### synchronize 모드

| 값 | 동작 |
|---|------|
| `true` | 전체 동기화 -- 테이블 생성, 컬럼 추가 **및 삭제**까지 엔티티에 맞춰요. |
| `"safe"` | 안전 모드 -- 테이블 생성과 컬럼 추가만 하고, **변경·삭제·이름 변경은 하지 않아요**. 건너뛴 변경은 warn 한 줄로 요약되고, `logDDL`을 켜면 문장 전체가 출력돼요. |
| `"dry-run"` | 미리보기 -- 실행될 DDL 문을 로그로 출력하되, 실제 적용하지 않아요. |
| `false` (기본값) | 동기화 없음. [마이그레이션](./migrations.md)으로 스키마를 관리해요. |

::: warning
`synchronize: true`는 개발 환경에서만 사용하세요. 프로덕션에서는 컬럼이 삭제될 수 있어요. 프로덕션 스키마 관리에는 [마이그레이션](./migrations.md)을 사용하세요.
:::

### synchronize 옵션 객체

위의 단일 값은 **복원력**, **파괴적 변경 안전성**, **DDL 가시성**이라는 세 가지 별개의 관심사를 하나의 enum에 묶어 둔 형태예요. 객체 형태로 넘기면 각각을 따로 제어할 수 있습니다.

```ts
synchronize: {
  mode: "safe",                  // 기본 모드 (true | "safe" | "dry-run")
  continueOnError: false,         // 첫 DDL 실패에서 registerEntities() 중단
  failOnDestructiveChange: true,  // DROP COLUMN / 좁히는 ALTER 직전에 throw
  logDDL: true,                   // 발생하는 모든 DDL을 info 레벨로 로그 출력
}
```

| 플래그 | 기본값 | 설정 시 동작 |
|--------|--------|------------|
| `mode` | 필수 | 기본 모드 — 단일 값 폼과 의미가 동일해요. |
| `continueOnError` | `true` | `false`이면 DDL 실패가 warn으로 격하되지 않고 `OrmError(SCHEMA_SYNC_FAILED)`로 throw 되어 부팅을 중단시킵니다. |
| `failOnDestructiveChange` | `false` | `true`이면 DROP COLUMN과 좁히는 ALTER(예: `varchar(255) → int`, `varchar(255) → varchar(64)`)가 실행 전에 `OrmError(SCHEMA_SYNC_DESTRUCTIVE_CHANGE)`로 throw 됩니다. synchronize는 어떤 모드에서도 테이블을 삭제하지 않습니다. |
| `logDDL` | `false` | `true`이면 발생하는 모든 DDL(CREATE TABLE, ALTER, RENAME, DROP, FULLTEXT INDEX 등)을 info 레벨로 로그 출력합니다. `"safe"`에서는 건너뛴 문장도 `[skipped: safe mode]` 접두어를 붙여 출력합니다. |

단일 값 폼(`true`, `"safe"`, `"dry-run"`, `false`)은 그대로 유지되어 — 동일한 기본값으로 정규화돼요. 프로덕션 권장 프로파일은 다음과 같습니다.

```ts
synchronize: {
  mode: "safe",
  continueOnError: false,
  failOnDestructiveChange: true,
}
```

### Named connections (멀티 DB)

두 번째 인자로 연결 이름을 넘기면 여러 데이터베이스를 동시에 사용할 수 있어요:

```typescript
const em = new EntityManager();

// Primary database
await em.register({ type: "postgres", /* ... */ entities: [User] }, "default");

// Analytics database
const analyticsEm = new EntityManager();
await analyticsEm.register({ type: "mysql", /* ... */ entities: [Event] }, "analytics");
```

커넥션 옵션(풀링, 재시도, 리플리케이션, 쿼리 타임아웃 등) 전체 목록은 [Configuration Guide](./configuration.md)를 참고해 주세요.

---

## 저장하기 -- save()

### save()는 "스마트 upsert"

대부분의 쓰기는 두 갈래로 나뉩니다. 새로 만들거나, 이미 있는 걸 고치거나. `save()`는 `insert()`와 `update()`를 따로 부를 필요 없이, 기본 키가 있는지만 보고 알아서 판단합니다.

- **PK 값이 없다** → 새 레코드. `INSERT`로 나갑니다.
- **PK 값이 있다** → 기존 레코드. `UPDATE`로 나갑니다.

```
save(User, data)
  |
  +-- data.id is undefined or null?
  |     YES --> INSERT (new row)
  |     NO  --> UPDATE (existing row)
```

### INSERT 예시

```typescript
const user = await em.save(User, {
  name: "Alice",
  email: "alice@example.com",
});
console.log(user.id); // 1 -- auto-generated primary key
```

ORM이 생성하는 SQL:

```sql
-- PostgreSQL
INSERT INTO "user" ("name", "email")
VALUES ($1, $2)
RETURNING *
-- Parameters: ['Alice', 'alice@example.com']

-- MySQL
INSERT INTO `user` (`name`, `email`)
VALUES (?, ?)
-- Parameters: ['Alice', 'alice@example.com']
-- Then: SELECT * FROM `user` WHERE `id` = LAST_INSERT_ID()
```

PostgreSQL은 `RETURNING *`을 지원해서 한 번의 왕복으로 생성된 `id`를 포함한 전체 행을 돌려받아요. MySQL은 이를 지원하지 않아서 ORM이 추가 `SELECT`를 실행해요.

### UPDATE 예시

```typescript
const updated = await em.save(User, {
  id: 1,
  name: "Alice Kim",
  email: "alice@example.com",
});
console.log(updated.name); // "Alice Kim"
```

생성되는 SQL:

```sql
-- PostgreSQL
UPDATE "user"
SET "name" = $1, "email" = $2
WHERE "id" = $3
RETURNING *
-- Parameters: ['Alice Kim', 'alice@example.com', 1]

-- MySQL
UPDATE `user`
SET `name` = ?, `email` = ?
WHERE `id` = ?
-- Parameters: ['Alice Kim', 'alice@example.com', 1]
-- Then: SELECT * FROM `user` WHERE `id` = 1
```

### save() 중에 일어나는 일

1. **유효성 검사** -- 엔티티에 `@Validation` 데코레이터가 있으면 쿼리 전에 실행돼요.
2. **라이프사이클 훅** -- `@BeforeInsert` / `@BeforeUpdate` 콜백이 호출돼요.
3. **타임스탬프 주입** -- `@CreateTimestamp`는 INSERT 시, `@UpdateTimestamp`는 INSERT와 UPDATE 시 설정돼요.
4. **낙관적 잠금** -- `@Version` 컬럼이 있으면 버전이 일치하는지 확인하고 증가시켜요. 불일치 시 `OptimisticLockError`가 발생해요.
5. **캐스케이드** -- `cascade: true`로 표시된 관련 엔티티가 재귀적으로 저장돼요.
6. **이벤트 발생** -- `afterInsert` / `afterUpdate` 이벤트가 발생해요.

### 부분 업데이트

`save()`는 전달한 컬럼만 수정해요. 생략된 컬럼은 그대로 유지돼요:

```typescript
// name만 업데이트 -- email 등 다른 컬럼은 변경되지 않아요
await em.save(User, { id: 1, name: "Bob" });
```

```sql
-- PostgreSQL
UPDATE "user" SET "name" = $1 WHERE "id" = $2 RETURNING *
-- Parameters: ['Bob', 1]

-- MySQL
UPDATE `user` SET `name` = ? WHERE `id` = ?
-- Parameters: ['Bob', 1]
```

---

## 조회하기 -- find()와 findOne()

### 왜 메서드가 두 개일까

`find()`는 목록을, `findOne()`은 레코드 하나 또는 `null`을 돌려줍니다. `findOne()` 쪽은 SQL에 `LIMIT 1`이 자동으로 붙어서, DB가 첫 번째 매칭을 찾자마자 스캔을 끝냅니다. 천만 행짜리 테이블이라면 이 차이 하나로 쿼리 시간이 크게 달라져요.

### 목록 조회 -- find()

`find()`는 항상 `T[]`를 반환해요. 빈 테이블이면 `[]`을 반환하고, `null`이나 `undefined`는 절대 반환하지 않아요.

```typescript
// 모든 사용자 조회
const users = await em.find(User);
```

```sql
-- PostgreSQL
SELECT "id", "name", "email" FROM "user"

-- MySQL
SELECT `id`, `name`, `email` FROM `user`
```

#### WHERE 조건

```typescript
const activeUsers = await em.find(User, {
  where: { isActive: true },
});
```

```sql
-- PostgreSQL
SELECT "id", "name", "email", "isActive" FROM "user"
WHERE "isActive" = $1
-- Parameters: [true]

-- MySQL
SELECT `id`, `name`, `email`, `isActive` FROM `user`
WHERE `isActive` = ?
-- Parameters: [true]
```

#### ORDER BY + LIMIT

```typescript
const recent = await em.find(Post, {
  orderBy: { createdAt: "DESC" },
  take: 10,
});
```

```sql
-- PostgreSQL
SELECT "id", "title", "createdAt" FROM "post"
ORDER BY "createdAt" DESC
LIMIT 10

-- MySQL
SELECT `id`, `title`, `createdAt` FROM `post`
ORDER BY `createdAt` DESC
LIMIT 10
```

#### 복수 WHERE 조건 (AND)

`where`의 모든 키는 `AND` 조건이 돼요:

```typescript
const filtered = await em.find(User, {
  where: { isActive: true, role: "admin" },
  orderBy: { name: "ASC" },
});
```

```sql
-- PostgreSQL
SELECT "id", "name", "email", "isActive", "role" FROM "user"
WHERE "isActive" = $1 AND "role" = $2
ORDER BY "name" ASC
-- Parameters: [true, 'admin']

-- MySQL
SELECT `id`, `name`, `email`, `isActive`, `role` FROM `user`
WHERE `isActive` = ? AND `role` = ?
ORDER BY `name` ASC
-- Parameters: [true, 'admin']
```

OR, 서브쿼리, raw 조건 등 복잡한 쿼리는 [Query Builder](./query-builder.md)를 사용하세요.

### 단건 조회 -- findOne()

`findOne()`은 `T | null`을 반환해요. 결과를 사용하기 전에 반드시 `null` 체크를 해주세요.

```typescript
const user = await em.findOne(User, { where: { id: 1 } });

if (user === null) {
  throw new Error("User not found");
}

console.log(user.name);
```

```sql
-- PostgreSQL
SELECT "id", "name", "email" FROM "user"
WHERE "id" = $1
LIMIT 1
-- Parameters: [1]

-- MySQL
SELECT `id`, `name`, `email` FROM `user`
WHERE `id` = ?
LIMIT 1
-- Parameters: [1]
```

`LIMIT 1`은 자동으로 추가돼요. 1천만 행이 있는 테이블에서도 첫 번째 매칭에서 스캔을 멈춰요.

### 결과 보장 -- findOneOrFail()

레코드가 반드시 존재해야 하고 수동 `null` 체크를 피하고 싶다면 `findOneOrFail()`을 사용하세요. `findOne()`과 동일하게 동작하지만, 결과가 없으면 `EntityNotFoundError`를 던져요.

```typescript
// 유저가 없으면 EntityNotFoundError 발생
const user = await em.findOneOrFail(User, { where: { id: 1 } });
console.log(user.name); // 안전 -- null이 아님을 보장
```

서비스 메서드에서 레코드가 없는 경우가 잘못된 입력을 의미할 때 유용해요:

```typescript
async getUser(id: number): Promise<User> {
  return em.findOneOrFail(User, { where: { id } });
  // if (!user) throw new NotFoundException(); 같은 코드가 필요 없어요
}
```

던져지는 `EntityNotFoundError`에는 디버깅을 위한 엔티티 이름이 포함돼요. 리포지토리에서는 `userRepo.findOneOrFail({ where: { id } })`로 동일하게 사용할 수 있어요.

### 관계 로딩

`relations`를 넘기면 LEFT JOIN으로 연관 엔티티를 즉시 로딩할 수 있어요:

```typescript
const post = await em.findOne(Post, {
  where: { id: 1 },
  relations: ["author", "tags"],
});

console.log(post.author.name);  // User entity
console.log(post.tags);         // Tag[]
```

`author`와 같은 `@ManyToOne` 관계는 LEFT JOIN으로 처리돼요:

```sql
-- PostgreSQL
SELECT "post"."id", "post"."title", "post"."createdAt",
       "user"."id" AS "author_id", "user"."name" AS "author_name"
FROM "post"
LEFT JOIN "user" ON "post"."authorId" = "user"."id"
WHERE "post"."id" = $1
LIMIT 1
-- Parameters: [1]
```

`tags`와 같은 `@ManyToMany` 관계는 중간 테이블을 사용하는 별도 쿼리로 처리돼요:

```sql
SELECT "tag".* FROM "tag"
INNER JOIN "post_tags" ON "tag"."id" = "post_tags"."tagId"
WHERE "post_tags"."postId" = $1
-- Parameters: [1]
```

select, distinct, 잠금, 페이지네이션, 집계에 대한 자세한 내용은 [Querying & Pagination](./entity-manager-querying.md)을 참고해 주세요.

### 편의 메서드 -- findByPK(), findByPKs(), findByPKsMap(), exists(), pluck()

흔한 조회 패턴에서 `{ where: { id: ... } }`를 직접 쓰는 수고를 줄여 주는 단축 메서드들이에요:

```typescript
// 기본 키로 단건 조회
const user = await em.findByPK(User, 1);        // User | null

// 기본 키 여러 개로 배치 조회
const users = await em.findByPKs(User, [1, 2, 3]); // User[]

// 동일한 배치 조회이지만 Map으로 반환 — O(1) 조회
const map = await em.findByPKsMap(User, [1, 2, 99]);
map.has(1);   // true  — id 1이 존재
map.get(1);   // User 인스턴스
map.has(99);  // false — id 99는 없음

// 매칭 레코드 존재 여부 (WhereClause 직접 받음)
const hasAdmin = await em.exists(User, { role: "admin" }); // boolean
```

`findByPKsMap()`은 `findByPKs()`가 반환하는 `T[]`의 순서 보장이 필요하거나, 누락된 id를 `map.has(id)`로 바로 감지해야 할 때 씁니다. 단일 PK 엔티티는 raw 값(number / string / bigint)이 키가 되고, 복합 PK 엔티티는 `"col1=v1,col2=v2"` 형태의 문자열이 키가 됩니다.

`exists()`는 전체 행을 가져오는 대신 `SELECT 1 ... LIMIT 1`을 생성하므로 `find()` + length 비교보다 효율적이에요.

`pluck()`은 매칭 행에서 특정 컬럼 값만 모아 flat 배열로 돌려줍니다 — `find()` 후 `.map(row => row[column])`을 쓰는 것보다 간결해요:

```typescript
// 활성 유저의 id 목록
const ids = await em.pluck(User, "id", { active: true });
// -> [1, 2, 3]

// 게시된 포스트 제목 전체 — where 생략 시 전체 행 선택
const titles = await em.pluck(Post, "title");
```

내부적으로 `pluck()`은 단일 컬럼 `select`를 포함해 `find()`를 호출합니다. 따라서 테넌트 범위, soft-delete 필터링, 네이밍 전략이 모두 자동으로 적용돼요. 반환 순서는 `find()`와 동일합니다. 세 번째 인자(`where`)는 선택 사항이며, 생략 시 모든 행을 선택합니다.

`BaseRepository`에서는 엔티티 클래스 인자를 생략하고 호출해요:

```typescript
const ids = await userRepo.pluck("id", { active: true });
```

### 엔티티 구성 -- create(), merge(), preload()

이 헬퍼들은 엔티티 인스턴스를 **메모리에서** 만들거나 준비합니다. 스스로 저장하지 않으며, 숨은 Unit of Work나 변경 추적도 없어서 즉시 실행 모델은 그대로예요. 쓸 준비가 되면 결과를 `save()`에 넘기면 됩니다.

`create()`는 평범한 객체를 실제 클래스 인스턴스로 바꿔줍니다. `find()`가 돌려주는 것과 동일해서 인스턴스 메서드, 게터, `@Exclude`, 컬럼 트랜스포머가 모두 적용돼요. `save()`와 달리 SQL은 전혀 나가지 않습니다.

```typescript
const user = em.create(User, { name: "Alice", email });
user.activate();              // 인스턴스 메서드 동작
await em.save(User, user);    // 준비되면 저장

// 한 번에 여러 개 생성
const users = em.create(User, [{ name: "A" }, { name: "B" }]);
```

`merge()`는 기존 인스턴스 위에 부분 패치를 하나 이상 덮고 그 인스턴스를 반환합니다. 중첩된 일반 객체나 관계는 재귀적으로 병합하고, 배열·`Date`·`Buffer`는 통째로 교체하며, `undefined` 값은 건너뛰어 기존 필드를 지우지 않아요(비우려면 명시적으로 `null`을 넘깁니다).

```typescript
em.merge(user, { name: "New name" }, { status: "active" });
```

`preload()`는 read-modify-write를 위한 지름길입니다. 패치의 기본 키로 행을 로드한 뒤 나머지 필드를 로드된 인스턴스에 병합해서 `save()`에 바로 쓸 수 있게 돌려줘요. 지정하지 않은 컬럼은 DB 값을 그대로 유지합니다. 완전한 기본 키가 없거나 매칭 행이 없으면 `undefined`를 반환하므로(TypeORM과 동일), 부분 수정 엔드포인트가 "없음"과 "수정됨"을 구분할 수 있습니다.

```typescript
// PATCH /users/1  { name: "New name" }
const patched = await em.preload(User, { id: 1, name: "New name" });
if (!patched) throw new NotFoundException();
await em.save(User, patched); // email, role 등 언급 안 한 컬럼은 보존
```

`BaseRepository`에서는 엔티티 클래스 인자를 생략합니다:

```typescript
const draft = userRepo.create({ name: "Alice" });
const patched = await userRepo.preload({ id: 1, name: "New name" });
```

---

## 삭제하기 -- delete()

### delete()에 조건이 필수인 이유

행을 영구 삭제하는 건 되돌리기 어려운 작업입니다. 프로덕션 테이블 전체를 실수로 비워 버리면 복구할 길이 없어요. 그래서 `delete()`는 WHERE 조건을 **반드시** 받고, 빈 객체를 넘기면 에러를 던집니다.

```typescript
const result = await em.delete(User, { id: 1 });
console.log(result.affected); // 1
```

```sql
-- PostgreSQL
DELETE FROM "user" WHERE "id" = $1
-- Parameters: [1]

-- MySQL
DELETE FROM `user` WHERE `id` = ?
-- Parameters: [1]
```

기본 키뿐 아니라 어떤 컬럼으로든 삭제할 수 있어요:

```typescript
// 비활성 사용자 전부 삭제
const result = await em.delete(User, { isActive: false });
console.log(result.affected); // 삭제된 행 수
```

```sql
-- PostgreSQL
DELETE FROM "user" WHERE "isActive" = $1
-- Parameters: [false]

-- MySQL
DELETE FROM `user` WHERE `isActive` = ?
-- Parameters: [false]
```

::: danger
빈 조건 객체로 `delete()`를 호출하면 `DeleteWithoutConditionsError`가 발생해요. 모든 행을 실수로 삭제하는 것을 방지하는 안전장치예요.
:::

```typescript
// DeleteWithoutConditionsError 발생
await em.delete(User, {});
```

---

## Soft Delete -- softDelete()와 restore()

### Soft delete를 쓰는 이유

실제로 삭제하진 않고 "삭제된 것처럼" 다뤄야 할 때가 있습니다. 파일을 영구 삭제하지 않고 휴지통으로 옮기는 것과 같은 개념이에요. 자주 쓰이는 경우를 꼽으면:

- **법적 규정 준수** — 일정 기간 기록을 보관해야 하는 업종이 있습니다.
- **실행 취소** — 사용자가 마음을 바꿀 수 있으니까요. soft delete라면 되돌리는 게 한 번의 UPDATE로 끝납니다.
- **감사 추적** — "삭제된 뒤"에도 무엇이 있었는지 남아 있어야 할 때.

Soft delete는 행을 삭제하지 않아요. 대신 `@DeletedAt` 컬럼에 타임스탬프를 설정해요. Soft delete된 행은 `find()`와 `findOne()`에서 자동으로 제외돼요.

### 엔티티 설정

엔티티에 `@DeletedAt` 컬럼이 있어야 해요:

```typescript
import { Entity, PrimaryGeneratedColumn, Column, DeletedAt } from "@stingerloom/orm";

@Entity()
class Post {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "varchar" })
  title: string;

  @DeletedAt()
  deletedAt: Date | null;
}
```

### Soft delete 실행

```typescript
await em.softDelete(Post, { id: 1 });
// 해당 행의 deletedAt = '2026-03-22 12:00:00'으로 설정돼요
```

내부적으로는 DELETE가 아니라 UPDATE예요:

```sql
-- PostgreSQL
UPDATE "post" SET "deletedAt" = NOW() WHERE "id" = $1
-- Parameters: [1]

-- MySQL
UPDATE `post` SET `deletedAt` = NOW() WHERE `id` = ?
-- Parameters: [1]
```

Soft delete 후에는 ORM이 자동으로 `WHERE "deletedAt" IS NULL` 조건을 추가하기 때문에 일반 쿼리에서 보이지 않게 돼요:

```typescript
const posts = await em.find(Post);
// id=1인 Post는 포함되지 않아요
```

```sql
-- PostgreSQL
SELECT "id", "title", "deletedAt" FROM "post"
WHERE "deletedAt" IS NULL
```

Soft delete된 행도 포함하려면 `withDeleted: true`를 전달하세요:

```typescript
const allPosts = await em.find(Post, { withDeleted: true });
// id=1인 Post도 포함돼요
```

```sql
-- PostgreSQL (deletedAt 필터 없음)
SELECT "id", "title", "deletedAt" FROM "post"
```

### 복원하기

`restore()`는 `deletedAt`을 `NULL`로 되돌려서 행을 다시 보이게 만들어요:

```typescript
await em.restore(Post, { id: 1 });

const post = await em.findOne(Post, { where: { id: 1 } });
// post를 다시 찾을 수 있어요
```

```sql
-- PostgreSQL
UPDATE "post" SET "deletedAt" = NULL WHERE "id" = $1
-- Parameters: [1]

-- MySQL
UPDATE `post` SET `deletedAt` = NULL WHERE `id` = ?
-- Parameters: [1]
```

---

## 테이블 비우기 -- clear()

### clear()가 있는 이유와 쓸 때

`clear()`는 테이블의 **모든 행**을 지웁니다. `delete()`와 달리 내부적으로 `TRUNCATE`를 써요. 개별 행 삭제 로그를 남기지 않기 때문에 훨씬 빠릅니다.

테스트 사이의 정리 작업이나 시드 데이터 초기화에 쓰세요. 프로덕션에서는 정말로 테이블을 비우려는 게 아니라면 손대지 않는 게 좋습니다.

```typescript
await em.clear(User);
// "user" 테이블의 모든 행이 삭제돼요
```

```sql
-- PostgreSQL
TRUNCATE TABLE "user"

-- MySQL (FK 안전 처리 포함)
SET FOREIGN_KEY_CHECKS = 0;
TRUNCATE TABLE `user`;
SET FOREIGN_KEY_CHECKS = 1;
```

MySQL은 외래 키로 참조되는 테이블에서 `TRUNCATE`를 실행할 수 없어서 외래 키 체크를 임시로 비활성화해야 해요. ORM이 단일 연결 내에서 이를 자동으로 처리해요.

::: warning
`clear()`는 영구적이고 되돌릴 수 없는 작업이에요. Soft delete 버전은 없어요.
:::

---

## 다음 단계

- **[Querying & Pagination](./entity-manager-querying.md)** -- SELECT 컬럼, 정렬, DISTINCT, 잠금, 페이지네이션, 스트리밍, 집계, EXPLAIN
- **[Writes & Transactions](./entity-manager-writes.md)** -- 배치 작업, upsert, 트랜잭션, raw SQL
- **[Advanced](./entity-manager-advanced.md)** -- 이벤트, 구독자, 멀티테넌시, 플러그인, 셧다운, FindOption 레퍼런스
