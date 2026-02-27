# EntityManager

**EntityManager**는 Stingerloom ORM의 핵심 진입점입니다. 데이터를 생성, 조회, 수정, 삭제하는 모든 작업이 EntityManager를 통해 이루어집니다.

```typescript
import { EntityManager } from "stingerloom-orm";

const em = new EntityManager();
```

이 문서에서는 개발할 때 가장 많이 사용하는 기능부터 순서대로 설명합니다.

## DB 연결하기 — register()

EntityManager를 사용하려면 먼저 데이터베이스에 연결해야 합니다.

```typescript
// main.ts
import "reflect-metadata";
import { EntityManager } from "stingerloom-orm";
import { User } from "./user.entity";

const em = new EntityManager();

await em.register({
  type: "postgres",
  host: "localhost",
  port: 5432,
  username: "postgres",
  password: "password",
  database: "mydb",
  entities: [User],
  synchronize: true,
});
```

`register()`가 하는 일은 세 가지입니다: DB에 연결하고, 엔티티 메타데이터를 스캔하고, `synchronize: true`이면 테이블을 자동 생성합니다.

> **Warning** `synchronize: true`는 개발 환경에서만 사용하세요. 프로덕션에서는 [마이그레이션](./migrations.md)으로 스키마를 관리해야 합니다.

연결 옵션에 대한 자세한 내용은 [설정 가이드](./configuration.md)를 참고하세요.

## 저장하기 — save()

데이터를 저장할 때는 `save()`를 사용합니다. PK가 없으면 INSERT, PK가 있으면 UPDATE를 자동으로 수행합니다.

```typescript
// INSERT — PK(id)가 없으므로 새 행 삽입
const user = await em.save(User, {
  name: "홍길동",
  email: "hong@example.com",
});
console.log(user.id); // 1 — 자동 생성된 PK

// UPDATE — PK(id)가 있으므로 기존 행 수정
const updated = await em.save(User, {
  id: 1,
  name: "홍길동(수정)",
  email: "hong@example.com",
});
```

`save()`는 저장된 엔티티 객체를 반환하므로, INSERT 후에도 자동 생성된 `id`를 바로 사용할 수 있습니다.

## 조회하기 — find(), findOne()

### 목록 조회

```typescript
// 전체 조회
const users = await em.find(User);

// WHERE 조건
const activeUsers = await em.find(User, {
  where: { isActive: true },
});

// ORDER BY + LIMIT
const recent = await em.find(Post, {
  orderBy: { createdAt: "DESC" },
  take: 10,
});
```

### 단건 조회

```typescript
const user = await em.findOne(User, { where: { id: 1 } });

if (user === null) {
  throw new Error("사용자를 찾을 수 없습니다");
}
```

`findOne()`은 결과가 없으면 `null`을 반환합니다. 항상 null 체크를 해주세요.

### 특정 컬럼만 SELECT

필요한 컬럼만 가져오면 쿼리가 가벼워집니다.

```typescript
// 배열 방식
const names = await em.find(User, {
  select: ["id", "name"],
});

// 객체 방식
const names2 = await em.find(User, {
  select: { id: true, name: true },
});
```

### 관계 엔티티 함께 로드

```typescript
const owner = await em.findOne(Owner, {
  where: { id: 1 },
  relations: ["cats"],
});
console.log(owner.cats); // Cat[]
```

### Soft Delete된 데이터 포함

```typescript
const allPosts = await em.find(Post, {
  withDeleted: true, // deleted_at이 NULL이 아닌 행도 포함
});
```

## 삭제하기 — delete(), softDelete()

### 영구 삭제

```typescript
const result = await em.delete(User, { id: 1 });
console.log(result.affected); // 1
```

빈 조건으로 삭제하면 `DeleteWithoutConditionsError`가 발생합니다. 실수로 전체 데이터를 삭제하는 것을 방지합니다.

### Soft Delete

`@DeletedAt` 컬럼이 있는 엔티티에 사용합니다. 실제로 삭제하지 않고 `deleted_at = NOW()`로 표시만 합니다.

```typescript
// soft delete
await em.softDelete(Post, { id: 1 });

// 이후 find()에서 자동 제외됨
const posts = await em.find(Post); // deleted_at IS NULL인 것만 조회

// 복원
await em.restore(Post, { id: 1 });
```

