# EntityManager -- CRUD 기본

Stingerloom에서 데이터베이스를 다루는 작업은 모두 **EntityManager**를 거칩니다. 생성, 조회, 수정, 삭제가 모두 이 클래스 하나에서 일어납니다.

```typescript
import { EntityManager } from "@stingerloom/orm";

const em = new EntityManager();
```

CRUD 외의 기능은 다른 페이지에 있습니다. 페이지네이션과 집계 같은 조회 기능은 [Querying & Pagination](./entity-manager-querying.md)을 참고하세요. 배치 쓰기, upsert, 트랜잭션은 [Writes & Transactions](./entity-manager-writes.md)를 참고하세요.

---

## 연결하기 -- register()

### register()가 필요한 이유

쿼리를 실행하려면 먼저 세 가지가 준비돼야 합니다.

- 데이터베이스 연결이 열려 있어야 합니다.
- ORM에 엔티티 클래스의 구조가 등록되어 있어야 합니다. 컬럼, 타입, 관계가 여기에 해당합니다.
- 실제 테이블이 엔티티 정의와 맞아야 합니다.

`register()`가 이 셋을 한 번에 처리합니다.

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

`register()`는 내부에서 세 단계를 거칩니다.

1. 연결: 연결 풀을 엽니다. 연결 풀은 재사용하는 연결의 묶음입니다. 그래서 여러 쿼리가 서로 기다리지 않고 동시에 실행될 수 있습니다. 풀 크기는 `pool` 옵션으로 조절합니다.
2. 메타데이터 스캔: 엔티티 클래스에 붙인 데코레이터(`@Entity`, `@Column`, `@ManyToOne` 등)를 읽어 내부 메타데이터 맵을 채웁니다. 예를 들어 `User` 클래스가 `user` 테이블에 대응한다는 정보, 컬럼이 `id`, `name`, `email`이라는 정보, `id`가 자동 증가 기본 키라는 정보가 이 단계에서 기록됩니다.
3. 스키마 동기화: `synchronize`가 켜져 있으면 메타데이터와 실제 테이블을 비교해 DDL을 생성합니다.

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

테이블은 이미 있지만 엔티티에 정의한 컬럼이 빠져 있으면 그 컬럼을 추가합니다.

```sql
-- PostgreSQL
ALTER TABLE "user" ADD "avatar" VARCHAR(255) NULL;

-- MySQL
ALTER TABLE `user` ADD `avatar` VARCHAR(255) NULL;
```

### synchronize 모드

| 값 | 동작 |
|---|------|
| `true` | 전체 동기화입니다. 테이블 생성, 컬럼 추가, 컬럼 삭제까지 엔티티에 맞춥니다. |
| `"safe"` | 안전 모드입니다. 테이블 생성과 컬럼 추가만 하고 변경, 삭제, 이름 변경은 하지 않습니다. 건너뛴 변경은 warn 한 줄로 요약됩니다. `logDDL`을 켜면 건너뛴 SQL 문 전체가 출력됩니다. |
| `"dry-run"` | 미리보기입니다. 실행될 DDL 문을 로그로 출력하고 실제로 적용하지는 않습니다. |
| `false` (기본값) | 동기화하지 않습니다. 스키마는 [마이그레이션](./migrations.md)으로 관리합니다. |

::: warning
`synchronize: true`는 개발 환경에서만 사용하세요. 프로덕션에서는 컬럼이 삭제될 수 있습니다. 프로덕션 스키마 관리에는 [마이그레이션](./migrations.md)을 사용하세요.
:::

### synchronize 옵션 객체

위의 단일 값은 서로 다른 관심사 세 가지를 enum 하나에 묶은 형태입니다. 복원력, 파괴적 변경 안전성, DDL 가시성이 그 셋입니다. 객체로 넘기면 각각을 따로 제어할 수 있습니다.

