# Advanced Features

프로덕션 환경에서 유용한 고급 기능을 다뤄요. 각 섹션은 기능이 *왜* 필요한지 먼저 설명하고, *어떻게* 사용하는지를 보여줘요. 기본 CRUD와 관계를 익힌 뒤에 필요한 부분만 골라서 읽으면 돼요.

## EntitySubscriber -- 엔티티별 이벤트 구독

### 왜 필요한가요

글로벌 `em.on()` 리스너는 모든 엔티티의 이벤트를 받아요. 하지만 실제로는 모든 엔티티에 같은 로직을 적용하는 경우가 드물어요. `User`가 생성되면 환영 이메일을 보내고, `Order`가 생성되면 창고에 알림을 보내야 하죠. 엔티티마다 다른 동작이 필요해요.

`EntitySubscriber`를 사용하면 특정 엔티티 클래스에 한정된 이벤트 핸들러를 작성할 수 있어요. ORM이 이벤트의 엔티티 타입을 확인해서 일치하는 subscriber에만 디스패치해요. 이벤트 로직을 깔끔하게 정리할 수 있어요.

### 사용법

```typescript
// user-audit.subscriber.ts
import {
  EntitySubscriber,
  InsertEvent,
  UpdateEvent,
  DeleteEvent,
} from "@stingerloom/orm";
import { User } from "./user.entity";

class UserAuditSubscriber implements EntitySubscriber<User> {
  listenTo() {
    return User; // Only receive events for this entity
  }

  async afterInsert(event: InsertEvent<User>) {
    console.log("User created:", event.entity);
  }

  async afterUpdate(event: UpdateEvent<User>) {
    console.log("User updated:", event.entity);
  }

  async afterDelete(event: DeleteEvent<User>) {
    console.log("User deleted, criteria:", event.criteria);
  }
}
```

```typescript
// Register
em.addSubscriber(new UserAuditSubscriber());

// Unregister
em.removeSubscriber(subscriber);
```

EntitySubscriber가 지원하는 이벤트 목록이에요.

| Method | 실행 시점 |
|--------|--------|
| `afterLoad(entity)` | DB에서 엔티티를 로드한 후 |
| `beforeInsert(event)` / `afterInsert(event)` | INSERT 전/후 |
| `beforeUpdate(event)` / `afterUpdate(event)` | UPDATE 전/후 |
| `beforeDelete(event)` / `afterDelete(event)` | DELETE 전/후 |
| `beforeTransactionStart()` / `afterTransactionStart()` | 트랜잭션 시작 전/후 |
| `beforeTransactionCommit()` / `afterTransactionCommit()` | COMMIT 전/후 |
| `beforeTransactionRollback()` / `afterTransactionRollback()` | ROLLBACK 전/후 |

## N+1 감지와 슬로우 쿼리 경고

### 왜 필요한가요

N+1 문제는 ORM을 사용하는 애플리케이션에서 가장 흔한 성능 킬러예요. 조용히 발생하죠 -- 코드는 깔끔하고 테스트도 통과하는데, 데이터베이스가 쿼리 폭탄을 맞고 있어요.

이런 상황을 가정해봐요. 사용자 10명을 조회해요. 각 사용자의 게시글에 접근해요. ORM이 lazy 로딩으로 사용자별로 쿼리를 하나씩 날리면 이렇게 돼요:

```sql
-- The "1" query: fetch all users
SELECT "id", "name" FROM "user"

-- The "N" queries: one per user
SELECT "id", "title", "userId" FROM "post" WHERE "userId" = $1  -- user 1
SELECT "id", "title", "userId" FROM "post" WHERE "userId" = $2  -- user 2
SELECT "id", "title", "userId" FROM "post" WHERE "userId" = $3  -- user 3
-- ...7 more queries...
```

1번이면 될 걸 11번 쿼리하고 있어요. 사용자가 100명이면 101번이 돼요. 해결책은 JOIN으로 한 번에 가져오는 거예요:

```sql
-- One query with JOIN: fetch users and their posts together
SELECT "user"."id", "user"."name", "post"."id" AS "posts_id", "post"."title" AS "posts_title"
FROM "user"
LEFT JOIN "post" ON "user"."id" = "post"."userId"
```

Stingerloom은 엔티티별 쿼리를 추적해서 짧은 시간 안에 같은 테이블에 반복 쿼리가 발생하면 N+1 패턴으로 감지하고 경고해줘요.