## 배치 연산 — insertMany(), saveMany(), deleteMany()

여러 건의 데이터를 한 번에 처리해야 할 때 사용합니다.

```typescript
// 단일 INSERT 쿼리로 여러 건 삽입 (가장 빠름)
await em.insertMany(User, [
  { name: "홍길동", email: "hong@example.com" },
  { name: "김철수", email: "kim@example.com" },
  { name: "이영희", email: "lee@example.com" },
]);

// 각 건마다 INSERT/UPDATE 판단 (PK 유무에 따라)
const users = await em.saveMany(User, [
  { name: "새사용자", email: "new@example.com" },       // INSERT
  { id: 2, name: "수정", email: "updated@example.com" }, // UPDATE
]);

// PK 배열로 한 번에 삭제
await em.deleteMany(User, [1, 2, 3]);
```

> **Hint** 대량 INSERT는 `insertMany()`가 가장 효율적입니다. 단일 `INSERT INTO ... VALUES (...), (...)` 쿼리로 실행되기 때문입니다.

## Upsert — 있으면 수정, 없으면 삽입

`upsert()`는 PK나 유니크 컬럼 기준으로 충돌 여부를 확인합니다. 이미 있으면 UPDATE, 없으면 INSERT를 수행합니다.

```typescript
// PK 기준 upsert
await em.upsert(User, {
  id: 1,
  name: "홍길동",
  email: "hong@example.com",
});

// 유니크 컬럼 기준 upsert
await em.upsert(User, {
  email: "hong@example.com",
  name: "홍길동",
}, ["email"]); // email이 이미 있으면 UPDATE, 없으면 INSERT
```

내부적으로 MySQL은 `INSERT ... ON DUPLICATE KEY UPDATE`, PostgreSQL은 `INSERT ... ON CONFLICT DO UPDATE`를 사용합니다.

## 집계 함수 — count(), sum(), avg(), min(), max()

통계 데이터가 필요할 때 사용합니다.

```typescript
const total = await em.count(User);
const active = await em.count(User, { isActive: true });

const avgAge = await em.avg(User, "age");
const youngest = await em.min(User, "age");
const oldest = await em.max(User, "age");
const totalAge = await em.sum(User, "age");
```

여러 집계를 동시에 조회하면 성능이 좋습니다.

```typescript
const [total, avgAge, minAge, maxAge] = await Promise.all([
  em.count(User),
  em.avg(User, "age"),
  em.min(User, "age"),
  em.max(User, "age"),
]);
```

## 페이지네이션

### Offset 방식

전통적인 LIMIT/OFFSET 페이지네이션입니다. 소규모 데이터셋에 적합합니다.

```typescript
// 방법 1: take + limit
const page2 = await em.find(Post, {
  orderBy: { createdAt: "DESC" },
  limit: [10, 10], // OFFSET 10, LIMIT 10
});

// 방법 2: findAndCount — 전체 개수도 함께 반환
const [posts, total] = await em.findAndCount(Post, {
  orderBy: { createdAt: "DESC" },
  take: 10,
  limit: [0, 10],
});

console.log(posts.length); // 10
console.log(total);        // 전체 게시글 수 (예: 235)
```

### 커서 방식

대용량 데이터에서는 커서 기반 페이지네이션이 성능이 일정합니다.

```typescript
// 첫 페이지
const page1 = await em.findWithCursor(Post, {
  take: 20,
  orderBy: "id",
  direction: "ASC",
});

console.log(page1.data);        // Post[] (최대 20건)
console.log(page1.hasNextPage); // true
console.log(page1.nextCursor);  // "eyJ2IjoyMH0=" (Base64)

// 두 번째 페이지 — 이전 커서를 전달
const page2 = await em.findWithCursor(Post, {
  take: 20,
  cursor: page1.nextCursor!,
  orderBy: "id",
  direction: "ASC",
});
```

> **Hint** 커서 방식은 "다음 페이지"/"이전 페이지" 네비게이션에 적합합니다. 특정 페이지로 점프해야 한다면 offset 방식을 사용하세요.

## Raw SQL 실행 — query()