```ts
synchronize: {
  mode: "safe",                  // 기본 모드 (true | "safe" | "dry-run")
  continueOnError: false,         // 첫 DDL 실패에서 registerEntities() 중단
  failOnDestructiveChange: true,  // DROP COLUMN과 좁히는 ALTER 직전에 에러를 던짐
  logDDL: true,                   // 실행하는 모든 DDL을 info 레벨로 로그 출력
}
```

| 플래그 | 기본값 | 설정 시 동작 |
|--------|--------|------------|
| `mode` | 필수 | 기본 모드입니다. 단일 값 형태와 의미가 같습니다. |
| `continueOnError` | `true` | `false`이면 DDL 실패를 warn으로 낮추지 않고 `OrmError(SCHEMA_SYNC_FAILED)`를 던져 부팅을 중단합니다. 비교할 기존 테이블을 읽지 못한 경우와 알 수 없는 컬럼 타입은 이 값과 관계없이 부팅을 중단합니다. |
| `failOnDestructiveChange` | `false` | `true`이면 DROP COLUMN과 좁히는 ALTER를 실행하기 전에 `OrmError(SCHEMA_SYNC_DESTRUCTIVE_CHANGE)`를 던집니다(예: `varchar(255) → int`, `varchar(255) → varchar(64)`). synchronize는 어떤 모드에서도 테이블을 삭제하지 않습니다. |
| `logDDL` | `false` | `true`이면 실행하는 모든 DDL을 info 레벨로 출력합니다(CREATE TABLE, ALTER, RENAME, DROP, FULLTEXT INDEX 등). `"safe"`에서는 건너뛴 SQL 문도 `[skipped: safe mode]` 접두어를 붙여 출력합니다. |

단일 값 형태(`true`, `"safe"`, `"dry-run"`, `false`)도 그대로 동작합니다. 이 값은 위와 같은 기본값으로 정규화됩니다. 프로덕션에서 흔히 쓰는 설정은 다음과 같습니다.

```ts
synchronize: {
  mode: "safe",
  continueOnError: false,
  failOnDestructiveChange: true,
}
```

### Named connections (멀티 DB)

두 번째 인자로 연결 이름을 넘기면 여러 데이터베이스를 동시에 사용할 수 있습니다.

```typescript
const em = new EntityManager();

// Primary database
await em.register({ type: "postgres", /* ... */ entities: [User] }, "default");

// Analytics database
const analyticsEm = new EntityManager();
await analyticsEm.register({ type: "mysql", /* ... */ entities: [Event] }, "analytics");
```

연결 풀, 재시도, 레플리케이션, 쿼리 타임아웃 같은 연결 옵션의 전체 목록은 [Configuration Guide](./configuration.md)를 참고하세요.

---

## 저장하기 -- save()

### save()는 "스마트 upsert"

대부분의 쓰기는 두 갈래로 나뉩니다. 새로 만들거나 이미 있는 것을 고치는 것입니다. `save()`를 쓰면 `insert()`와 `update()`를 따로 호출할 필요가 없습니다. `save()`가 기본 키가 있는지 보고 둘 중 하나를 고릅니다.

- **기본 키 값이 없음** → 새 행이므로 `INSERT`를 실행합니다.
- **기본 키 값이 있음** → 기존 행이므로 `UPDATE`를 실행합니다.

```
save(User, data)
  |
  +-- data.id is undefined or null?
  |     YES --> INSERT (new row)
  |     NO  --> UPDATE (existing row)
```

위 그림은 데이터베이스가 키를 만드는 경우입니다(`@PrimaryGeneratedColumn()`). 이때 키 값이 있다면 그 값은 이미 존재하는 행에서 온 것입니다. 반면 호출하는 쪽에서 키를 정하는 경우에는 값이 있다는 사실만으로 행이 있는지 판단할 수 없습니다. 그래서 `save()`는 같은 트랜잭션 안에서 그 키의 행이 있는지 먼저 확인합니다. 그리고 행이 없으면 INSERT합니다.

