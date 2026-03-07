# 고급 기능 (Advanced)

이 문서에서는 프로덕션 환경에서 유용한 고급 기능을 다룹니다. 기본 CRUD와 관계를 익힌 후에 필요한 기능을 골라 읽으세요.

## EntitySubscriber — 엔티티별 이벤트 구독

`em.on()`은 모든 엔티티의 이벤트를 수신하지만, `EntitySubscriber`를 사용하면 특정 엔티티에 대한 이벤트만 받을 수 있습니다.

예를 들어, User가 생성/수정/삭제될 때마다 감사 로그를 기록하려면:

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
    return User; // 이 엔티티의 이벤트만 수신
  }

  async afterInsert(event: InsertEvent<User>) {
    console.log("User 생성:", event.entity);
  }

  async afterUpdate(event: UpdateEvent<User>) {
    console.log("User 수정:", event.entity);
  }

  async afterDelete(event: DeleteEvent<User>) {
    console.log("User 삭제, 조건:", event.criteria);
  }
}
```

```typescript
// 등록
em.addSubscriber(new UserAuditSubscriber());

// 해제
em.removeSubscriber(subscriber);
```

EntitySubscriber가 지원하는 이벤트 목록입니다.

| 메서드 | 시점 |
|--------|------|
| `afterLoad(entity)` | DB에서 엔티티 로드 후 |
| `beforeInsert(event)` / `afterInsert(event)` | INSERT 전/후 |
| `beforeUpdate(event)` / `afterUpdate(event)` | UPDATE 전/후 |
| `beforeDelete(event)` / `afterDelete(event)` | DELETE 전/후 |
| `beforeTransactionStart()` / `afterTransactionStart()` | 트랜잭션 시작 전/후 |
| `beforeTransactionCommit()` / `afterTransactionCommit()` | COMMIT 전/후 |
| `beforeTransactionRollback()` / `afterTransactionRollback()` | ROLLBACK 전/후 |

## N+1 감지와 슬로우 쿼리 경고

**N+1 문제**는 목록을 조회한 후 각 항목의 관계를 개별 쿼리로 가져오는 패턴입니다. 10개 항목이면 1 + 10 = 11번의 쿼리가 실행됩니다. Stingerloom은 이 패턴을 자동으로 감지하여 경고합니다.

```typescript
await em.register({
  type: "postgres",
  // ...
  logging: {
    slowQueryMs: 500,  // 500ms 이상 걸리는 쿼리에 경고
    nPlusOne: true,    // N+1 패턴 감지
  },
});
```

설정 후 쿼리 로그를 확인할 수 있습니다.

```typescript
const log = em.getQueryLog();
// [
//   { entity: "User", sql: "SELECT ...", durationMs: 12 },
//   { entity: "Cat", sql: "SELECT ...", durationMs: 8 },
//   ...
// ]
```

> **Hint** N+1이 감지되면 `eager: true` 또는 `relations` 옵션으로 JOIN 기반 로딩으로 전환하세요.

## 커서 기반 페이지네이션

offset 방식(`LIMIT 10 OFFSET 10000`)은 데이터가 많아질수록 느려집니다. 커서 방식은 마지막 항목의 위치를 기억하여 항상 일정한 성능을 보장합니다.

```typescript
// 첫 페이지
const page1 = await em.findWithCursor(Post, {
  take: 20,
  orderBy: "id",
  direction: "ASC",
  where: { isPublished: true },
});

// 두 번째 페이지 — nextCursor를 전달
const page2 = await em.findWithCursor(Post, {
  take: 20,
  cursor: page1.nextCursor!,
  orderBy: "id",
  direction: "ASC",
  where: { isPublished: true },
});

console.log(page2.data);        // Post[]
console.log(page2.hasNextPage); // true/false
console.log(page2.nextCursor);  // 다음 페이지용 커서
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

## 유효성 검사

`save()` 호출 시 데코레이터로 정의한 제약 조건을 자동으로 검사합니다. 검사에 실패하면 `ValidationError`가 발생합니다.

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

| 데코레이터 | 대상 | 설명 |
|-----------|------|------|
| `@NotNull()` | 모든 타입 | null/undefined 불허 |
| `@MinLength(n)` | string | 최소 길이 |
| `@MaxLength(n)` | string | 최대 길이 |
| `@Min(n)` | number | 최솟값 |
| `@Max(n)` | number | 최댓값 |

