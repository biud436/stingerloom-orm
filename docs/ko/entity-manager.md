# EntityManager -- CRUD 기본

**EntityManager**는 Stingerloom ORM에서 모든 데이터베이스 작업의 중심이에요. 생성, 조회, 수정, 삭제 모두 이 클래스를 통해 이루어져요.

```typescript
import { EntityManager } from "@stingerloom/orm";

const em = new EntityManager();
```

이 문서에서는 기본적인 CRUD 라이프사이클을 다뤄요. 페이지네이션, 집계 등 조회 기능은 [Querying & Pagination](./entity-manager-querying.md)을, 배치 쓰기, upsert, 트랜잭션은 [Writes & Transactions](./entity-manager-writes.md)을 참고해 주세요.

---

## 연결하기 -- register()

### register()가 필요한 이유

쿼리를 실행하려면 세 가지가 먼저 준비되어야 해요: (1) 데이터베이스에 대한 실제 연결, (2) 엔티티 클래스의 구조(컬럼, 타입, 관계) 파악, (3) 데이터베이스 테이블이 실제로 엔티티와 일치하는지 확인. `register()` 메서드는 이 세 가지를 한 번에 처리해요.

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

`register()`는 내부적으로 세 단계를 수행해요:

**1단계 -- 연결.** 데이터베이스에 대한 커넥션 풀을 생성해요. 풀은 재사용 가능한 연결 묶음이에요. 여러 쿼리가 서로 기다리지 않고 동시에 실행될 수 있도록 해줘요. 풀 크기는 `pool` 옵션으로 설정할 수 있어요.

**2단계 -- 메타데이터 스캔.** 엔티티 클래스에 붙인 데코레이터(`@Entity`, `@Column`, `@ManyToOne` 등)를 읽어서 내부 메타데이터 맵을 구성해요. 예를 들어 "`User` 클래스는 `user` 테이블에 대응하고, `id`, `name`, `email` 컬럼이 있으며, `id`는 자동 증가 기본 키이다"와 같은 정보를 파악해요. TypeScript에서 스키마를 정의하면 ORM이 시작 시점에 이를 학습하는 방식이에요.

**3단계 -- 스키마 동기화.** `synchronize`가 활성화되어 있으면 메타데이터 맵과 실제 데이터베이스 테이블을 비교해서 차이를 맞추는 DDL을 생성해요:

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
| `"safe"` | 안전 모드 -- 테이블 생성과 컬럼 추가만 하고, 컬럼이나 테이블을 **삭제하지 않아요**. |
| `"dry-run"` | 미리보기 -- 실행될 DDL 문을 로그로 출력하되, 실제 적용하지 않아요. |
| `false` (기본값) | 동기화 없음. [마이그레이션](./migrations.md)으로 스키마를 관리해요. |

::: warning
`synchronize: true`는 개발 환경에서만 사용하세요. 프로덕션에서는 컬럼이 삭제될 수 있어요. 프로덕션 스키마 관리에는 [마이그레이션](./migrations.md)을 사용하세요.
:::

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

대부분의 애플리케이션에는 새 레코드 생성과 기존 레코드 수정이라는 두 가지 쓰기 패턴이 있어요. `save()`는 `insert()`와 `update()`를 따로 호출할 필요 없이 기본 키를 보고 자동으로 판단해요:

- **PK 값이 없으면** -- 새 레코드예요. `INSERT`를 실행해요.
- **PK 값이 있으면** -- 이미 존재하는 레코드예요. `UPDATE`를 실행해요.

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

### 왜 두 개의 메서드가 있을까요?

`find()`는 리스트를 반환하고, `findOne()`은 정확히 하나의 레코드 또는 `null`을 반환해요. `findOne()`은 SQL에 `LIMIT 1`을 추가해서 데이터베이스가 하나의 매칭을 찾자마자 스캔을 중단하도록 해요. 대용량 테이블에서 큰 성능 차이를 만들어요.

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

---

## 삭제하기 -- delete()

### delete()에 조건이 필수인 이유

행을 영구적으로 삭제하는 건 위험해요. 프로덕션 테이블의 모든 행을 실수로 삭제하면 복구할 수 없어요. 그래서 `delete()`는 WHERE 조건을 **필수**로 요구하고, 빈 객체를 넘기면 에러를 던져요.

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

데이터를 실제로 삭제하지 않고 "삭제된 것처럼" 처리하고 싶을 때가 있어요. 파일을 영구 삭제하는 대신 휴지통으로 옮기는 것과 같은 개념이에요. 주요 사용 사례:

- **법적 규정 준수**: 일정 기간 기록을 보관해야 하는 경우가 있어요.
- **실행 취소**: 사용자가 마음을 바꿀 수 있어요. Soft delete면 복원이 쉽지만, 하드 삭제면 불가능해요.
- **감사 추적**: "삭제" 이후에도 무엇이 존재했는지 알고 싶을 때 유용해요.

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

### clear()가 있는 이유와 사용 시점

`clear()`는 테이블의 **모든 행**을 삭제해요. `delete()`와 달리 데이터베이스의 `TRUNCATE` 명령을 사용해서, 개별 행 삭제 로그를 생성하지 않아 훨씬 빨라요.

테스트 정리나 시드 데이터 초기화에 사용하세요. 정말로 테이블을 비우려는 게 아니라면 프로덕션에서는 쓰지 마세요.

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