| 기본 키 | `data`의 키 | `save()` 동작 |
|---|---|---|
| `@PrimaryGeneratedColumn()` (auto-increment) | 없음 | `INSERT` |
| | 있음 | `UPDATE`. 일치하는 행이 없으면 `EntityNotFoundError` |
| `@PrimaryGeneratedColumn("uuid")` | 없음 | 생성한 id로 `INSERT` |
| | 있음 | 행이 있으면 `UPDATE`하고 없으면 넘긴 id로 `INSERT` |
| `@PrimaryColumn()` (직접 지정 키, 복합 키) | 키 컬럼이 모두 있음 | 행이 있으면 `UPDATE`하고 없으면 `INSERT` |

존재 확인에는 기본 키로 조회하는 `SELECT`가 한 번 더 실행됩니다. `saveMany()`도 행마다 같은 규칙을 따릅니다.

### INSERT 예시

```typescript
const user = await em.save(User, {
  name: "Alice",
  email: "alice@example.com",
});
console.log(user.id); // 1 -- auto-generated primary key
```

ORM이 생성하는 SQL은 다음과 같습니다.

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

PostgreSQL은 `RETURNING *`을 지원합니다. 그래서 라운드 트립(round trip) 한 번으로 생성된 `id`를 포함한 전체 행을 받습니다. MySQL은 이를 지원하지 않으므로 ORM이 `SELECT`를 추가로 실행합니다.

### UPDATE 예시

```typescript
const updated = await em.save(User, {
  id: 1,
  name: "Alice Kim",
  email: "alice@example.com",
});
console.log(updated.name); // "Alice Kim"
```

생성되는 SQL은 다음과 같습니다.

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

1. **검증**: 엔티티에 `@Validation` 데코레이터가 있으면 쿼리 전에 실행됩니다.
2. **생명주기 훅**: `@BeforeInsert`와 `@BeforeUpdate` 콜백이 호출됩니다.
3. **타임스탬프 주입**: `@CreateTimestamp`는 INSERT할 때, `@UpdateTimestamp`는 INSERT와 UPDATE할 때 설정됩니다.
4. **낙관적 잠금**: `@Version` 컬럼이 있으면 버전이 일치하는지 확인하고 버전을 증가시킵니다. 일치하지 않으면 `OptimisticLockError`를 던집니다.
5. **캐스케이드**: `cascade: true`로 표시한 관련 엔티티를 재귀적으로 저장합니다.
6. **이벤트 발생**: `afterInsert`와 `afterUpdate` 이벤트가 발생합니다.

### 부분 업데이트

`save()`는 넘긴 컬럼만 수정합니다. 생략한 컬럼은 그대로 유지됩니다.

