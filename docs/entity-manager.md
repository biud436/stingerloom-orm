# EntityManager API

`EntityManager`는 ORM의 핵심 진입점입니다. 모든 CRUD 연산, 집계, Raw Query, 이벤트 구독, 캐시 관리 등을 담당합니다.

```typescript
import { EntityManager } from "stingerloom-orm";

const em = new EntityManager();
```

---

## register(options)

DB 연결과 엔티티 등록을 한 번에 수행합니다. `synchronize: true`이면 테이블이 없을 경우 자동 생성됩니다.

```typescript
await em.register({
  type: "mysql",
  host: "localhost",
  port: 3306,
  username: "root",
  password: "password",
  database: "mydb",
  entities: [User, Post, Comment],
  synchronize: true,
});
```

**DatabaseClientOptions 전체 옵션**

| 옵션 | 타입 | 설명 |
|------|------|------|
| `type` | `"mysql" \| "mariadb" \| "postgres" \| "sqlite" \| "mssql"` | DB 종류 |
| `host` | `string` | 호스트 주소 |
| `port` | `number` | 포트 번호 |
| `username` | `string` | DB 사용자명 |
| `password` | `string` | DB 비밀번호 |
| `database` | `string` | DB명 (SQLite: 파일 경로) |
| `entities` | `AnyEntity[]` | 등록할 엔티티 클래스 배열 |
| `synchronize` | `boolean` | 테이블 자동 생성 여부 |
| `schema` | `string` | PostgreSQL 스키마명 (기본값: `"public"`) |
| `charset` | `string` | MySQL 문자셋 |
| `datesStrings` | `boolean` | MySQL 날짜를 문자열로 반환 |
| `pool` | `PoolOptions` | 연결 풀 설정 |
| `retry` | `RetryOptions` | 연결 재시도 설정 |
| `logging` | `boolean \| LoggingOptions` | 쿼리 로깅 설정 |

---

## find(entity, option?)

조건에 맞는 엔티티 목록을 조회합니다.

```typescript
async find<T>(entity: ClazzType<T>, findOption?: FindOption<T>): Promise<EntityResult<T>>
```

**예제**

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

// LIMIT + OFFSET (offset 방식 페이지네이션)
const page2 = await em.find(Post, {
  limit: [10, 10], // LIMIT 10, 10 (MySQL) / LIMIT 10 OFFSET 10 (PostgreSQL)
});

// 특정 컬럼만 SELECT
const names = await em.find(User, {
  select: ["id", "name"],
});
// 또는 객체 형태
const names2 = await em.find(User, {
  select: { id: true, name: true },
});

// 관계 엔티티 로드
const owners = await em.find(Owner, {
  relations: ["cats"],
});

// soft-deleted 포함 조회
const all = await em.find(Post, {
  withDeleted: true,
});

// 캐시 사용
const cached = await em.find(User, {
  cache: true,        // 기본 TTL(30초) 캐시
  // cache: 60000,   // 60초 TTL
});
```

**FindOption 전체 옵션**

| 옵션 | 타입 | 설명 |
|------|------|------|
| `where` | `Partial<T>` | WHERE 조건 |
| `select` | `(keyof T)[] \| Partial<Record<keyof T, boolean>>` | SELECT 컬럼 |
| `orderBy` | `Partial<Record<keyof T, "ASC" \| "DESC">>` | ORDER BY |
| `limit` | `number \| [number, number]` | LIMIT (단일 숫자 또는 [offset, count]) |
| `take` | `number` | 가져올 행 수 |
| `relations` | `(keyof T)[]` | 로드할 관계 프로퍼티명 배열 |
| `withDeleted` | `boolean` | soft-deleted 엔티티 포함 여부 |
| `cache` | `boolean \| number` | 캐시 활성화 (true: 기본 TTL, number: ms 단위 TTL) |
| `groupBy` | `(keyof T)[]` | GROUP BY |

---

## findOne(entity, option)

조건에 맞는 단건 엔티티를 조회합니다. 내부적으로 `find()`에 `limit: 1`을 추가합니다.

```typescript
async findOne<T>(entity: ClazzType<T>, findOption: FindOption<T>): Promise<EntityResult<T>>
```

**예제**

```typescript
const user = await em.findOne(User, { where: { id: 1 } });

const post = await em.findOne(Post, {
  where: { slug: "hello-world" },
  relations: ["author", "tags"],
});
```

---

## save(entity, data)

엔티티를 저장합니다. PK(auto-increment)가 없으면 INSERT, 있으면 UPDATE를 수행합니다. 저장된 엔티티를 반환합니다.

```typescript
async save<T>(entity: ClazzType<T>, item: Partial<T>): Promise<InstanceType<ClazzType<T>>>
```

**예제**

```typescript
// INSERT
const user = await em.save(User, {
  name: "홍길동",
  email: "hong@example.com",
});
console.log(user.id); // 자동 생성된 PK

