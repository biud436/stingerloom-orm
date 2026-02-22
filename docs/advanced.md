# 고급 기능 (Advanced)

---

## 1. 쿼리 캐싱

`find()` / `findOne()` 호출 시 `cache` 옵션을 사용하면 결과를 인메모리에 캐싱합니다. 동일한 조건으로 다시 조회하면 DB 쿼리 없이 캐시 결과를 반환합니다.

**캐시 옵션**

| 값 | 설명 |
|----|------|
| `true` | 기본 TTL(30초)로 캐시 |
| `number` | 지정한 TTL(밀리초)로 캐시 |
| `false` 또는 생략 | 캐시 비활성화 |

```typescript
// 기본 TTL(30초) 캐시
const users = await em.find(User, {
  where: { isActive: true },
  cache: true,
});

// 60초 TTL 캐시
const posts = await em.find(Post, {
  orderBy: { createdAt: "DESC" },
  take: 10,
  cache: 60000,
});
```

**캐시 무효화**

`save()`, `delete()`, `softDelete()`, `insertMany()` 등의 쓰기 연산은 해당 엔티티의 캐시를 자동으로 무효화합니다.

수동으로 캐시를 무효화할 수도 있습니다.

```typescript
// 특정 엔티티 캐시 무효화
em.clearCache(User);

// 전체 캐시 무효화 (인자 없음)
em.clearCache();
```

---

## 2. 이벤트 시스템

엔티티 생명주기 이벤트를 구독하여 사이드 이펙트를 처리할 수 있습니다.

**EventType 목록**

| 이벤트 | 발생 시점 |
|--------|----------|
| `"beforeInsert"` | INSERT 직전 |
| `"afterInsert"` | INSERT 직후 |
| `"beforeUpdate"` | UPDATE 직전 |
| `"afterUpdate"` | UPDATE 직후 |
| `"beforeDelete"` | DELETE 직전 |
| `"afterDelete"` | DELETE 직후 |

```typescript
// 이벤트 리스너 등록
const onAfterInsert = ({ entity, data }) => {
  console.log(`[${entity.name}] 새 레코드 삽입:`, data);
};

em.on("afterInsert", onAfterInsert);

// 이벤트 리스너 제거
em.off("afterInsert", onAfterInsert);

// 전체 리스너 제거
em.removeAllListeners();
```

**이벤트 핸들러 시그니처**

```typescript
// Insert / Update 이벤트
type EntityEventListener = (event: {
  entity: Function; // 엔티티 클래스
  data: any;        // 저장/수정된 데이터
}) => void | Promise<void>;

// Delete 이벤트
// entity: 엔티티 클래스, data: criteria(WHERE 조건)
```

---

## 3. EntitySubscriber

`EntitySubscriber` 인터페이스를 구현하면 특정 엔티티 이벤트에만 반응하는 구독자를 만들 수 있습니다. `on()`과 달리 엔티티 클래스별로 필터링됩니다.

**EntitySubscriber 인터페이스**

```typescript
interface EntitySubscriber<T = any> {
  listenTo(): new (...args: any[]) => T; // 구독할 엔티티 클래스

  afterLoad?(entity: T): void | Promise<void>;

  beforeInsert?(event: InsertEvent<T>): void | Promise<void>;
  afterInsert?(event: InsertEvent<T>): void | Promise<void>;

  beforeUpdate?(event: UpdateEvent<T>): void | Promise<void>;
  afterUpdate?(event: UpdateEvent<T>): void | Promise<void>;

  beforeDelete?(event: DeleteEvent<T>): void | Promise<void>;
  afterDelete?(event: DeleteEvent<T>): void | Promise<void>;

  beforeTransactionStart?(): void | Promise<void>;
  afterTransactionStart?(): void | Promise<void>;

  beforeTransactionCommit?(): void | Promise<void>;
  afterTransactionCommit?(): void | Promise<void>;

  beforeTransactionRollback?(): void | Promise<void>;
  afterTransactionRollback?(): void | Promise<void>;
}

interface InsertEvent<T> {
  entity: Partial<T>;  // 삽입된 데이터
  manager: EntityManager;
}

interface UpdateEvent<T> {
  entity: Partial<T>;  // 수정된 데이터
  manager: EntityManager;
}

interface DeleteEvent<T> {
  entityClass: new (...args: any[]) => T;
  criteria: any;       // WHERE 조건
  manager: EntityManager;
}
```

**구현 예제**