### 사용법

```typescript
await em.register({
  type: "postgres",
  // ...
  logging: {
    slowQueryMs: 500,  // Warn on queries taking longer than 500ms
    nPlusOne: true,    // Enable N+1 pattern detection
  },
});
```

설정 후 쿼리 로그를 확인할 수 있어요.

```typescript
const log = em.getQueryLog();
// [
//   { entity: "User", sql: "SELECT ...", durationMs: 12 },
//   { entity: "Cat", sql: "SELECT ...", durationMs: 8 },
//   ...
// ]
```

> **Hint** N+1이 감지되면 JOIN 기반 로딩으로 전환하세요. relation 데코레이터에 `eager: true`를 설정하거나, `relations` 옵션을 전달하면 돼요: `em.find(User, { relations: ["posts"] })`.

## Cursor 기반 페이지네이션

### 왜 필요한가요

Offset 페이지네이션(`LIMIT 10 OFFSET 10000`)에는 근본적인 문제가 있어요. 10,000행을 건너뛰려면 데이터베이스가 10,000행을 전부 읽고 버려야 해요. 페이지가 깊어질수록 느려져요.

SQL로 비교해볼게요. Offset 기반으로 500페이지를 조회하면:

```sql
-- Offset: the DB reads 10,000 rows, throws away 9,990, returns 10
SELECT * FROM "post" ORDER BY "id" ASC LIMIT 10 OFFSET 9990
```

Cursor 기반으로 같은 위치를 조회하면:

```sql
-- Cursor: the DB jumps directly to id > 9990, reads only 10 rows
SELECT * FROM "post" WHERE "id" > $1 ORDER BY "id" ASC LIMIT 11
-- Parameters: [9990]
```

Cursor 방식은 `WHERE` 절로 인덱스의 정확한 위치로 바로 점프해요. 1페이지든 5,000페이지든 성능이 동일해요. 여분의 1행(`take`가 10일 때 `LIMIT 11`)은 별도의 COUNT 쿼리 없이 다음 페이지가 있는지 확인하는 데 사용돼요.

### 사용법

```typescript
// First page
const page1 = await em.findWithCursor(Post, {
  take: 20,
  orderBy: "id",
  direction: "ASC",
  where: { isPublished: true },
});

// Second page -- pass nextCursor
const page2 = await em.findWithCursor(Post, {
  take: 20,
  cursor: page1.nextCursor!,
  orderBy: "id",
  direction: "ASC",
  where: { isPublished: true },
});

console.log(page2.data);        // Post[]
console.log(page2.hasNextPage); // true/false
console.log(page2.nextCursor);  // Cursor for the next page
```

REST API에서 사용하는 예시예요.

```typescript
// GET /posts?take=20&cursor=eyJ2IjoyMH0=
async function getPosts(req: Request, res: Response) {
  const result = await em.findWithCursor(Post, {
    take: parseInt(req.query.take as string) || 20,
    cursor: req.query.cursor as string | undefined,
    orderBy: "id",
    direction: "ASC",
  });

  res.json({
    items: result.data,
    nextCursor: result.nextCursor,
    hasNextPage: result.hasNextPage,
  });
}
```

offset vs cursor vs streaming 전략 비교는 [Pagination & Streaming](./pagination.md)을 참고하세요.

## Validation

### 왜 필요한가요

유효성 검사는 서비스 메서드에 흩어져 있는 게 아니라 엔티티 레벨에서 이뤄져야 해요. `price`가 양수여야 한다면, 그 규칙은 `Product` 엔티티에 있어야 어떤 코드 경로에서 저장하든 강제돼요.

`save()`를 호출하면 데코레이터로 정의된 제약 조건이 자동으로 검증돼요. 유효성 검사에 실패하면 SQL이 실행되기 전에 `ValidationError`가 던져져요 -- 잘못된 데이터가 데이터베이스에 도달하지 않아요.

### 사용법

```typescript
import {
  Entity, Column, PrimaryGeneratedColumn,
  NotNull, MinLength, MaxLength, Min, Max,
} from "@stingerloom/orm";

@Entity()
export class Product {
  @PrimaryGeneratedColumn()
  id!: number;

  @NotNull()
  @MinLength(2)
  @MaxLength(100)
  @Column()
  name!: string;

  @Min(0)
  @Max(9999999)
  @Column({ type: "float" })
  price!: number;
}
```