// UPDATE
const updated = await em.save(User, {
  id: user.id,
  name: "홍길동(수정)",
  email: user.email,
});
```

---

## delete(entity, criteria)

조건에 맞는 엔티티를 영구 삭제합니다. 빈 조건은 차단됩니다.

```typescript
async delete<T>(entity: ClazzType<T>, criteria: Partial<T>): Promise<DeleteResult>

interface DeleteResult {
  affected: number; // 삭제된 행 수
}
```

**예제**

```typescript
const result = await em.delete(User, { id: 1 });
console.log(result.affected); // 1

// 조건 필수 — 빈 조건은 DeleteWithoutConditionsError 발생
// await em.delete(User, {}); // 오류!
```

---

## softDelete(entity, criteria)

`@DeletedAt` 컬럼이 있는 엔티티에 대해 Soft Delete를 수행합니다. `deleted_at = NOW()`로 UPDATE합니다.

```typescript
async softDelete<T>(entity: ClazzType<T>, criteria: Partial<T>): Promise<DeleteResult>
```

**예제**

```typescript
const result = await em.softDelete(Post, { id: 1 });
console.log(result.affected); // 1

// 이후 find() 결과에서 자동 제외됨
const posts = await em.find(Post); // deleted_at IS NULL 자동 추가
```

---

## restore(entity, criteria)

soft-deleted 엔티티를 복원합니다. `deleted_at = NULL`로 UPDATE합니다.

```typescript
async restore<T>(entity: ClazzType<T>, criteria: Partial<T>): Promise<DeleteResult>
```

**예제**

```typescript
const result = await em.restore(Post, { id: 1 });
console.log(result.affected); // 1
```

---

## insertMany(entity, items[])

여러 엔티티를 단일 `INSERT INTO ... VALUES (...), (...)` 쿼리로 삽입합니다. 항상 INSERT를 수행합니다 (PK 확인 없음).

```typescript
async insertMany<T>(entity: ClazzType<T>, items: Partial<T>[]): Promise<{ affected: number }>
```

**예제**

```typescript
const result = await em.insertMany(User, [
  { name: "홍길동", email: "hong@example.com" },
  { name: "김철수", email: "kim@example.com" },
  { name: "이영희", email: "lee@example.com" },
]);
console.log(result.affected); // 3
```

---

## saveMany(entity, items[])

여러 엔티티를 순서대로 저장합니다. 각 아이템에 PK가 없으면 INSERT, 있으면 UPDATE를 수행합니다.

```typescript
async saveMany<T>(entity: ClazzType<T>, items: Partial<T>[]): Promise<InstanceType<ClazzType<T>>[]>
```

**예제**

```typescript
const users = await em.saveMany(User, [
  { name: "홍길동", email: "hong@example.com" },
  { id: 2, name: "김철수(수정)", email: "kim@example.com" },
]);
```

---

## deleteMany(entity, ids[])

PK 배열로 여러 엔티티를 단일 `DELETE ... WHERE pk IN (...)` 쿼리로 삭제합니다.

```typescript
async deleteMany<T>(entity: ClazzType<T>, ids: any[]): Promise<DeleteResult>
```

**예제**

```typescript
const result = await em.deleteMany(User, [1, 2, 3]);
console.log(result.affected); // 3
```

---

## count(entity, where?)

조건에 맞는 엔티티 수를 반환합니다.

```typescript
async count<T>(entity: ClazzType<T>, where?: Partial<T>): Promise<number>
```

```typescript
const total = await em.count(User);
const active = await em.count(User, { isActive: true });
```

---

## sum(entity, field, where?)

조건에 맞는 엔티티의 특정 필드 합계를 반환합니다.

```typescript
async sum<T>(entity: ClazzType<T>, field: keyof T & string, where?: Partial<T>): Promise<number>
```

```typescript
const totalAge = await em.sum(User, "age");
const activeAge = await em.sum(User, "age", { isActive: true });
```

---

## avg(entity, field, where?)

조건에 맞는 엔티티의 특정 필드 평균을 반환합니다.

```typescript
async avg<T>(entity: ClazzType<T>, field: keyof T & string, where?: Partial<T>): Promise<number>
```

```typescript
const avgAge = await em.avg(User, "age");
```

---

## min(entity, field, where?)

조건에 맞는 엔티티의 특정 필드 최솟값을 반환합니다.

```typescript
async min<T>(entity: ClazzType<T>, field: keyof T & string, where?: Partial<T>): Promise<number>
```

```typescript
const youngest = await em.min(User, "age");
```

---

## max(entity, field, where?)

조건에 맞는 엔티티의 특정 필드 최댓값을 반환합니다.

```typescript
async max<T>(entity: ClazzType<T>, field: keyof T & string, where?: Partial<T>): Promise<number>
```

```typescript
const oldest = await em.max(User, "age");
```

---

## query(sql, params?)

임의의 Raw SQL 쿼리를 실행하고 결과를 반환합니다.

```typescript
async query<T = Record<string, unknown>>(
  sqlQuery: string | Sql,
  params?: unknown[],
): Promise<T[]>
```

**예제**

```typescript
import sql from "sql-template-tag";