```typescript
import {
  EntitySubscriber,
  InsertEvent,
  UpdateEvent,
  DeleteEvent,
} from "stingerloom-orm";
import { User } from "./user.entity";

class UserAuditSubscriber implements EntitySubscriber<User> {
  listenTo() {
    return User;
  }

  async beforeInsert(event: InsertEvent<User>) {
    console.log("User 삽입 예정:", event.entity);
  }

  async afterInsert(event: InsertEvent<User>) {
    console.log("User 삽입 완료:", event.entity);
    // 감사 로그 기록, 이메일 발송 등
  }

  async beforeUpdate(event: UpdateEvent<User>) {
    console.log("User 수정 예정:", event.entity);
  }

  async afterUpdate(event: UpdateEvent<User>) {
    console.log("User 수정 완료:", event.entity);
  }

  async beforeDelete(event: DeleteEvent<User>) {
    console.log("User 삭제 예정, 조건:", event.criteria);
  }

  async afterDelete(event: DeleteEvent<User>) {
    console.log("User 삭제 완료, 조건:", event.criteria);
  }
}

// 구독자 등록
em.addSubscriber(new UserAuditSubscriber());

// 구독자 제거
const subscriber = new UserAuditSubscriber();
em.addSubscriber(subscriber);
em.removeSubscriber(subscriber);
```

---

## 4. N+1 감지 및 슬로우 쿼리 경고

**활성화 방법**

```typescript
await em.register({
  // ...
  logging: {
    queries: true,           // 쿼리 SQL 로깅
    slowQueryMs: 500,        // 500ms 이상 쿼리에 경고
    nPlusOne: true,          // N+1 패턴 감지 경고 활성화
  },
});
```

**쿼리 로그 조회**

```typescript
// 쿼리 실행 후
const log = em.getQueryLog();
console.log(log);
// [
//   { entity: "User", sql: "SELECT ...", durationMs: 12 },
//   { entity: "Cat", sql: "SELECT ...", durationMs: 8 },
//   ...
// ]
```

**LoggingOptions 옵션**

| 옵션 | 타입 | 설명 |
|------|------|------|
| `queries` | `boolean` | 쿼리 SQL 로깅 활성화 |
| `slowQueryMs` | `number` | 이 값(ms) 초과 시 슬로우 쿼리 경고 출력 |
| `nPlusOne` | `boolean` | N+1 패턴 감지 경고 활성화 |

---

## 5. 커서 페이지네이션

offset 방식(`LIMIT offset, count`) 대신 커서(마지막 항목의 컬럼 값) 기반으로 페이지네이션합니다. 대용량 데이터셋에서도 일정한 성능을 보장합니다.

**CursorPaginationOption**

| 옵션 | 타입 | 설명 |
|------|------|------|
| `take` | `number` | 페이지 크기 (기본값: 20) |
| `cursor` | `string` | 이전 페이지 마지막 커서 (Base64 인코딩) |
| `orderBy` | `keyof T & string` | 정렬 기준 컬럼 (기본값: PK) |
| `direction` | `"ASC" \| "DESC"` | 정렬 방향 (기본값: `"ASC"`) |
| `where` | `Partial<T>` | 추가 WHERE 조건 |

**CursorPaginationResult**

| 필드 | 타입 | 설명 |
|------|------|------|
| `data` | `T[]` | 현재 페이지 데이터 |
| `hasNextPage` | `boolean` | 다음 페이지 존재 여부 |
| `nextCursor` | `string \| null` | 다음 페이지 커서 (Base64) |
| `count` | `number` | 현재 페이지 항목 수 |

**예제**

```typescript
// 첫 페이지 (cursor 생략)
const page1 = await em.findWithCursor(Post, {
  take: 20,
  orderBy: "id",
  direction: "ASC",
  where: { isPublished: true },
});

console.log(page1.data);         // Post[] (최대 20건)
console.log(page1.hasNextPage);  // true
console.log(page1.nextCursor);   // "eyJ2IjoyMH0=" (Base64 인코딩)
console.log(page1.count);        // 20

// 두 번째 페이지
const page2 = await em.findWithCursor(Post, {
  take: 20,
  cursor: page1.nextCursor!,
  orderBy: "id",
  direction: "ASC",
  where: { isPublished: true },
});

// 세 번째 페이지
if (page2.hasNextPage) {
  const page3 = await em.findWithCursor(Post, {
    take: 20,
    cursor: page2.nextCursor!,
    orderBy: "id",
  });
}
```

**REST API 구현 예제**