## BaseRepository — 리포지토리 패턴

`BaseRepository`는 EntityManager의 메서드를 특정 엔티티에 바인딩한 래퍼입니다.

```typescript
const userRepo = em.getRepository(User);

// EntityManager와 동일한 API를 엔티티 지정 없이 사용
const users = await userRepo.find();
const user = await userRepo.findOne({ where: { id: 1 } as any });
await userRepo.save({ name: "홍길동" });
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

BaseRepository는 EntityManager의 거의 모든 메서드를 지원합니다: `find`, `findOne`, `findWithCursor`, `findAndCount`, `save`, `delete`, `softDelete`, `restore`, `insertMany`, `saveMany`, `deleteMany`, `count`, `sum`, `avg`, `min`, `max`, `explain`, `upsert`.

## Read Replica — 읽기/쓰기 분리

`replication` 옵션으로 쓰기는 master로, 읽기는 slave로 자동 라우팅됩니다.

```typescript
await em.register({
  type: "mysql",
  host: "master.example.com",
  port: 3306,
  username: "root",
  password: "password",
  database: "mydb",
  entities: [User, Post],
  synchronize: true,
  replication: {
    master: {
      host: "master.example.com",
      port: 3306,
      username: "root",
      password: "password",
      database: "mydb",
    },
    slaves: [
      {
        host: "replica1.example.com",
        port: 3306,
        username: "readonly",
        password: "password",
        database: "mydb",
      },
      {
        host: "replica2.example.com",
        port: 3306,
        username: "readonly",
        password: "password",
        database: "mydb",
      },
    ],
  },
});
```

- **쓰기 쿼리** (`save`, `delete`, `upsert` 등) → 항상 master
- **읽기 쿼리** (`find`, `findOne`, `count` 등) → slave 라운드 로빈
- **slave 장애** → master로 자동 fallback

쓰기 직후 최신 데이터를 읽어야 할 때는 `useMaster` 옵션을 사용합니다.

```typescript
await em.save(User, { id: 1, name: "수정됨" });

// replica lag 없이 master에서 직접 읽기
const user = await em.findOne(User, {
  where: { id: 1 },
  useMaster: true,
});
```

## 연결 풀링

```typescript
await em.register({
  type: "postgres",
  // ...
  pool: {
    max: 20,              // 최대 연결 수
    min: 5,               // 최소 유휴 연결 수 (PostgreSQL만)
    acquireTimeoutMs: 5000, // 연결 획득 대기 시간
    idleTimeoutMs: 30000,  // 유휴 연결 종료 시간 (PostgreSQL만)
  },
});
```

> **Hint** SQLite는 파일 기반 단일 연결이므로 풀 설정이 무시됩니다.

## 연결 재시도

DB 연결 실패 시 지수 백오프 방식으로 자동 재시도합니다.

```typescript
await em.register({
  type: "mysql",
  // ...
  retry: {
    maxAttempts: 5,   // 최대 재시도 횟수
    backoffMs: 500,   // 기본 지연: 500ms → 1s → 2s → 4s → 8s
  },
});
```

## 쿼리 타임아웃

```typescript
// 모든 쿼리에 5초 타임아웃
await em.register({
  type: "mysql",
  // ...
  queryTimeout: 5000,
});

// 특정 쿼리에만 2초 타임아웃 (전역 설정보다 우선)
const users = await em.find(User, {
  where: { isActive: true },
  timeout: 2000,
});
```

타임아웃 초과 시 `QueryTimeoutError`가 발생합니다.

## 종료 처리 — propagateShutdown()

애플리케이션 종료 시 EntityManager의 내부 리소스를 정리합니다. 이벤트 리스너, 구독자, 쿼리 트래커, 복제 라우터를 모두 초기화합니다.

```typescript
await em.propagateShutdown();
```

NestJS에서는 `OnModuleDestroy` 훅에서 호출하세요.

```typescript
@Injectable()
export class AppService implements OnModuleDestroy {
  constructor(private readonly em: EntityManager) {}

  async onModuleDestroy() {
    await this.em.propagateShutdown();
  }
}
```

## 다음 단계

- [설정 가이드](./configuration.md) — 모든 옵션을 한눈에 보기
- [멀티테넌시](./multi-tenancy.md) — 테넌트별 데이터 격리
- [API 레퍼런스](./api-reference.md) — 메서드 시그니처 빠르게 확인
