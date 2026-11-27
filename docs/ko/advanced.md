# 고급 기능 모음

아래 기능은 프로덕션 환경에서 유용합니다. 기본 CRUD와 관계를 익힌 뒤에 필요한 기능만 골라 읽으세요.

## EntitySubscriber: 엔티티별 이벤트 구독

### 필요한 이유

전역 `em.on()` 리스너는 애플리케이션의 모든 엔티티 이벤트를 받습니다. 하지만 실제로 모든 엔티티에 같은 로직을 적용하는 경우는 드뭅니다. `User`가 생성되면 환영 이메일을 보내야 합니다. 반면 `Order`가 생성되면 창고에 알려야 합니다. 이처럼 엔티티마다 필요한 동작이 다릅니다.

`EntitySubscriber`를 쓰면 엔티티 클래스 하나에 한정된 이벤트 핸들러를 작성할 수 있습니다. ORM은 이벤트의 엔티티 타입을 확인하고 일치하는 구독자에게만 이벤트를 전달합니다. 그래서 이벤트 로직이 정돈되고 동작을 예측하기 쉬워집니다.

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

EntitySubscriber가 지원하는 이벤트는 다음과 같습니다.

| Method | 실행 시점 |
|--------|--------|
| `afterLoad(entity)` | DB에서 엔티티를 로드한 후 |
| `beforeInsert(event)` / `afterInsert(event)` | INSERT 전/후 |
| `beforeUpdate(event)` / `afterUpdate(event)` | UPDATE 전/후 |
| `beforeDelete(event)` / `afterDelete(event)` | DELETE 전/후 |
| `beforeTransactionStart()` / `afterTransactionStart()` | 트랜잭션 시작 전/후 |
| `beforeTransactionCommit()` / `afterTransactionCommit()` | COMMIT 전/후 |
| `beforeTransactionRollback()` / `afterTransactionRollback()` | ROLLBACK 전/후 |

## N+1 감지와 느린 쿼리 경고

### 필요한 이유

N+1 문제는 ORM을 쓰는 애플리케이션에서 성능을 떨어뜨리는 가장 흔한 원인 중 하나입니다. 이 문제는 겉으로 드러나지 않습니다. 코드는 깔끔하고 테스트도 통과합니다. 하지만 데이터베이스는 쏟아지는 쿼리에 시달립니다.

다음 상황을 생각해 보겠습니다. 사용자 10명을 조회한 뒤 각 사용자의 게시글에 접근합니다. ORM이 지연 로딩으로 사용자마다 쿼리를 하나씩 실행하면 다음과 같이 됩니다.

```sql
-- The "1" query: fetch all users
SELECT "id", "name" FROM "user"

-- The "N" queries: one per user
SELECT "id", "title", "userId" FROM "post" WHERE "userId" = $1  -- user 1
SELECT "id", "title", "userId" FROM "post" WHERE "userId" = $2  -- user 2
SELECT "id", "title", "userId" FROM "post" WHERE "userId" = $3  -- user 3
-- ...7 more queries...
```

쿼리 1번이면 될 일을 11번 실행합니다. 사용자가 100명이면 101번이 됩니다. 해결책은 JOIN으로 한 번에 조회하는 것입니다.

```sql
-- One query with JOIN: fetch users and their posts together
SELECT "user"."id", "user"."name", "post"."id" AS "posts_id", "post"."title" AS "posts_title"
FROM "user"
LEFT JOIN "post" ON "user"."id" = "post"."userId"
```

Stingerloom은 엔티티별로 쿼리를 추적합니다. 그리고 짧은 윈도 안에 같은 테이블로 쿼리가 반복되면 N+1 패턴으로 감지하고 경고합니다.

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

설정한 뒤에는 쿼리 로그를 확인할 수 있습니다.

```typescript
const log = em.getQueryLog();
// [
//   { entity: "User", sql: "SELECT ...", durationMs: 12 },
//   { entity: "Cat", sql: "SELECT ...", durationMs: 8 },
//   ...
// ]
```