```typescript
// name만 갱신합니다. email 등 다른 컬럼은 변경되지 않습니다
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

`find()`는 목록을 반환하고 `findOne()`은 행 하나나 `null`을 반환합니다. `findOne()`의 SQL에는 `LIMIT 1`이 자동으로 붙습니다. 그래서 데이터베이스는 첫 번째로 매칭되는 행을 찾자마자 스캔을 끝냅니다. 천만 행짜리 테이블이라면 이 차이 하나로 쿼리 시간이 크게 달라집니다.

### 목록 조회 -- find()

`find()`는 항상 `T[]`를 반환합니다. 빈 테이블이면 `[]`를 반환합니다. `null`이나 `undefined`는 절대 반환하지 않습니다.

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

`where`의 모든 키는 `AND`로 묶입니다.

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

`findOne()`은 `T | null`을 반환합니다. 결과를 사용하기 전에 반드시 `null`인지 확인하세요.

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

`LIMIT 1`은 자동으로 추가됩니다. 1천만 행이 있는 테이블에서도 첫 번째로 매칭되는 행에서 스캔을 멈춥니다.

### 결과 보장 -- findOneOrFail()

행이 반드시 있어야 하고 `null` 확인을 직접 하고 싶지 않다면 `findOneOrFail()`을 사용하세요. `findOne()`과 똑같이 동작합니다. 다만 결과가 없으면 `EntityNotFoundError`를 던집니다.

```typescript
// 사용자가 없으면 EntityNotFoundError를 던짐
const user = await em.findOneOrFail(User, { where: { id: 1 } });
console.log(user.name); // 안전: null이 아님을 보장
```

서비스 메서드에서 행이 없다는 것이 잘못된 입력을 뜻할 때 유용합니다.

```typescript
async getUser(id: number): Promise<User> {
  return em.findOneOrFail(User, { where: { id } });
  // if (!user) throw new NotFoundException(); 같은 코드가 필요 없습니다
}
```

던지는 `EntityNotFoundError`에는 디버깅에 쓸 엔티티 이름이 들어 있습니다. 리포지토리에서는 `userRepo.findOneOrFail({ where: { id } })`로 똑같이 사용합니다.

`where`의 값이 모두 `undefined`이면 쿼리를 실행하기 전에 거부합니다. `findOne()`과 `findOneOrFail()` 모두 같습니다.

```typescript
async getUser(id: number | undefined): Promise<User> {
  return em.findOneOrFail(User, { where: { id } });
  // id가 undefined이면 아무 사용자나 반환하지 않고 InvalidQueryError를 던짐
}
```

이 검사가 없으면 조건이 사라져서 테이블의 첫 행을 조회합니다. 그러면 "or fail"은 절대 동작하지 않습니다. 다른 필드가 정의돼 있으면 undefined인 필드를 여전히 건너뜁니다. 이 경우를 포함한 전체 규칙은 [undefined 값](./entity-manager-querying.md#undefined-값)을 참고하세요.

### 관계 로딩

`relations`를 넘기면 LEFT JOIN으로 관련 엔티티를 즉시 로딩할 수 있습니다.

```typescript
const post = await em.findOne(Post, {
  where: { id: 1 },
  relations: ["author", "tags"],
});

console.log(post.author.name);  // User entity
console.log(post.tags);         // Tag[]
```

`author` 같은 `@ManyToOne` 관계는 LEFT JOIN으로 처리됩니다.

```sql
-- PostgreSQL
SELECT "post"."id", "post"."title", "post"."createdAt", "post"."authorId",
       "author"."id" AS "author__id", "author"."name" AS "author__name"
FROM "post"
LEFT JOIN "user" AS "author" ON "post"."authorId" = "author"."id"
WHERE "post"."id" = $1
LIMIT 1
-- Parameters: [1]
```

`tags` 같은 `@ManyToMany` 관계는 중간 테이블을 사용하는 별도 쿼리로 처리됩니다.

```sql
SELECT "tag".* FROM "tag"
INNER JOIN "post_tags" ON "tag"."id" = "post_tags"."tagId"
WHERE "post_tags"."postId" = $1
-- Parameters: [1]
```

select, distinct, 잠금, 페이지네이션, 집계의 자세한 내용은 [Querying & Pagination](./entity-manager-querying.md)을 참고하세요.

### 편의 메서드 -- findByPK(), findByPKs(), findByPKsMap(), exists(), pluck()

자주 쓰는 조회 패턴에서 `{ where: { id: ... } }`를 직접 쓰지 않아도 되게 해 주는 단축 메서드입니다.

```typescript
// 기본 키로 단건 조회
const user = await em.findByPK(User, 1);        // User | null

// 기본 키 여러 개로 배치 조회
const users = await em.findByPKs(User, [1, 2, 3]); // User[]

// 같은 배치 조회이지만 Map으로 반환합니다. O(1)로 조회합니다
const map = await em.findByPKsMap(User, [1, 2, 99]);
map.has(1);   // true: id 1이 존재
map.get(1);   // User 인스턴스
map.has(99);  // false: id 99는 없음