```typescript
// GET /posts?take=20&cursor=eyJ2IjoyMH0=
async function getPosts(req: Request, res: Response) {
  const take = parseInt(req.query.take as string) || 20;
  const cursor = req.query.cursor as string | undefined;

  const result = await em.findWithCursor(Post, {
    take,
    cursor,
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

---

## 6. 연결 풀링 (Connection Pooling)

**PoolOptions**

| 옵션 | 타입 | 기본값 | 설명 |
|------|------|--------|------|
| `max` | `number` | `10` | 최대 연결 수 |
| `min` | `number` | `0` | 최소 유휴 연결 수 (PostgreSQL만 지원) |
| `acquireTimeoutMs` | `number` | `30000` | 연결 획득 대기 시간(ms) |
| `idleTimeoutMs` | `number` | `10000` | 유휴 연결 종료 대기 시간(ms) (PostgreSQL만 지원) |

```typescript
await em.register({
  type: "postgres",
  // ...
  pool: {
    max: 20,
    min: 5,
    acquireTimeoutMs: 5000,
    idleTimeoutMs: 30000,
  },
});
```

**DB별 풀 옵션 지원 현황**

| 옵션 | MySQL | PostgreSQL | SQLite |
|------|-------|-----------|--------|
| `max` | connectionLimit | max | 무시 |
| `min` | 미지원 | min | 무시 |
| `acquireTimeoutMs` | 미지원 | connectionTimeoutMillis | 무시 |
| `idleTimeoutMs` | 미지원 | idleTimeoutMillis | 무시 |

SQLite는 파일 기반 단일 연결이므로 풀 설정이 무시됩니다.

---

## 7. 연결 재시도 (Connection Retry)

지수 백오프 방식으로 DB 연결 실패 시 자동으로 재시도합니다.

**RetryOptions**

| 옵션 | 타입 | 기본값 | 설명 |
|------|------|--------|------|
| `maxAttempts` | `number` | `3` | 최대 재시도 횟수 |
| `backoffMs` | `number` | `1000` | 기본 지연 시간(ms) |

실제 지연 시간: `backoffMs * 2^(시도횟수-1)`

- 1차 재시도: 1000ms
- 2차 재시도: 2000ms
- 3차 재시도: 4000ms

```typescript
await em.register({
  type: "mysql",
  // ...
  retry: {
    maxAttempts: 5,
    backoffMs: 500,  // 500ms, 1000ms, 2000ms, 4000ms, 8000ms
  },
});
```

---

## 8. 유효성 검사 (Validation)

`save()` 호출 시 `@NotNull`, `@MinLength`, `@MaxLength`, `@Min`, `@Max` 데코레이터로 정의된 제약을 자동으로 검사합니다. 실패 시 `ValidationError`가 throw됩니다.

```typescript
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  NotNull,
  MinLength,
  MaxLength,
  Min,
  Max,
} from "stingerloom-orm";

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

// 유효하지 않은 데이터
try {
  await em.save(Product, { name: "A", price: -1 });
} catch (e) {
  // e.message: "name must be at least 2 characters long"
  console.error(e.message);
}
```

**유효성 검사 데코레이터 목록**

| 데코레이터 | 적용 대상 | 설명 |
|-----------|---------|------|
| `@NotNull()` | 모든 타입 | null / undefined 허용 안 함 |
| `@MinLength(n)` | string | 최소 길이 n |
| `@MaxLength(n)` | string | 최대 길이 n |
| `@Min(n)` | number | 최솟값 n |
| `@Max(n)` | number | 최댓값 n |

---

## 9. BaseRepository

`BaseRepository`는 엔티티별 CRUD를 캡슐화하는 리포지토리 패턴을 지원합니다. `EntityManager`의 메서드를 엔티티 타입으로 위임합니다.

**사용 가능한 메서드**

| 메서드 | 설명 |
|--------|------|
| `find(option?)` | 목록 조회 |
| `findOne(option)` | 단건 조회 |
| `save(item)` | 저장 (INSERT / UPDATE) |
| `delete(criteria)` | 영구 삭제 |
| `softDelete(criteria)` | Soft Delete |
| `restore(criteria)` | Soft Delete 복원 |
| `insertMany(items)` | 배치 INSERT |
| `saveMany(items)` | 배치 save |
| `deleteMany(ids)` | 배치 삭제 |
| `count(where?)` | 개수 조회 |
| `sum(field, where?)` | 합계 |
| `avg(field, where?)` | 평균 |
| `min(field, where?)` | 최솟값 |
| `max(field, where?)` | 최댓값 |

```typescript
import { BaseRepository } from "stingerloom-orm";

// 직접 인스턴스화
const userRepo = em.getRepository(User);

// 또는 NestJS @InjectRepository
@Injectable()
class UsersService {
  constructor(
    @InjectRepository(User) private readonly userRepo: BaseRepository<User>
  ) {}

  async findAll() {
    return this.userRepo.find();
  }

  async findById(id: number) {
    return this.userRepo.findOne({ where: { id } as any });
  }
}
```
