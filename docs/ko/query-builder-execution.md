# Query Builder — 실행 & 결과

쿼리 모양이 정해진 다음엔 실제 실행과 결과 반환이 남아요. 정렬,
페이지네이션, 비관적 잠금, 인덱스 힌트, soft-delete 처리, 런타임 결과
검증, 실행 메서드 세 단계(`getMany` / `getPartialMany` / `getRawMany`),
그리고 반복 쿼리의 컴파일 — 전부 이 페이지에서 다뤄요.

## ORDER BY와 페이지네이션

정렬과 페이지네이션은 예상하는 대로 동작해요.

```typescript
// 타입 안전 ORDER BY — 컬럼명 자동완성
qb.orderBy({ createdAt: "DESC", name: "ASC" });

// LIMIT / OFFSET
qb.limit(10).offset(20);

// skip / take 별칭 — 같은 효과
qb.skip(20).take(10);
```

데이터와 전체 개수가 둘 다 필요하다면? `getManyAndCount()`가 두 쿼리를 병렬로 실행하고 `[T[], number]`를 반환해요.

```typescript
const [users, total] = await em
  .createQueryBuilder(User, "u")
  .where("isActive", true)
  .orderBy({ createdAt: "DESC" })
  .skip(20)
  .take(10)
  .getManyAndCount();

console.log(users.length); // up to 10
console.log(total);        // e.g. 235
```

> 커서 기반 페이지네이션, 스트리밍, 전략 선택 가이드는
> [페이지네이션 & 스트리밍](./pagination.md)에 있어요.

## Pessimistic Locking

동시성이 높은 상황에서는 다른 트랜잭션이 수정하지 못하도록 읽기 시 행을 잠가야 할 때가 있어요.

```typescript
const user = await em
  .createQueryBuilder(User, "u")
  .where("id", 1)
  .forUpdate()
  .getOne();
// SELECT ... FROM "user" AS "u" WHERE "u"."id" = $1 FOR UPDATE
```

`forUpdate()`는 `FOR UPDATE` — exclusive lock을 추가해요. 트랜잭션이 커밋될 때까지 다른 트랜잭션이 이 행을 읽거나 수정할 수 없어요. `forShare()`는 shared lock을 추가해요 — 다른 트랜잭션이 읽을 순 있지만 쓸 수는 없어요.

| Method | SQL (PostgreSQL / SQLite) | SQL (MySQL) | 효과 |
|--------|--------------------------|-------------|------|
| `forUpdate()` | `FOR UPDATE` | `FOR UPDATE` | Exclusive lock — 읽기/쓰기 모두 차단 |
| `forShare()` | `FOR SHARE` | `LOCK IN SHARE MODE` | Shared lock — 쓰기만 차단 |

**시나리오별 선택 기준**

- **재고 차감, 잔액 갱신 등 "내가 방금 읽은 값을 그대로 갱신"** → `forUpdate()`. 다른 트랜잭션이 이 행을 먼저 읽는 것 자체를 막아요.
- **외래 키 참조 확인만 하고 싶을 때**(내가 쓰진 않지만 남이 지우면 안 됨) → `forShare()`.
- **작업 큐에서 다른 워커가 잡고 있는 행은 건너뛰고 다음 걸 잡고 싶을 때** → `forUpdateSkipLocked()` (아래).
- **"못 잡으면 즉시 에러로 받고 사용자에게 재시도하라 알려주고 싶을 때"** → `forUpdateNowait()`.

### NOWAIT과 SKIP LOCKED

동시성이 높은 시나리오에서 락을 기다리는 건 병목이 될 수 있어요. 두 가지 고급 잠금 옵션으로 행이 이미 잠겨 있을 때의 동작을 제어할 수 있어요.

**NOWAIT** — 락이 해제되길 기다리는 대신 즉시 에러를 던져요.

```typescript
const user = await em
  .createQueryBuilder(User, "u")
  .where("id", 1)
  .forUpdateNowait()
  .getOne();
// SELECT ... FOR UPDATE NOWAIT
// 다른 트랜잭션이 행을 잠그고 있으면 즉시 에러 발생
```