// 매칭되는 행의 존재 여부 (WhereClause를 직접 받음)
const hasAdmin = await em.exists(User, { role: "admin" }); // boolean
```

`findByPKs()`가 반환하는 `T[]`는 입력한 id의 순서를 보장하지 않습니다. 결과를 입력 순서대로 다시 맞추거나 누락된 id를 `map.has(id)`로 바로 확인해야 할 때 `findByPKsMap()`을 씁니다. 단일 기본 키 엔티티는 raw 값(number, string, bigint)이 키가 됩니다. 복합 기본 키 엔티티는 기본 키 속성을 선언한 순서대로 이은 `"prop1=v1,prop2=v2"` 형태의 문자열이 키가 됩니다.

`exists()`는 전체 행을 조회하지 않고 `SELECT 1 ... LIMIT 1`을 생성합니다. 그래서 `find()`로 조회한 뒤 길이를 비교하는 것보다 효율적입니다.

이 조회들은 `undefined`에 엄격합니다. 키가 빠지면 범위가 좁아지는 것이 아니라 넓어지기 때문입니다.

```typescript
await em.findByPK(User, undefined);           // InvalidQueryError
await em.findByPKs(User, [1, undefined]);     // InvalidQueryError
await em.findByPKsMap(User, [1, undefined]);  // InvalidQueryError
await em.exists(User, { role: undefined });   // InvalidQueryError

await em.findByPK(User, null);                // 그대로: IS NULL로 조회
```

복합 키라면 키 속성을 모두 넘겨야 합니다. `findByPK(Member, { tenantKey: "t1", userId: undefined })`는 `t1`의 아무 멤버나 매칭하지 않습니다. 대신 `userId`를 지목하는 에러를 던집니다. 여기서도 `null`은 값이므로 `IS NULL`로 매칭합니다. 키가 아닌 추가 속성은 이전처럼 필터로 쓰입니다.

`pluck()`은 매칭되는 행에서 특정 컬럼 값만 모아 1차원 배열로 반환합니다. `find()` 뒤에 `.map(row => row[column])`을 쓰는 것보다 간결합니다.

```typescript
// 활성 사용자의 id 목록
const ids = await em.pluck(User, "id", { active: true });
// -> [1, 2, 3]

// 게시된 게시글 제목 전체: where를 생략하면 모든 행을 선택
const titles = await em.pluck(Post, "title");
```

`pluck()`은 내부에서 컬럼 하나만 `select`하는 `find()`를 호출합니다. 그래서 테넌트 범위, 소프트 삭제 필터, 네이밍 전략이 모두 자동으로 적용됩니다. 반환 순서는 `find()`와 같습니다. 세 번째 인자인 `where`는 선택 사항이며 생략하면 모든 행을 선택합니다.

`BaseRepository`에서는 엔티티 클래스 인자를 생략하고 호출합니다.

```typescript
const ids = await userRepo.pluck("id", { active: true });
```

### 엔티티 구성 -- create(), merge(), preload()

이 헬퍼는 엔티티 인스턴스를 메모리에서 만들거나 준비합니다. 스스로 저장하지는 않습니다. 숨은 Unit of Work나 변경 추적도 없으므로 즉시 실행 모델은 그대로입니다. 쓸 준비가 되면 결과를 `save()`에 넘기세요.

`create()`는 평범한 객체를 실제 클래스 인스턴스로 바꿉니다. 결과는 `find()`가 반환하는 것과 같은 종류의 인스턴스입니다. 그래서 인스턴스 메서드, 게터, `@Exclude`, 컬럼 트랜스포머가 모두 적용됩니다. `save()`와 달리 SQL은 전혀 실행되지 않습니다.

```typescript
const user = em.create(User, { name: "Alice", email });
user.activate();              // 인스턴스 메서드 동작
await em.save(User, user);    // 준비되면 저장