```typescript
try {
  await em.save(Product, { name: "A", price: -1 });
} catch (e) {
  console.error(e.message); // "name must be at least 2 characters long"
}
```

| Decorator | 대상 타입 | 설명 |
|-----------|--------|-------------|
| `@NotNull()` | 모든 타입 | null/undefined 불허 |
| `@MinLength(n)` | string | 최소 길이 |
| `@MaxLength(n)` | string | 최대 길이 |
| `@Min(n)` | number | 최솟값 |
| `@Max(n)` | number | 최댓값 |

## BaseRepository -- Repository 패턴

### 왜 필요한가요

`em.find(User, ...)`, `em.save(User, ...)`, `em.delete(User, ...)`를 반복 작성하다 보면 `User` 인자가 항상 같아요. Repository는 EntityManager를 특정 엔티티에 한 번 바인딩해서 매번 엔티티 클래스를 반복할 필요가 없게 해줘요. 각 서비스가 전지전능한 EntityManager 대신 자기 전용 repository로 작업하니까 경계가 명확해져요.

### 사용법

```typescript
const userRepo = em.getRepository(User);

// Use the same API as EntityManager without specifying the entity
const users = await userRepo.find();
const user = await userRepo.findOne({ where: { id: 1 } as any });
await userRepo.save({ name: "John Doe" });
await userRepo.delete({ id: 1 });
```

NestJS에서는 `@InjectRepository()`로 서비스에 주입할 수 있어요.

```typescript
@Injectable()
class UsersService {
  constructor(
    @InjectRepository(User) private readonly userRepo: BaseRepository<User>
  ) {}

  async findAll() {
    return this.userRepo.find();
  }
}
```

BaseRepository는 EntityManager의 거의 모든 메서드를 지원해요: `find`, `findOne`, `findWithCursor`, `findAndCount`, `save`, `delete`, `softDelete`, `restore`, `insertMany`, `saveMany`, `deleteMany`, `count`, `sum`, `avg`, `min`, `max`, `explain`, `upsert`, `stream`, `createQueryBuilder`.

```typescript
// Streaming via repository
for await (const user of userRepo.stream({ where: { isActive: true } })) {
  await process(user);
}

// Type-safe query builder via repository
const [users, total] = await userRepo
  .createQueryBuilder("u")
  .where("isActive", true)
  .orderBy({ createdAt: "DESC" })
  .skip(20)
  .take(10)
  .getManyAndCount();
```

## 대량 데이터 Streaming

### 왜 필요한가요

200만 명의 사용자에게 환영 이메일을 보내야 한다고 상상해봐요. `em.find(User)`를 실행하면 200만 행을 한꺼번에 메모리에 올려요. Node.js 프로세스가 메모리 부족으로 죽어요.

`stream()`은 작은 배치(예: 500개씩)로 나눠 가져오고 하나씩 yield 해요. 전체 행 수에 상관없이 메모리 사용량이 일정해요.

### 내부 동작

ORM은 내부적으로 LIMIT/OFFSET 배칭을 사용해요. batch size가 500이면 SQL은 이렇게 생겨요:

```sql
-- Batch 1
SELECT "id", "name", "email" FROM "user" WHERE "isActive" = $1 LIMIT 500 OFFSET 0

-- Batch 2
SELECT "id", "name", "email" FROM "user" WHERE "isActive" = $1 LIMIT 500 OFFSET 500

-- Batch 3
SELECT "id", "name", "email" FROM "user" WHERE "isActive" = $1 LIMIT 500 OFFSET 1000

-- ...continues until a batch returns fewer than 500 rows
```

배치를 가져오고, 엔티티를 하나씩 yield 한 뒤, 다음 배치를 가져오기 전에 버려요. 메모리 사용량은 전체 행 수가 아니라 batch size에 비례해요.

### 사용법

```typescript
// Process users one at a time (fetched in batches of 500 internally)
for await (const user of em.stream(User, { where: { isActive: true } }, 500)) {
  await sendWelcomeEmail(user.email);
}
```

ETL 파이프라인, 데이터 내보내기, 일괄 알림 등 대량 데이터를 다루는 작업에 `stream()`을 사용하세요. API 엔드포인트에서는 `find()` + 페이지네이션을 쓰는 게 좋아요.

`stream()`은 모든 `FindOption` 속성을 지원해요 -- `where`, `orderBy`, `relations`, `select` 등.