**SKIP LOCKED** — 이미 잠긴 행을 조용히 건너뛰어요. 여러 워커가 같은 테이블에서 작업을 가져가는 잡 큐 패턴에 특히 유용해요.

```typescript
// 워커가 다음 잠기지 않은 작업을 가져감
const job = await em
  .createQueryBuilder(Job, "j")
  .where("status", "pending")
  .orderBy({ createdAt: "ASC" })
  .limit(1)
  .forUpdateSkipLocked()
  .getOne();
// SELECT ... ORDER BY ... LIMIT 1 FOR UPDATE SKIP LOCKED
// 모든 대기 작업이 다른 워커에 의해 잠겨 있으면 null 반환
```

네 가지 조합을 모두 사용할 수 있어요:

| Method | SQL |
|--------|-----|
| `forUpdateNowait()` | `FOR UPDATE NOWAIT` |
| `forUpdateSkipLocked()` | `FOR UPDATE SKIP LOCKED` |
| `forShareNowait()` | `FOR SHARE NOWAIT` |
| `forShareSkipLocked()` | `FOR SHARE SKIP LOCKED` |

::: warning
NOWAIT과 SKIP LOCKED는 MySQL 8.0+ 또는 PostgreSQL 9.5+가 필요해요. SQLite는 비관적 잠금을 지원하지 않고 `UNSUPPORTED_DATABASE` 에러를 던져요.
:::

## Index Hints

MySQL에서는 쿼리 플래너가 사용할 인덱스를 제안할 수 있어요. 플래너가 최적이 아닌 인덱스를 선택할 때 유용해요.

```typescript
const orders = await em
  .createQueryBuilder(Order, "o")
  .where("status", "pending")
  .useIndex("idx_order_status")
  .getMany();
// MySQL: SELECT ... FROM `order` USE INDEX (`idx_order_status`) WHERE ...
```

세 가지 MySQL 인덱스 힌트 타입을 사용할 수 있어요:

| Method | SQL | 효과 |
|--------|-----|------|
| `useIndex(name)` | `USE INDEX (name)` | 플래너에 인덱스 제안 |
| `forceIndex(name)` | `FORCE INDEX (name)` | 플래너가 이 인덱스를 강제로 사용하도록 |
| `ignoreIndex(name)` | `IGNORE INDEX (name)` | 플래너가 이 인덱스를 건너뛰도록 |