// sql-template-tag 사용 (권장 — SQL Injection 방지)
interface UserRow { id: number; name: string; }
const users = await em.query<UserRow>(
  sql`SELECT * FROM "User" WHERE "id" = ${1}`
);

// 문자열 + 파라미터 배열
const posts = await em.query<{ id: number; title: string }>(
  "SELECT id, title FROM post WHERE author_id = ?",
  [42]
);
```

---

## findWithCursor(entity, option)

커서 기반 페이지네이션으로 엔티티를 조회합니다. offset 방식 대비 대용량 데이터셋에서 일정한 성능을 보장합니다.

```typescript
async findWithCursor<T>(
  entity: ClazzType<T>,
  option?: CursorPaginationOption<T>,
): Promise<CursorPaginationResult<T>>

interface CursorPaginationOption<T> {
  take?: number;       // 페이지 크기 (기본값: 20)
  cursor?: string;     // 이전 페이지 마지막 커서 (Base64 인코딩)
  orderBy?: keyof T & string; // 정렬 컬럼 (기본값: PK)
  direction?: "ASC" | "DESC"; // 정렬 방향 (기본값: "ASC")
  where?: Partial<T>;  // 추가 WHERE 조건
}

interface CursorPaginationResult<T> {
  data: T[];
  hasNextPage: boolean;
  nextCursor: string | null;
  count: number;
}
```

**예제**

```typescript
// 첫 페이지
const page1 = await em.findWithCursor(Post, {
  take: 10,
  orderBy: "id",
  direction: "ASC",
});

console.log(page1.data);        // Post[]
console.log(page1.hasNextPage); // true
console.log(page1.nextCursor);  // "eyJ2IjoxMH0=" (Base64)

// 두 번째 페이지
const page2 = await em.findWithCursor(Post, {
  take: 10,
  cursor: page1.nextCursor!,
  orderBy: "id",
  direction: "ASC",
});
```

---

## clearCache(entity?)

캐시를 무효화합니다.

```typescript
// 특정 엔티티 캐시 무효화
em.clearCache(User);

// 전체 캐시 무효화
em.clearCache();
```

---

## getQueryLog()

현재 세션의 쿼리 실행 로그를 반환합니다. `logging.nPlusOne` 또는 `logging.slowQueryMs`가 설정된 경우에만 동작합니다.

```typescript
getQueryLog(): ReadonlyArray<QueryLogEntry>
```

```typescript
const em = new EntityManager();
await em.register({
  // ...
  logging: { slowQueryMs: 100, nPlusOne: true },
});

// 쿼리 실행 후
const log = em.getQueryLog();
console.log(log);
```

---

## on(event, listener) / off(event, listener)

엔티티 이벤트 리스너를 등록하거나 제거합니다.

```typescript
on(event: EntityEventType, listener: EntityEventListener): void
off(event: EntityEventType, listener: EntityEventListener): void
removeAllListeners(): void
```

**EntityEventType 목록**

| 이벤트 | 설명 |
|--------|------|
| `"beforeInsert"` | INSERT 직전 |
| `"afterInsert"` | INSERT 직후 |
| `"beforeUpdate"` | UPDATE 직전 |
| `"afterUpdate"` | UPDATE 직후 |
| `"beforeDelete"` | DELETE 직전 |
| `"afterDelete"` | DELETE 직후 |

```typescript
em.on("afterInsert", ({ entity, data }) => {
  console.log(`${entity.name} inserted:`, data);
});
```

---

## addSubscriber(subscriber) / removeSubscriber(subscriber)

`EntitySubscriber` 인터페이스를 구현한 구독자를 등록하거나 제거합니다.

```typescript
addSubscriber(subscriber: EntitySubscriber<any>): void
removeSubscriber(subscriber: EntitySubscriber<any>): void
```

**예제**

```typescript
import { EntitySubscriber, InsertEvent } from "stingerloom-orm";

class UserAuditSubscriber implements EntitySubscriber<User> {
  listenTo() {
    return User;
  }

  afterInsert(event: InsertEvent<User>) {
    console.log("User created:", event.entity);
  }
}

em.addSubscriber(new UserAuditSubscriber());
```

자세한 내용은 [advanced.md](./advanced.md#entitysubscriber)를 참조하세요.

---

## 집계 함수 한 번에 조회 예제

```typescript
const [total, avgAge, minAge, maxAge, sumAge] = await Promise.all([
  em.count(User),
  em.avg(User, "age"),
  em.min(User, "age"),
  em.max(User, "age"),
  em.sum(User, "age"),
]);

console.log({ total, avgAge, minAge, maxAge, sumAge });
```