> 힌트: N+1이 감지되면 JOIN 기반 로딩으로 바꾸세요. 관계 데코레이터에 `eager: true`를 설정하거나 `em.find(User, { relations: ["posts"] })`처럼 `relations` 옵션을 넘기면 됩니다.

## 커서 기반 페이지네이션

### 필요한 이유

Offset 페이지네이션(`LIMIT 10 OFFSET 10000`)에는 근본적인 문제가 있습니다. 10,000행을 건너뛰려면 데이터베이스가 먼저 10,000행을 전부 읽고 버려야 합니다. 그래서 뒤쪽 페이지로 갈수록 느려집니다.

SQL로 비교해 보겠습니다. 다음은 Offset 방식으로 500페이지를 조회하는 쿼리입니다.

```sql
-- Offset: the DB reads 10,000 rows, throws away 9,990, returns 10
SELECT * FROM "post" ORDER BY "id" ASC LIMIT 10 OFFSET 9990
```

같은 위치를 Cursor 방식으로 조회하면 다음과 같습니다.

```sql
-- Cursor: the DB jumps directly to id > 9990, reads only 10 rows
SELECT * FROM "post" WHERE "id" > $1 ORDER BY "id" ASC LIMIT 11
-- Parameters: [9990]
```

Cursor 방식은 `WHERE` 절로 인덱스의 정확한 위치로 바로 이동합니다. 그래서 1페이지든 5,000페이지든 성능이 같습니다. 한 행을 더 조회하는 것은 별도의 COUNT 쿼리 없이 다음 페이지가 있는지 확인하기 위해서입니다. `take`가 10일 때 `LIMIT 11`이 되는 것도 이 때문입니다.

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

REST API에서 사용하는 예시입니다.

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

offset, cursor, streaming 전략의 자세한 비교는 [Pagination & Streaming](./pagination.md)을 참고하세요.

## 검증

### 필요한 이유

검증은 서비스 메서드에 흩어 두지 말고 엔티티 수준에서 해야 합니다. `price`가 양수여야 한다면 그 규칙을 `Product` 엔티티에 두어야 합니다. 그래야 어떤 코드 경로로 저장하든 규칙이 적용됩니다.

`save()`를 호출하면 데코레이터로 정의한 제약 조건을 자동으로 검증합니다. 검증에 실패하면 SQL을 실행하기 전에 `ValidationError`를 던집니다. 그래서 잘못된 데이터는 데이터베이스에 닿지 않습니다.

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

## BaseRepository: 리포지토리 패턴

### 필요한 이유

`em.find(User, ...)`, `em.save(User, ...)`, `em.delete(User, ...)`를 반복해서 쓰다 보면 `User` 인자가 항상 같습니다. 리포지토리는 EntityManager를 특정 엔티티에 한 번 바인딩합니다. 그래서 호출할 때마다 엔티티 클래스를 다시 적을 필요가 없습니다. 경계도 분명해집니다. 각 서비스가 모든 일을 하는 EntityManager 대신 자기 리포지토리로 작업하기 때문입니다.

### 사용법

```typescript
const userRepo = em.getRepository(User);

// Use the same API as EntityManager without specifying the entity
const users = await userRepo.find();
const user = await userRepo.findOne({ where: { id: 1 } as any });
await userRepo.save({ name: "John Doe" });
await userRepo.delete({ id: 1 });
```

NestJS에서는 `@InjectRepository()`로 서비스에 주입할 수 있습니다.

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

BaseRepository는 EntityManager의 메서드를 거의 모두 지원합니다: `find`, `findOne`, `findWithCursor`, `findAndCount`, `save`, `delete`, `softDelete`, `restore`, `insertMany`, `insertManyAndReturn`, `saveMany`, `deleteMany`, `count`, `sum`, `avg`, `min`, `max`, `explain`, `upsert`, `stream`, `createQueryBuilder`.

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

## 대량 데이터 스트리밍

### 필요한 이유