ORM이 제공하지 않는 복잡한 쿼리가 필요할 때 직접 SQL을 실행할 수 있습니다.

```typescript
import sql from "sql-template-tag";

// sql-template-tag 사용 (권장 — SQL Injection 방지)
const users = await em.query<{ id: number; name: string }>(
  sql`SELECT * FROM "user" WHERE "id" = ${1}`
);

// 문자열 + 파라미터 배열
const posts = await em.query<{ id: number; title: string }>(
  "SELECT id, title FROM post WHERE author_id = ?",
  [42]
);
```

> **Warning** Raw SQL을 사용할 때는 반드시 파라미터 바인딩을 사용하세요. 문자열 연결로 값을 끼워넣으면 SQL Injection 위험이 있습니다.

## EXPLAIN — 쿼리 분석

쿼리가 인덱스를 제대로 사용하는지 확인할 때 유용합니다.

```typescript
const result = await em.explain(User, {
  where: { email: "hong@example.com" },
});

console.log(result.type); // "ref" — 인덱스 사용 중
console.log(result.key);  // "idx_user_email"
console.log(result.rows); // 1 — 예상 검사 행 수
```

> **Hint** `explain()`은 MySQL과 PostgreSQL에서 지원됩니다. SQLite/MSSQL에서는 `InvalidQueryError`가 발생합니다.

## 이벤트 리스너

데이터가 생성/수정/삭제될 때 자동으로 실행되는 로직을 등록할 수 있습니다.

```typescript
// 리스너 등록
em.on("afterInsert", ({ entity, data }) => {
  console.log(`${entity.name} 생성됨:`, data);
});

// 리스너 제거
em.off("afterInsert", listener);

// 전체 리스너 제거
em.removeAllListeners();
```

사용 가능한 이벤트: `beforeInsert`, `afterInsert`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, `afterDelete`

특정 엔티티에만 반응하는 구독자가 필요하다면 [EntitySubscriber](./advanced.md)를 참고하세요.

## 리포지토리 패턴

엔티티별로 CRUD를 캡슐화하고 싶다면 `getRepository()`를 사용합니다.

```typescript
const userRepo = em.getRepository(User);

const users = await userRepo.find();
const user = await userRepo.findOne({ where: { id: 1 } as any });
await userRepo.save({ name: "홍길동" });
```

NestJS에서는 `@InjectRepository()`로 서비스에 주입할 수 있습니다.

```typescript
// users.service.ts
@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly userRepo: BaseRepository<User>,
  ) {}

  async findAll() {
    return this.userRepo.find();
  }
}
```

## 종료 — propagateShutdown()

애플리케이션을 종료할 때 EntityManager의 내부 리소스를 정리합니다.

```typescript
await em.propagateShutdown();
```

NestJS에서는 `OnModuleDestroy` 훅에서 호출하세요.

## FindOption 전체 옵션

`find()`, `findOne()`, `explain()` 등에 전달할 수 있는 옵션 목록입니다.

| 옵션 | 타입 | 설명 |
|------|------|------|
| `where` | `Partial<T>` | WHERE 조건 |
| `select` | `(keyof T)[]` 또는 `Record<keyof T, boolean>` | SELECT 컬럼 |
| `orderBy` | `Record<keyof T, "ASC" \| "DESC">` | ORDER BY |
| `limit` | `number` 또는 `[offset, count]` | LIMIT |
| `take` | `number` | 가져올 행 수 |
| `relations` | `(keyof T)[]` | 로드할 관계 프로퍼티 |
| `withDeleted` | `boolean` | soft-deleted 포함 여부 |
| `groupBy` | `(keyof T)[]` | GROUP BY |
| `having` | `Sql[]` | HAVING 절 |
| `timeout` | `number` | 쿼리 타임아웃 (ms) |
| `useMaster` | `boolean` | Read Replica 환경에서 master 강제 |

## 다음 단계

- [쿼리 빌더](./query-builder.md) — JOIN, GROUP BY, 서브쿼리 등 복잡한 SQL이 필요할 때
- [트랜잭션](./transactions.md) — 여러 작업을 하나의 단위로 묶어야 할 때
- [설정 가이드](./configuration.md) — 풀링, 타임아웃, Read Replica 등 운영 설정