PostgreSQL에서는 `hint()` 메서드로 [pg_hint_plan](https://pg-hint-plan.readthedocs.io/) 스타일 힌트를 추가할 수 있어요. 여러 번 호출하면 누적돼서 하나의 `/*+ ... */` 블록으로 합쳐져요.

```typescript
const orders = await em
  .createQueryBuilder(Order, "o")
  .where("status", "pending")
  .hint("IndexScan(o idx_order_status)")
  .hint("Leading(o c)")                       // 추가 힌트는 누적
  .getMany();
// PostgreSQL: /*+ IndexScan(o idx_order_status) Leading(o c) */ SELECT ...
```

::: warning
`hint()`는 **`pg_hint_plan` 확장이 설치·활성화된 PostgreSQL에서만** 실제 효과가 있어요. 확장이 없으면 주석으로 무시되고 플래너는 힌트를 보지 못해요. SQLite는 모든 쿼리 힌트를 지원하지 않아요.
:::

## Soft Delete 처리

엔티티에 `@DeletedAt` 컬럼이 있으면, query builder가 자동으로 soft-deleted 행을 제외해요. 포함하려면:

```typescript
qb.withDeleted();
```

## 결과 검증 — validate()

컴파일 타임 타입 narrowing이 많은 실수를 잡아주지만, 데이터베이스가 실제로 반환하는 값까지는 확인할 수 없어요. 문자열을 기대한 컬럼에 `null`이 올 수도 있고, 드라이버 동작 때문에 숫자가 문자열로 올 수도 있거든요. 런타임 안전성을 위해 **validator**를 붙여서 모든 행을 애플리케이션 코드에 도달하기 전에 체크할 수 있어요.

가장 간단한 형태는 일반 함수예요:

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name"])
  .validate((row) => {
    if (!row.name) throw new Error("name must not be empty");
    return row;
  })
  .getPartialMany();
```

각 행이 validator를 통과해요. 함수가 throw하면 전체 호출이 해당 에러로 reject돼요. 성공하면 결과에 포함돼요. 기본값은 validator 없음 — 오버헤드 제로예요. Validator는 `getPartialMany()`와 `getMany()` 모두에서 동작해요.

Validator 함수로 데이터 **변환**도 할 수 있어요. 반환한 값이 실제 결과가 돼요:

```typescript
.validate((row) => ({
  ...row,
  name: row.name.trim().toLowerCase(),
}))
```

### Zod로 Schema Validation 하기

검증 함수를 직접 작성하는 건 번거로워요. [zod](https://zod.dev)를 쓴다면 스키마를 직접 넘길 수 있어요 — query builder는 `.parse()` 메서드가 있는 객체를 인식해요.

```typescript
import { z } from "zod";

const UserRow = z.object({
  id: z.number(),
  name: z.string().min(1),
});

const users = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name"])
  .validate(UserRow)
  .getPartialMany();
```

행이 zod 스키마를 통과하지 못하면, 어떤 필드가 왜 실패했는지 상세한 `ZodError`가 throw돼요. 문자열을 기대한 곳에 NULL이 오거나, 숫자를 기대한 곳에 문자열이 오는 등의 데이터 문제를 가장 빠른 시점에 잡아줘요.

Zod의 `.transform()`도 사용 가능해요. 검증과 데이터 변환을 한 번에 할 수 있어요:

```typescript
const NormalizedUser = z.object({
  id: z.number(),
  name: z.string().transform((s) => s.toUpperCase()),
  email: z.string().email(),
});

const users = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name", "email"])
  .validate(NormalizedUser)
  .getPartialMany();
// [{ id: 1, name: "ALICE", email: "alice@example.com" }, ...]
```

`.strict()`는 예상치 못한 추가 필드가 있는 행을 거부해요 — schema drift를 감지하는 데 유용해요:

```typescript
const StrictUser = z.object({ id: z.number(), name: z.string() }).strict();

// Throws if the DB returns columns beyond id and name
.validate(StrictUser)
```

`.parse(data)` 메서드를 제공하는 라이브러리라면 뭐든 호환돼요 — zod뿐만 아니라 io-ts, superstruct 등도 가능해요.

### `validate()` vs `selectSchema()` — 뭘 쓸까

두 메서드가 비슷해 보이지만 역할이 달라요.

| | `.validate(schema)` | `.selectSchema(schema)` |
|-|---------------------|-------------------------|
| 런타임 검증 | ✓ | ✓ |
| 데이터 변환 (`transform`) | ✓ | ✓ |
| 반환 타입 narrowing | ✗ — 현재 타입 유지 | ✓ — `z.infer<schema>`로 좁힘 |
| 타입 보장 | 호출자가 선언한 `TResult`를 신뢰 | 스키마가 타입의 **원천** |
| 주 쓰임 | "호출자 타입은 이미 맞는데, 런타임 값만 한번 더 체크" | "스키마에서 타입을 도출해서 SELECT 결과 모양을 확정" |

일반적인 규칙 — **런타임 검증만 필요**하면 `validate()`, **타입 추론까지 스키마에 맡기고 싶으면** `selectSchema()`. 자세한 `selectSchema` 설명과 예제는 [QueryDSL 표현식](./query-builder-querydsl.md) 페이지의 "TS 네이티브 이스케이프 해치" 섹션에 있어요.

### 배열 단위 검증 — validateArray()

개별 행이 아닌 결과 집합 전체를 검증해야 할 때도 있어요. 최대 결과 수를 제한하거나, 배열이 비어있지 않은지 확인하는 경우예요.

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name"])
  .validateArray((rows) => {
    if (rows.length === 0) throw new Error("expected at least one user");
    if (rows.length > 1000) throw new Error("result set too large");
    return rows;
  })
  .getPartialMany();
```

Zod 배열 스키마도 사용할 수 있어요:

```typescript
const UsersArray = z
  .array(z.object({ id: z.number(), name: z.string() }))
  .min(1)
  .max(100);

const users = await qb
  .select(["id", "name"])
  .validateArray(UsersArray)
  .getPartialMany();
```

### 행 검증과 배열 검증 결합하기

같은 쿼리에 `validate()`와 `validateArray()`를 함께 쓸 수 있어요. 행 단위 검증이 먼저 실행되고, 그다음 배열 단위 검증이 실행돼요:

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name"])
  .validate(z.object({             // 1. Each row: validate + transform
    id: z.number(),
    name: z.string().transform((s) => s.trim()),
  }))
  .validateArray((rows) => {       // 2. Whole array: check constraints
    if (rows.length > 100) throw new Error("too many results");
    return rows;
  })
  .getPartialMany();
```

### 언제 검증을 사용할까요

검증은 행마다 함수 호출이 추가되므로 공짜가 아니에요. 효과가 있는 상황은 이래요:

| 상황 | 검증? | 이유 |
|------|-------|------|
| 내부 서비스, 신뢰할 수 있는 스키마 | No | 속도가 더 중요해요 |
| 사용자 데이터를 반환하는 API 엔드포인트 | Yes | null/타입 불일치를 클라이언트에 도달하기 전에 잡아요 |
| 느슨한 소스 데이터를 다루는 ETL 파이프라인 | Yes | 잘못된 데이터 전파를 방지해요 |
| 역직렬화 버그 디버깅 | Yes (일시적으로) | 정확히 어떤 행/필드가 문제인지 특정해요 |

기본값 — validator 없음, 오버헤드 제로 — 이 대부분의 내부 쿼리에 맞는 선택이에요. 데이터가 신뢰 경계를 넘는 곳에서 검증을 추가하세요.

## 쿼리 실행하기

쿼리를 만들었으니 실행해야겠죠. Query builder는 안전성과 타이핑 보장 수준이 다른 세 단계의 실행 메서드를 제공해요.

**Safe — required 컬럼 검증이 있는 클래스 인스턴스:**

| Method | Returns | 설명 |
|--------|---------|------|
| `getMany()` | `T[]` | 클래스 인스턴스. `select()` 사용 시 required 컬럼 검증 |
| `getOne()` | `T \| null` | 단일 클래스 인스턴스 또는 null (자동으로 LIMIT 1 추가) |
| `getOneOrFail()` | `T` | 단일 클래스 인스턴스 (결과 없으면 `EntityNotFoundError` 발생) |
| `getManyAndCount()` | `[T[], number]` | 클래스 인스턴스 + 총 개수를 병렬 실행 |

항상 행을 엔티티 클래스 인스턴스로 역직렬화해요. `instanceof`가 동작하고, 클래스 메서드를 쓸 수 있고, `em.save()`에 전달할 수 있어요. `select()`로 특정 컬럼을 지정하면, non-nullable 컬럼이 포함되어야 해요 — 아니면 `OrmError`가 throw돼요.

**Partial — typed plain object (Pick):**

| Method | Returns | 설명 |
|--------|---------|------|
| `getPartialMany()` | `TResult[]` | `Pick<T, K>` narrowing된 plain object |
| `getPartialOne()` | `TResult \| null` | 단일 plain object 또는 null |
| `getPartialManyAndCount()` | `[TResult[], number]` | Plain object + 총 개수 |

역직렬화 없음, required 컬럼 검증 없음. `select(["id", "name"])` 사용 시 반환 타입이 `Pick<T, "id" | "name">[]`로 좁혀져요 — 선택하지 않은 컬럼에 접근하면 컴파일 에러예요. `em.save()`에 전달하지 마세요.

**Raw — untyped plain object:**

| Method | Returns | 설명 |
|--------|---------|------|
| `getRawMany()` | `Record<string, unknown>[]` | Untyped plain object |
| `getRawOne()` | `Record<string, unknown> \| null` | 단일 untyped object 또는 null |

결과에 엔티티에 없는 computed column이 포함될 때 사용해요 (예: `addSelect(sql`COUNT(*)`, "cnt")`). 타입 정보 없음, 역직렬화 없음.

**Utility (변경 없음):**

| Method | Returns | 설명 |
|--------|---------|------|
| `getCount()` | `number` | 같은 WHERE/JOIN으로 COUNT(*) |
| `exists()` | `boolean` | 매칭되는 행이 있는지 여부 |

**어떤 걸 써야 할까요?** 기본적으로 `getMany()`를 쓰세요. 컴파일 타임 narrowing이 필요한 read-only DTO에는 `getPartialMany()`를 쓰세요. `addSelect`나 computed column이 있는 쿼리에는 `getRawMany()`를 쓰세요.

디버깅할 때는 `getSql()`이 실행 없이 raw SQL과 파라미터를 반환해요.

```typescript
const { text, values } = qb.getSql();
console.log(text);   // SELECT "u"."id", ... WHERE "u"."is_active" = ?
console.log(values);  // [true]
```

> **Hint** `getSql()` 출력의 `?` placeholder는 가독성을 위한 거예요. 실제 쿼리는 드라이버에 맞는 파라미터를 사용해요 (PostgreSQL은 `$1`, `$2`, MySQL은 `?`).

### Required 컬럼 검증

`getMany()`는 `select()` 사용 시 non-nullable 컬럼이 모두 포함됐는지 검증해요. required 필드가 `undefined`인 잘못된 클래스 인스턴스 생성을 방지해요.

```typescript
@Entity()
class User {
  @PrimaryGeneratedColumn()         // autoIncrement — can omit
  id!: number;

  @Column({ type: "varchar" })      // non-nullable — REQUIRED
  name!: string;

  @Column({ nullable: true })       // nullable — can omit
  bio!: string | null;

  @Column({ default: "active" })    // has default — can omit
  status!: string;
}

// ✓ OK — "name" (the only required column) is included
await qb.select(["name"]).getMany();

// ✗ Throws OrmError MISSING_REQUIRED_COLUMNS — "name" is missing
await qb.select(["bio"]).getMany();

// ✓ Use getPartialMany() to skip validation
await qb.select(["bio"]).getPartialMany();  // OK — plain object
```

컬럼이 **required**로 간주되려면 다음이 모두 참이어야 해요:
- `nullable`이 `true`가 아님
- `default` 값이 지정되지 않음
- `autoIncrement`가 아님 (예: `@PrimaryGeneratedColumn`)

### 메서드별 사용 시나리오

| 상황 | Method | 이유 |
|------|--------|------|
| `em.save()`에 전달할 데이터 | `getMany()` | 전체 lifecycle을 지원하는 클래스 인스턴스 |
| EntitySubscriber / lifecycle hook | `getMany()` | 클래스 인스턴스만 `listenTo()`에 매칭돼요 |
| Read-only API 응답 | `getPartialMany()` | Typed DTO, 컴파일 타임 안전성, 경량 |
| Aggregate / computed column | `getRawMany()` | `addSelect(sql`COUNT(*)`, "cnt")`는 `Pick`으로 타이핑할 수 없어요 |
| 존재 여부 확인 | `exists()` | Boolean — 데이터를 가져오지 않아요 |

`em.find()`에도 `select` 옵션이 있지만, 반환 타입을 좁혀주지는 않아요 — `find()`는 항상 `T[]`를 반환해요. Projection의 타입 안전성이 중요하다면 query builder의 `getPartialMany()`를 사용하세요.

## 같은 쿼리를 미리 만들어 두기 — `prepare()`

같은 **모양의** 쿼리가 값만 바뀌며 반복된다면, SQL을 한 번만 만들어 두고 계속 재사용할 수 있어요. 배치 잡에서 수백 개의 ID로 상세 쿼리를 돌리는 경우가 전형적이에요.

```typescript
import { p } from "@stingerloom/orm";
import sql from "sql-template-tag";

const findById = em
  .createQueryBuilder(User, "u")
  .where(sql`u.id = ${p("id")}`)
  .prepare<{ id: number }>();

for (const id of userIds) {
  const user = await findById.executeOne({ id });
  // SQL 문자열은 한 번만 생성, 이후에는 파라미터만 교체
}
```

`SelectQueryBuilder`의 **투영된 부분 컬럼만 타입드로 받고 싶을 때**는 `preparePartial()`을 쓰면 `TResult`가 `Pick<...>`로 좁혀져요. `RawQueryBuilder`에도 같은 모양의 `.prepare(em)`이 있어요.

> **주의 — 조건 자체가 동적으로 달라지면 `prepare()`가 효과 없음.** "필터가 선택적으로 붙는 검색 엔드포인트"처럼 쿼리 구조 자체가 변하는 경우는 `when()` / `pipe()` 쪽이 맞고, `prepare()`는 어울리지 않아요.

언제 효과가 있고 없는지, `WriteBuffer`나 배치 쓰기와 어떻게 다른지의 전체 배경은 [쿼리 미리 만들어두기](./entity-manager-advanced.md#쿼리-미리-만들어두기-em-compile-qb-prepare)에 있어요.

## 실전 예제 — 필터 검색 + 페이지네이션

지금까지 배운 것을 합쳐볼게요. 선택적 필터를 받아서 총 개수와 함께 페이지네이션된 결과를 반환하는 검색 엔드포인트예요.

```typescript
import { qAlias } from "@stingerloom/orm";

async function searchPosts(filters: {
  authorName?: string;
  category?: string;
  minLikes?: number;
  page: number;
  pageSize: number;
}) {
  const p = qAlias(Post, "p");
  const u = qAlias(User, "u");

  const qb = em
    .createQueryBuilder(Post, "p")
    .select(["id", "title", "createdAt"])
    .leftJoin(User, "u", (join) =>
      join.on(p.col("authorId"), "=", u.col("id"))
    );

  // 각 필터는 선택적 — 값이 있을 때만 조건 추가
  if (filters.authorName) {
    qb.where(u.name.like(`%${filters.authorName}%`));
  }
  if (filters.category) {
    qb.andWhere(p.category.eq(filters.category));
  }
  if (filters.minLikes) {
    qb.andWhere(p.likeCount.gte(filters.minLikes));
  }

  const [posts, total] = await qb
    .orderBy({ createdAt: "DESC" })
    .skip(filters.page * filters.pageSize)
    .take(filters.pageSize)
    .getPartialManyAndCount();

  return { posts, total, page: filters.page, pageSize: filters.pageSize };
}
```

`qAlias()`를 사용하면 query builder가 자연어처럼 읽혀요 — `u.name.like(...)`, `p.category.eq(...)`. TypeScript가 프로퍼티명과 조건 메서드 모두 자동 완성하므로 오타가 컴파일 에러가 돼요.

하지만 `when()`을 쓰면 `if` 블록이 아예 사라져요:

```typescript
const [posts, total] = await em
  .createQueryBuilder(Post, "p")
  .select(["id", "title", "createdAt"])
  .leftJoin(User, "u", (join) =>
    join.on(p.col("authorId"), "=", u.col("id"))
  )
  .when(!!filters.authorName, (qb) =>
    qb.where(u.name.like(`%${filters.authorName}%`))
  )
  .when(!!filters.category, (qb) =>
    qb.where(p.category.eq(filters.category))
  )
  .when(!!filters.minLikes, (qb) =>
    qb.where(p.likeCount.gte(filters.minLikes))
  )
  .orderBy({ createdAt: "DESC" })
  .skip(filters.page * filters.pageSize)
  .take(filters.pageSize)
  .getPartialManyAndCount();
```

`when()`, `pipe()`, scope 같은 편의 헬퍼는
[편의 패턴](./query-builder-patterns.md)에서 다뤄요.

## 다음 단계

- [편의 패턴](./query-builder-patterns.md) — `when`, `pipe`, scope, `whereHas`, `withCount`
- [QueryDSL 표현식](./query-builder-querydsl.md) — 타입드 조건 / 프로젝션 표현
- [페이지네이션 & 스트리밍](./pagination.md) — 커서 페이지네이션, 스트리밍
- [Query Builder 개요](./query-builder.md) — 기본 사용법과 전체 지도