데이터베이스에 있는 사용자 200만 명 모두에게 환영 이메일을 보내야 한다고 생각해 보겠습니다. `em.find(User)`를 실행하면 ORM은 200만 행을 한꺼번에 메모리에 올립니다. 결국 Node.js 프로세스는 메모리가 부족해 종료됩니다.

`stream()`은 이 문제를 해결합니다. 행을 500개씩처럼 작은 배치로 나눠 조회하고 하나씩 yield합니다. 그래서 전체 행 수와 관계없이 메모리 사용량이 일정합니다.

### 내부 동작

ORM은 내부에서 LIMIT/OFFSET으로 배치를 나눕니다. 배치 크기가 500이면 SQL은 다음과 같습니다.

```sql
-- Batch 1
SELECT "id", "name", "email" FROM "user" WHERE "isActive" = $1 LIMIT 500 OFFSET 0

-- Batch 2
SELECT "id", "name", "email" FROM "user" WHERE "isActive" = $1 LIMIT 500 OFFSET 500

-- Batch 3
SELECT "id", "name", "email" FROM "user" WHERE "isActive" = $1 LIMIT 500 OFFSET 1000

-- ...continues until a batch returns fewer than 500 rows
```

ORM은 배치를 조회하고 엔티티를 하나씩 yield합니다. 그리고 다음 배치를 조회하기 전에 앞 배치를 버립니다. 그래서 메모리 사용량은 전체 행 수가 아니라 배치 크기에 비례합니다.

### 사용법

```typescript
// Process users one at a time (fetched in batches of 500 internally)
for await (const user of em.stream(User, { where: { isActive: true } }, 500)) {
  await sendWelcomeEmail(user.email);
}
```

ETL 파이프라인, 데이터 내보내기, 일괄 알림처럼 데이터의 많은 부분을 다루는 작업에는 `stream()`을 사용하세요. API 엔드포인트에서는 `find()`와 페이지네이션을 쓰는 편이 좋습니다.

`stream()`은 `where`, `orderBy`, `relations`, `select`를 비롯한 모든 `FindOption` 속성을 지원합니다.

```typescript
// Stream posts with their authors, ordered by date
for await (const post of em.stream(Post, {
  relations: ["author"],
  orderBy: { createdAt: "DESC" },
}, 1000)) {
  await index(post);
}
```

> 힌트: `stream()`은 내부에서 LIMIT/OFFSET으로 배치를 나눕니다. 변경이 잦은 큰 테이블에서 일관된 결과를 얻으려면 `REPEATABLE READ` 격리 수준의 트랜잭션 안에서 스트림을 실행하세요.

자세한 내용과 세 가지 데이터 접근 전략의 비교는 [Pagination & Streaming](./pagination.md)을 참고하세요.

## 타입 안전 쿼리 빌더

### 필요한 이유

쿼리의 90%는 `find()`로 충분합니다. 하지만 복잡한 JOIN, 집계를 쓰는 GROUP BY, 비관적 잠금, DISTINCT가 필요할 때도 있습니다. 이때 raw SQL을 쓰면 타입 안전성을 잃습니다. `SelectQueryBuilder`는 SQL의 모든 기능을 컴파일 타임 검사와 함께 제공합니다.

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

`"id"`, `"name"`, `"isActive"` 같은 컬럼 참조는 모두 `keyof T`로 검증됩니다. 그래서 IDE가 자동 완성을 제공하고 오타는 컴파일 에러가 됩니다.

UNION, CTE, 윈도 함수 같은 더 고급 SQL에는 `RawQueryBuilder`를 사용하세요. 두 빌더의 전체 가이드는 [Query Builder](./query-builder.md)에 있습니다. UNION, CTE, 윈도 함수 예제는 [Raw SQL & CTE](./raw-sql.md)를 참고하세요.

## 데드락 재시도

### 필요한 이유

**데드락**(deadlock)은 두 트랜잭션이 상대가 가진 잠금을 서로 기다리는 상태입니다. 어느 쪽도 진행할 수 없으므로 데이터베이스가 하나를 골라 종료합니다.