```typescript
// Stream posts with their authors, ordered by date
for await (const post of em.stream(Post, {
  relations: ["author"],
  orderBy: { createdAt: "DESC" },
}, 1000)) {
  await index(post);
}
```

> **Hint** `stream()`은 내부적으로 LIMIT/OFFSET 배칭을 사용해요. 변경이 잦은 대형 테이블에서 일관된 결과를 얻으려면 `REPEATABLE READ` isolation으로 트랜잭션을 감싸세요.

자세한 내용과 세 가지 데이터 접근 전략 비교는 [Pagination & Streaming](./pagination.md)을 참고하세요.

## Type-Safe Query Builder

### 왜 필요한가요

`find()`로 90%의 쿼리는 커버되지만, 복잡한 JOIN, GROUP BY + aggregate, pessimistic locking, DISTINCT 같은 게 필요할 때가 있어요. raw SQL을 쓰면 타입 안전성을 잃어요. `SelectQueryBuilder`는 SQL의 모든 기능을 컴파일 타임 체크와 함께 제공해요.

### 사용법

```typescript
const [activeUsers, total] = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name", "email"])
  .where("isActive", true)
  .andWhere("age", ">=", 18)
  .orderBy({ createdAt: "DESC" })
  .skip(20)
  .take(10)
  .getManyAndCount();
```

모든 컬럼 참조(`"id"`, `"name"`, `"isActive"`)는 `keyof T`로 검증돼요 -- IDE가 자동완성해주고, 오타는 컴파일 에러가 돼요.

UNION, CTE, window function 같은 더 고급 SQL은 `RawQueryBuilder`를 사용하세요. 두 빌더의 전체 가이드는 [Query Builder](./query-builder.md)를, UNION, CTE, window function 예제는 [Raw SQL & CTE](./raw-sql.md)를 참고하세요.

## Deadlock Retry

### 왜 필요한가요

Deadlock은 두 트랜잭션이 서로가 가진 락을 기다리는 상태예요. 둘 다 진행할 수 없으니 데이터베이스가 하나를 골라서 종료해요.

구체적인 시나리오를 봐요. 트랜잭션 A가 계좌 1에서 계좌 2로 이체해요(계좌 1을 먼저 잠그고, 계좌 2를 잠그려 해요). 동시에 트랜잭션 B가 계좌 2에서 계좌 1로 이체해요(계좌 2를 먼저 잠그고, 계좌 1을 잠그려 해요). 둘 다 서로를 기다리며 멈춰요. 데이터베이스가 이 순환 의존성을 감지하고 하나를 deadlock 에러로 종료해요.

고 동시성 시스템에서 deadlock은 버그가 아니라 자연스러운 현상이에요. 표준 해결책은 실패한 트랜잭션을 재시도하는 거예요.

### 사용법

```typescript
await em.transaction(async (txEm) => {
  const account = await txEm.findOne(Account, { where: { id: fromId } });
  account.balance -= amount;
  await txEm.save(Account, account);
}, {
  retryOnDeadlock: true,
  maxRetries: 3,
  retryDelayMs: 100,
});
```

Deadlock이 감지되면 트랜잭션이 롤백되고 콜백이 처음부터 다시 실행돼요. 콜백은 **멱등(idempotent)**이어야 해요 -- 여러 번 실행해도 같은 결과를 내야 해요. 전체 가이드는 [Transactions](./transactions.md)를 참고하세요.

## 운영 기능

Read Replica, Connection Pooling, Connection Retry, Query Timeout, Shutdown Handling은 [Configuration Guide](./configuration.md)에서 다뤄요. 프로덕션 튜닝은 [Production Guide](./production-guide.md)를 참고하세요.

## 다음 단계

- [Query Builder](./query-builder.md) -- Type-safe SelectQueryBuilder
- [Raw SQL & CTE](./raw-sql.md) -- UNION, CTE, window functions
- [Events & Subscribers](./events.md) -- 이벤트 시스템 상세 가이드
- [Logging & Diagnostics](./logging.md) -- N+1 감지, 슬로우 쿼리, EXPLAIN
- [Plugins](./plugins.md) -- 플러그인 시스템과 커스텀 플러그인 작성
- [Multi-Tenancy](./multi-tenancy.md) -- 테넌트별 데이터 격리
- [API Reference](./api-reference.md) -- 메서드 시그니처 빠른 참조