// 한 번에 여러 개 생성
const users = em.create(User, [{ name: "A" }, { name: "B" }]);
```

`merge()`는 기존 인스턴스 위에 부분 패치를 하나 이상 덮어쓰고 그 인스턴스를 반환합니다. 병합 규칙은 다음과 같습니다.

- 중첩된 일반 객체와 관계는 재귀적으로 병합합니다.
- 배열, `Date`, `Buffer`는 값 전체를 교체합니다.
- `undefined` 값은 건너뛰므로 기존 필드를 지우지 않습니다. 필드를 비우려면 `null`을 명시적으로 넘깁니다.

```typescript
em.merge(user, { name: "New name" }, { status: "active" });
```

`preload()`는 read-modify-write를 짧게 쓰는 방법입니다. 먼저 패치의 기본 키로 행을 조회합니다. 그리고 나머지 필드를 조회한 인스턴스에 병합해서 `save()`에 바로 넘길 수 있는 상태로 반환합니다. 지정하지 않은 컬럼은 데이터베이스 값을 그대로 유지합니다. 기본 키가 완전하지 않거나 매칭되는 행이 없으면 `undefined`를 반환합니다(TypeORM과 같음). 그래서 부분 수정 엔드포인트에서 "없음"과 "수정됨"을 구분할 수 있습니다.

```typescript
// PATCH /users/1  { name: "New name" }
const patched = await em.preload(User, { id: 1, name: "New name" });
if (!patched) throw new NotFoundException();
await em.save(User, patched); // email, role 등 언급 안 한 컬럼은 보존
```

`BaseRepository`에서는 엔티티 클래스 인자를 생략합니다.

```typescript
const draft = userRepo.create({ name: "Alice" });
const patched = await userRepo.preload({ id: 1, name: "New name" });
```

---

## 삭제하기 -- delete()

### delete()에 조건이 필수인 이유

행을 영구 삭제하는 것은 되돌리기 어려운 작업입니다. 프로덕션 테이블 전체를 실수로 비우면 복구할 방법이 없습니다. 그래서 `delete()`는 WHERE 조건을 반드시 받습니다. 빈 객체를 넘기면 에러를 던집니다.

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

기본 키뿐 아니라 어떤 컬럼으로든 삭제할 수 있습니다.

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
빈 조건 객체로 `delete()`를 호출하면 `DeleteWithoutConditionsError`를 던집니다. 모든 행을 실수로 삭제하지 않게 막는 안전장치입니다.
:::

```typescript
// DeleteWithoutConditionsError를 던짐
await em.delete(User, {});
```

---

## Soft Delete -- softDelete()와 restore()

### Soft delete를 쓰는 이유

행을 실제로 삭제하지 않고 삭제된 것처럼 다뤄야 할 때가 있습니다. 파일을 영구 삭제하지 않고 휴지통으로 옮기는 것과 같습니다. 자주 쓰는 경우는 다음과 같습니다.

- **법적 규정 준수**: 일정 기간 기록을 보관해야 하는 업종이 있습니다.
- **실행 취소**: 사용자는 마음을 바꾸기도 합니다. 소프트 삭제라면 UPDATE 한 번으로 되돌립니다.
- **감사 추적**: 삭제된 뒤에도 무엇이 있었는지 남아 있어야 할 때 씁니다.

소프트 삭제(soft delete)는 행을 삭제하지 않습니다. 대신 `@DeletedAt` 컬럼에 타임스탬프를 설정합니다. 소프트 삭제된 행은 `find()`와 `findOne()`에서 자동으로 제외됩니다.

### 엔티티 설정

엔티티에 `@DeletedAt` 컬럼이 있어야 합니다.

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
// 해당 행의 deletedAt이 '2026-03-22 12:00:00'으로 설정됩니다
```

내부에서는 DELETE가 아니라 UPDATE를 실행합니다.

```sql
-- PostgreSQL
UPDATE "post" SET "deletedAt" = NOW() WHERE "id" = $1
-- Parameters: [1]

-- MySQL
UPDATE `post` SET `deletedAt` = NOW() WHERE `id` = ?
-- Parameters: [1]
```

소프트 삭제한 뒤에는 ORM이 `WHERE "deletedAt" IS NULL` 조건을 자동으로 추가합니다. 그래서 일반 쿼리에서는 그 행이 보이지 않습니다.

```typescript
const posts = await em.find(Post);
// id=1인 Post는 포함되지 않습니다
```

```sql
-- PostgreSQL
SELECT "id", "title", "deletedAt" FROM "post"
WHERE "deletedAt" IS NULL
```