구체적인 예를 보겠습니다. 트랜잭션 A는 계좌 1에서 계좌 2로 돈을 이체합니다. 이때 A는 계좌 1을 먼저 잠그고 계좌 2를 잠그려고 합니다. 동시에 트랜잭션 B는 계좌 2에서 계좌 1로 이체합니다. 이때 B는 계좌 2를 먼저 잠그고 계좌 1을 잠그려고 합니다. 트랜잭션 A와 B는 서로를 기다리며 멈춥니다. 데이터베이스는 이 순환 의존성을 감지하고 트랜잭션 하나를 데드락 에러로 종료합니다.

동시성이 높은 시스템에서 데드락은 버그가 아니라 당연히 일어나는 현상입니다. 표준 해결책은 실패한 트랜잭션을 다시 시도하는 것입니다.

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

데드락이 감지되면 트랜잭션이 롤백되고 콜백이 처음부터 다시 실행됩니다. 그래서 콜백은 **멱등**(idempotent)이어야 합니다. 여러 번 실행해도 같은 결과를 내야 한다는 뜻입니다. 전체 가이드는 [Transactions](./transactions.md)를 참고하세요.

## 운영 기능

읽기 레플리카, 연결 풀, 연결 재시도, 쿼리 타임아웃, 종료 처리는 [Configuration Guide](./configuration.md)에 설명되어 있습니다. 프로덕션 수준의 튜닝은 [Production Guide](./production-guide.md)를 참고하세요.

## 확장성

### DriverRegistry: 커스텀 데이터베이스 드라이버

`DriverRegistry`를 쓰면 내장 MySQL, PostgreSQL, SQLite 외의 커스텀 데이터베이스 드라이버를 등록할 수 있습니다. CockroachDB나 Oracle 같은 다른 SQL 데이터베이스를 지원하려 할 때 유용합니다.

```typescript
import { DriverRegistry } from "@stingerloom/orm";

DriverRegistry.register("oracle", {
  createDriver: (connector, dbType, schema?) => new OracleDriver(connector),
  createDataSource: (connector) => new OracleDataSource(connector),
});

// 이제 register()에서 type: "oracle"을 사용할 수 있습니다
await em.register({
  type: "oracle" as any,
  // ...
});
```

| Method | 설명 |
|--------|------|
| `DriverRegistry.register(type, factory)` | 데이터베이스 타입의 드라이버 팩토리 등록 |
| `DriverRegistry.unregister(type)` | 등록된 드라이버 제거 |
| `DriverRegistry.has(type)` | 드라이버 등록 여부 확인 |
| `DriverRegistry.getRegisteredTypes()` | 등록된 모든 데이터베이스 타입 목록 |

내장 드라이버(`mysql`, `mariadb`, `postgres`, `sqlite`)는 자동으로 등록됩니다.

### ColumnTypeRegistry: 커스텀 컬럼 타입

`ColumnTypeRegistry`를 쓰면 다이얼렉트별 SQL 매핑과 선택적 트랜스포머를 가진 커스텀 컬럼 타입을 정의할 수 있습니다.

```typescript
import { ColumnTypeRegistry } from "@stingerloom/orm";

const registry = ColumnTypeRegistry.getInstance();

registry.register("money", {
  mysql: "DECIMAL(19,4)",
  postgres: "MONEY",
  sqlite: "REAL",
  transformer: {
    to: (value: number) => value,
    from: (raw: string) => parseFloat(raw.replace(/[$,]/g, "")),
  },
});
```

커스텀 타입은 `@Column`에서 사용합니다.

```typescript
@Column({ type: "money" as any })
price!: number;
```

레지스트리는 타입을 각 다이얼렉트에 맞는 SQL 타입으로 변환합니다. 정의에 없는 다이얼렉트에서는 타입 이름을 적힌 그대로 선언합니다. 트랜스포머는 JavaScript 값과 데이터베이스 값 사이의 변환을 처리합니다.

내장 타입도 아니고 등록되지도 않은 타입은 DDL에 그대로 들어가지 않습니다. 대신 스키마를 동기화하거나 생성할 때 `Unknown column type "varchr". Did you mean "varchar"?` 에러로 거부됩니다. ORM의 목록에 없는 데이터베이스 고유 타입을 쓰려면 먼저 등록하세요.

| Method | 설명 |
|--------|------|
| `registry.register(name, definition)` | 커스텀 컬럼 타입 등록 |
| `registry.resolve(name, dialect)` | 특정 다이얼렉트의 SQL 타입 조회 |
| `registry.getTransformer(name)` | 커스텀 타입의 트랜스포머 조회 |
| `registry.getRegisteredNames()` | 등록된 모든 커스텀 타입 목록 |

`em.registerColumnType(name, definition)`은 `ColumnTypeRegistry.getInstance().register(name, definition)`의 단축형입니다. 레지스트리는 프로세스 전체에서 하나입니다. 그래서 EntityManager 하나로 등록한 타입을 같은 프로세스의 모든 EntityManager에서 쓸 수 있습니다. 커스텀 타입은 `em.register()`가 스키마를 동기화하기 전에 등록하세요.

### DialectExpression: 다이얼렉트 인식 SQL

`DialectExpression`은 데이터베이스마다 다른 SQL 표현식을 생성하는 전략 패턴을 제공합니다.

```typescript
import { createDialectExpression } from "@stingerloom/orm";

const expr = createDialectExpression("postgres");

// 대소문자 무시 LIKE
const ilike = expr.ilike('"name"', "alice");
// PostgreSQL: "name" ILIKE $1  (네이티브 ILIKE)
// MySQL:      "name" LIKE ?    (기본적으로 대소문자 무시)

// 전문 검색
const fts = expr.fullTextSearch('"content"', "typescript orm");
// PostgreSQL: to_tsvector('english', "content") @@ plainto_tsquery('english', $1)
// MySQL:      MATCH("content") AGAINST(? IN BOOLEAN MODE)
```

주로 여러 데이터베이스에서 동작해야 하는 플러그인이나 커스텀 쿼리 빌더를 만들 때 유용합니다.

### 테스트 유틸리티

Stingerloom은 실제 데이터베이스 연결 없이도 유닛 테스트를 쉽게 작성하도록 테스트 헬퍼를 제공합니다.

#### createTestEntityManager

테스트용으로 설정을 모두 마친 EntityManager를 생성합니다. 기본값은 인메모리 SQLite이므로 외부 데이터베이스가 필요 없습니다.

```typescript
import { createTestEntityManager } from "@stingerloom/orm/testing";

const em = await createTestEntityManager({
  entities: [User, Post],
  // type: "sqlite" (기본값), "mysql", 또는 "postgres"
  // synchronize: true (기본값)
});

// 테스트에서는 em을 평소처럼 사용합니다
const user = await em.save(User, { name: "Test" });
```

#### createMockRepository

메서드를 오버라이드할 수 있는 mock `BaseRepository`를 생성합니다. mock하지 않은 메서드는 호출하면 에러를 던집니다. 그래서 의도하지 않은 호출을 쉽게 잡아낼 수 있습니다.

```typescript
import { createMockRepository } from "@stingerloom/orm/testing";

const mockRepo = createMockRepository(User, {
  find: async () => [{ id: 1, name: "Alice" } as User],
  findOne: async () => ({ id: 1, name: "Alice" } as User),
});

const users = await mockRepo.find(); // mock 데이터 반환
await mockRepo.delete({ id: 1 });    // 에러를 던집니다: mock하지 않은 메서드
```

#### InMemoryDriver

데이터베이스가 전혀 필요 없는 순수 유닛 테스트용 최소 인메모리 드라이버입니다.

```typescript
import { InMemoryDriver } from "@stingerloom/orm/testing";

const driver = new InMemoryDriver();
driver.seedTable("users", [
  { id: 1, name: "Alice" },
  { id: 2, name: "Bob" },
]);

const data = driver.getTableData("users"); // [{ id: 1, name: "Alice" }, ...]
console.log(driver.getExecutedQueries());  // SQL 이력
```

### 커스텀 Deserializer 전략