소프트 삭제된 행도 포함하려면 `withDeleted: true`를 넘기세요.

```typescript
const allPosts = await em.find(Post, { withDeleted: true });
// id=1인 Post도 포함됩니다
```

```sql
-- PostgreSQL (deletedAt 필터 없음)
SELECT "id", "title", "deletedAt" FROM "post"
```

### 복원하기

`restore()`는 `deletedAt`을 `NULL`로 되돌려서 행이 다시 보이게 합니다.

```typescript
await em.restore(Post, { id: 1 });

const post = await em.findOne(Post, { where: { id: 1 } });
// post를 다시 조회할 수 있습니다
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

`clear()`는 호출한 쪽에서 보이는 엔티티의 모든 행을 삭제합니다. 테스트 사이의 정리 작업이나 시드 데이터 초기화에 쓰세요. 프로덕션에서는 정말로 테이블을 비우려는 것이 아니라면 쓰지 마세요.

```typescript
await em.clear(User);
// "user" 테이블의 모든 행이 삭제됩니다
```

```sql
DELETE FROM "user"
```

PostgreSQL, MySQL, SQLite 모두 같은 `DELETE` 문을 씁니다. 그래서 다른 쓰기 연산과 똑같이 동작합니다.

- **호출한 쪽의 트랜잭션 안에서 실행됩니다.** `em.transaction()`이나 `@Transactional()` 안에서 호출하면 나머지 작업과 함께 커밋되거나 롤백됩니다.
- **테넌트 범위를 지킵니다.** `tenantStrategy: "tenant_column"`에서는 현재 테넌트의 행만 삭제합니다(`DELETE FROM "user" WHERE "tenant_id" = $1`). 테넌트 컨텍스트 밖에서는 `delete()`와 마찬가지로 `tenantOnMissingContext` 정책을 따릅니다. 스키마 전략에서는 활성 테넌트의 테이블에서 삭제합니다.
- **다른 테이블에는 쓰지 않습니다.** 삭제하는 행을 참조하는 외래 키는 선언한 `onDelete` 동작을 따릅니다. `CASCADE`이면 참조하는 행도 삭제됩니다. `SET NULL`이면 그 키가 비워집니다. 기본값인 `NO ACTION`이면 참조하는 행이 있을 때 `clear()`가 실패하고 아무 행도 삭제되지 않습니다. 참조하는 테이블을 먼저 비우세요.

  ```typescript
  await em.clear(Post); // post가 user를 참조
  await em.clear(User);
  ```

- **아이덴티티 카운터를 재시작하지 않습니다.** 다음에 삽입하는 행은 1이 아니라 이어지는 id를 받습니다.
- **엔티티의 상속 계층 전체를 다룹니다.** `SINGLE_TABLE` 자식은 자기 서브타입의 행만 삭제합니다(`DELETE FROM "payment" WHERE "payment_type" = 'credit_card'`). 자세한 내용은 [Single Table Inheritance](./inheritance-sti.md#delete)를 참고하세요. `JOINED` 자식은 자기 테이블과 루트 테이블에서 그 행을 삭제합니다. `JOINED` 루트는 계층의 모든 테이블에서 삭제합니다. `TABLE_PER_CLASS` 루트는 모든 구체 테이블에서 삭제합니다.

소프트 삭제된 행도 함께 삭제됩니다. 생명주기 훅, 이벤트, `cascade` 옵션은 실행되지 않습니다.

::: warning
`clear()`는 영구적이고 되돌릴 수 없는 작업입니다. 소프트 삭제 버전은 없습니다.
:::

---

## 다음 단계

- [Querying & Pagination](./entity-manager-querying.md): SELECT 컬럼, 정렬, DISTINCT, 잠금, 페이지네이션, 스트리밍, 집계, EXPLAIN
- [Writes & Transactions](./entity-manager-writes.md): 배치 작업, upsert, 트랜잭션, raw SQL
- [Advanced](./entity-manager-advanced.md): 이벤트, 구독자, 멀티테넌시, 플러그인, 셧다운, FindOption 레퍼런스