드라이버가 raw 행을 반환하면 ORM은 **`Deserializer`** 전략으로 그 행을 클래스 인스턴스로 변환합니다. 기본값으로는 `class-transformer`가 설치되어 있으면 `ClassTransformerDeserializer`를 씁니다. 설치되어 있지 않으면 의존성이 없는 `PlainObjectDeserializer`로 넘어갑니다. typia나 superstruct 같은 다른 검증 라이브러리를 쓰려 할 때나 핫 패스에서 데코레이터를 아예 건너뛰고 싶을 때 전략을 바꾸세요.

```typescript
import {
  DeserializerRegistry,
  type Deserializer,
} from "@stingerloom/orm";

// 1. 인터페이스 구현
const fastAssignDeserializer: Deserializer = {
  deserialize(cls, plain) {
    if (Array.isArray(plain)) {
      return plain.map((p) => Object.assign(new cls(), p)) as any;
    }
    return Object.assign(new cls(), plain);
  },
};

// 2a. 전역 싱글톤 교체 (프로세스 내 모든 EntityManager에 영향)
DeserializerRegistry.getInstance().setDeserializer(fastAssignDeserializer);

// 2b. 또는 특정 호출 사이트만 바꾸고 싶을 때 스코프 레지스트리 생성
const scoped = new DeserializerRegistry(fastAssignDeserializer);
const user = scoped.deserialize(User, rawRow);
```

`Deserializer` 인터페이스의 메서드는 하나뿐입니다.

```typescript
interface Deserializer {
  deserialize<T, V extends object>(
    cls: MyClassConstructor<T>,
    plain: V | V[],
    options?: DeserializeOptions,
  ): T;
}
```

`DeserializeOptions`는 자주 쓰는 class-transformer 플래그를 그대로 따릅니다. 구현에서는 이 옵션을 무시해도 되고 반영해도 됩니다.

| 옵션 | 용도 |
|---|---|
| `excludeExtraneousValues` | 클래스에 없는 속성을 버림. |
| `groups` | 특정 그룹의 속성만 노출 (class-transformer `@Expose({ groups })`). |
| `version` | class-transformer `@Expose({ since, until })` 버전 게이팅. |
| `enableCircularCheck` | 변환 중 순환 참조 감지. |
| `exposeDefaultValues` | 값이 클래스 기본값뿐인 속성도 출력. |
| `exposeUnsetProperties` | 데코레이터가 없는 속성도 출력 (완전 투명성용). |

**교체하면 좋은 경우:**

- **성능이 중요한 경로**: 단순한 read-only 행에서는 `PlainObjectDeserializer`가 class-transformer보다 3~5배쯤 빠릅니다. `@Type(() => …)` 중첩 변환이 없는 엔티티라면 기본 대체 전략만으로도 충분합니다.
- **다른 검증기(typia, zod, valibot)**: 검증기의 parse 함수를 `deserialize()` 안에서 감싸면 검증과 인스턴스 생성을 한 번에 처리할 수 있습니다.
- **커스텀 필드 마스킹**: class-transformer 데코레이터 없이 그룹 기반 마스킹을 구현합니다. 이때 `options.groups`는 직접 해석합니다.

ORM은 `ResultTransformer`에서 등록된 deserializer를 호출합니다. 그래서 교체한 전략은 모든 `find()`, `findOne()`, 쿼리 빌더의 `getMany()`, 관계 로드에 바로 적용됩니다.

## 다음 단계

- [Query Builder](./query-builder.md): Type-safe SelectQueryBuilder
- [Raw SQL & CTE](./raw-sql.md): UNION, CTE, 윈도 함수
- [Events & Subscribers](./events.md): 이벤트 시스템 상세 가이드
- [Logging & Diagnostics](./logging.md): N+1 감지, 느린 쿼리, EXPLAIN
- [Plugins](./plugins.md): 플러그인 시스템과 커스텀 플러그인 작성
- [Multi-Tenancy](./multi-tenancy.md): 테넌트별 데이터 격리
- [API Reference](./api-reference.md): 메서드 시그니처 빠른 참조
