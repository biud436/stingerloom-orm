# Query Builder

`find()`와 `findOne()`으로 대부분의 쿼리는 충분해요 — 조건 필터링, relation 로딩, 페이지네이션까지. 하지만 가끔은 그걸로 부족할 때가 있어요. 직접적인 relation이 없는 두 테이블을 조인한다거나, 카테고리별 행 수를 그룹핑하거나, 서로 다른 테이블의 결과를 UNION으로 합쳐야 할 때요. 이런 상황에서 **query builder**가 필요해요.

Stingerloom은 두 가지 query builder를 제공하고, 선택 기준은 간단해요.

| Builder | 언제 쓰나요 | 생성 방법 |
|---------|-------------|-----------|
| **SelectQueryBuilder** | 엔티티를 쿼리하면서 컬럼명 자동완성이 필요할 때 | `em.createQueryBuilder(User, "u")` |
| **RawQueryBuilder** | Raw SQL 제어가 필요할 때 — UNION, CTE, window function | `em.createQueryBuilder()` (인자 없이) |

대부분은 `SelectQueryBuilder`를 쓰게 돼요. 여기서부터 시작할게요.

---

## SelectQueryBuilder — Type-Safe 쿼리

### Query Builder가 왜 필요할까요?

본론에 들어가기 전에, `find()`로 다 하면 안 되는 걸까요?

`find()`가 표현할 수 없는 것들이 있기 때문이에요. `find()`는 `WHERE field = value`를 지원하지만, `WHERE age >= 18`이나, 관계없는 테이블에 대한 `JOIN`, `GROUP BY category HAVING COUNT(*) > 5` 같은 건 못 해요. 이럴 때 query builder가 필요해요.

Stingerloom의 query builder는 안전성 수준이 다른 세 가지 실행 메서드를 제공해요.

**`getMany()`** — 항상 **클래스 인스턴스**를 반환해요. `instanceof`가 동작하고, 클래스 메서드를 쓸 수 있고, 결과를 `em.save()`에 전달할 수 있어요. `select()` 사용 시, non-nullable 컬럼이 모두 포함됐는지 검증해요.

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .where("isActive", true)
  .getMany();

users[0] instanceof User; // ✓ true — real class instance
await em.save(User, users[0]); // ✓ works correctly
```

**`getPartialMany()`** — `Pick<T, K>` 타입 narrowing이 적용된 **typed plain object**를 반환해요. 선택하지 않은 컬럼에 접근하면 컴파일 에러가 나요. required 컬럼 검증은 하지 않아요.

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name"])
  .getPartialMany();

users[0].id;    // ✓ number — exists in Pick<User, "id" | "name">
users[0].name;  // ✓ string — exists
users[0].email; // ✗ Compile error! Property 'email' does not exist
```

**`getRawMany()`** — **untyped plain object** (`Record<string, unknown>`)를 반환해요. `addSelect(sql`COUNT(*)`, "cnt")` 같은 computed column이 있는 쿼리에 사용해요.

`where()`와 `orderBy()`는 항상 엔티티의 모든 컬럼을 받을 수 있어요 — SELECT하지 않은 컬럼으로도 필터링이나 정렬이 가능하니까요. 타입 시스템은 **projection**(반환 결과)과 **entity**(쿼리 대상)를 별도로 추적해요.

### 첫 번째 Query Builder 쿼리

활성 사용자를 등록일 기준으로 정렬하되, `id`, `name`, `email` 컬럼만 가져오고 싶다고 해볼게요. `find()`로는 이렇게 써요:

```typescript
const users = await em.find(User, {
  select: ["id", "name", "email"],
  where: { isActive: true },
  orderBy: { createdAt: "DESC" },
  take: 10,
});
```

Query builder로는 같은 쿼리가 이렇게 돼요:

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name", "email"])
  .where("isActive", true)
  .orderBy({ createdAt: "DESC" })
  .limit(10)
  .getPartialMany();
```

여기까지는 큰 차이가 없어요. Query builder의 진가는 `find()`로 표현할 수 없는 것들 — `>=` 같은 연산자, 관계없는 테이블과의 JOIN, GROUP BY + aggregate, pessimistic locking — 이 필요할 때 드러나요.

`createQueryBuilder(User, "u")`의 `"u"`는 **table alias**예요. 생성된 SQL에서 컬럼을 한정하는 짧은 이름이에요: `"u"."id"`, `"u"."name"` 같은 식이죠. JOIN을 다룰 때 alias가 왜 중요한지 알게 될 거예요.

> **Hint** Repository에서도 query builder를 생성할 수 있어요: `userRepo.createQueryBuilder("u")`. 둘 다 같은 방식으로 동작해요.

### WHERE — 행 필터링

`where()` 메서드는 조건의 복잡도에 따라 세 가지 스타일을 지원해요.

**Equals** — 가장 간단한 형태예요. 컬럼명과 값을 넘기면 돼요.

```typescript
qb.where("status", "active");
// WHERE "u"."status" = $1
```

**Operator** — `>=`, `<`, `LIKE` 등이 필요할 때요. 두 번째 인자로 연산자를 넘겨요. 연산자는 type-check 되므로 `"LKIE"` 같은 오타는 컴파일 에러가 돼요.

```typescript
qb.where("age", ">=", 18);
// WHERE "u"."age" >= $1

// Allowed operators:
// =, !=, <>, <, >, <=, >=, LIKE, NOT LIKE, ILIKE, IN, NOT IN,
// IS NULL, IS NOT NULL, BETWEEN
```

**Raw SQL** — ORM으로 표현할 수 없는 것들에 사용해요. `sql` template literal을 직접 넘기면 돼요.

```typescript
import sql from "sql-template-tag";

qb.where(sql`"u"."score" > ${90}`);
```

세 가지 스타일 모두 type-safe해요 — 컬럼명(`"age"`, `"status"`)이 `keyof User`에서 자동완성돼요. 오타는 컴파일 에러가 돼요.

### 조건 결합 — AND, OR

여러 조건은 `andWhere()`와 `orWhere()`로 체이닝해요.

```typescript
const qb = em.createQueryBuilder(User, "u");

const users = await qb
  .where("isActive", true)
  .andWhere("age", ">=", 18)
  .getMany();
// WHERE "u"."is_active" = $1 AND "u"."age" >= $2
```

`orWhere()`는 기존 조건을 괄호로 감싸고 OR 분기를 추가해요.

```typescript
qb.where("isActive", true)
  .andWhere("age", ">=", 18)
  .orWhere("role", "admin");
// WHERE ("u"."is_active" = $1 AND "u"."age" >= $2) OR "u"."role" = $3
```

즉: (active이면서 18세 이상)이거나, 나이와 상관없이 admin인 경우예요.

### 자주 쓰는 WHERE 헬퍼

흔한 패턴에 raw SQL을 쓰는 대신, 내장 헬퍼를 사용해요.

```typescript
// IN — match any value in the list
qb.whereIn("status", ["active", "pending"]);

// NOT IN — exclude these values
qb.whereNotIn("id", [1, 2, 3]);

// NULL checks
qb.whereNull("deletedAt");
qb.whereNotNull("email");

// BETWEEN — range check
qb.whereBetween("age", 18, 65);

// LIKE — pattern matching
qb.whereLike("name", "%alice%");
```

각 헬퍼는 기존 WHERE 절에 AND 조건을 추가해요. `where()`와 `andWhere()`와 자유롭게 섞어 쓸 수 있어요.

### JOIN — 테이블 결합

여기서 query builder의 진가가 나타나요. 게시글 목록과 함께 작성자 이름을 보여주고 싶다고 해볼게요. `Post` 엔티티에는 `authorId` 컬럼이 있지만, `User` 테이블에서 실제 이름이 필요해요.

```typescript
import sql from "sql-template-tag";

const posts = await em
  .createQueryBuilder(Post, "p")
  .select(["id", "title"])
  .addSelect(sql`"u"."name"`, "authorName")
  .leftJoin("users", "u", sql`"p"."author_id" = "u"."id"`)
  .orderBy({ createdAt: "DESC" })
  .limit(20)
  .getRawMany();
```

하나씩 살펴볼게요:

- `leftJoin("users", "u", ...)` — `users` 테이블을 alias `"u"`로, 주어진 조건으로 조인해요.
- `addSelect(sql\`"u"."name"\`, "authorName")` — 조인된 테이블의 raw 컬럼을 추가해요. `"name"`은 `Post`가 아닌 `User`에 속하므로, type-safe한 `select()` 대신 raw SQL로 `addSelect`를 사용해요.
- 결과는 `LEFT JOIN`이에요 — 작성자가 없는 게시글도 나타나요 (`authorName`이 NULL).

세 가지 join 타입을 사용할 수 있어요:

| Method | SQL | 언제 쓰나요 |
|--------|-----|-------------|
| `leftJoin()` | `LEFT JOIN` | 조인 테이블에 매칭이 없어도 행을 포함할 때 |
| `innerJoin()` | `INNER JOIN` | 양쪽 테이블 모두 매칭되는 행만 필요할 때 |
| `rightJoin()` | `RIGHT JOIN` | 조인 테이블의 모든 행을 포함할 때 |

### ORDER BY와 페이지네이션

정렬과 페이지네이션은 예상하는 대로 동작해요.

```typescript
// Type-safe ORDER BY — column names auto-complete
qb.orderBy({ createdAt: "DESC", name: "ASC" });

// LIMIT and OFFSET
qb.limit(10).offset(20);

// Or use the skip/take aliases (same effect)
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

### GROUP BY와 집계

카테고리별 게시글 수를 세고 싶다고 해볼게요. GROUP BY가 필요해요.

```typescript
import sql from "sql-template-tag";

const stats = await em
  .createQueryBuilder(Post, "p")
  .select(["category"])
  .addSelect(sql`COUNT(*)`, "postCount")
  .groupBy(["category"])
  .having(sql`COUNT(*) >= ${5}`)
  .getRawMany();
// [{ category: "tech", postCount: 42 }, { category: "life", postCount: 17 }, ...]
```

`groupBy()`는 컬럼명 배열을 받아요 (type-safe). `having()`은 집계 후 그룹을 필터링해요 — 여기서는 5개 이상의 게시글이 있는 카테고리만 남겨요.

### DISTINCT

중복 없는 행만 원할 때 DISTINCT를 활성화해요.

```typescript
const uniqueCities = await em
  .createQueryBuilder(User, "u")
  .select(["city"])
  .setDistinct()
  .getPartialMany();
// SELECT DISTINCT "u"."city" FROM "user" AS "u"
```

결과 집합에서 중복 행을 제거해요. 컬럼 일부만 선택할 때 같은 값을 공유하는 행이 많으면 유용해요.

### Pessimistic Locking

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

| Method | SQL | 효과 |
|--------|-----|------|
| `forUpdate()` | `FOR UPDATE` | Exclusive lock — 읽기/쓰기 모두 차단 |
| `forShare()` | `FOR SHARE` / `LOCK IN SHARE MODE` | Shared lock — 쓰기만 차단 |

### Soft Delete 처리

엔티티에 `@DeletedAt` 컬럼이 있으면, query builder가 자동으로 soft-deleted 행을 제외해요. 포함하려면:

```typescript
qb.withDeleted();
```

### 결과 검증 — validate()

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

#### Zod로 Schema Validation 하기

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

#### 배열 단위 검증 — validateArray()

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

#### 행 검증과 배열 검증 결합하기

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

#### 언제 검증을 사용할까요

검증은 행마다 함수 호출이 추가되므로 공짜가 아니에요. 효과가 있는 상황은 이래요:

| 상황 | 검증? | 이유 |
|------|-------|------|
| 내부 서비스, 신뢰할 수 있는 스키마 | No | 속도가 더 중요해요 |
| 사용자 데이터를 반환하는 API 엔드포인트 | Yes | null/타입 불일치를 클라이언트에 도달하기 전에 잡아요 |
| 느슨한 소스 데이터를 다루는 ETL 파이프라인 | Yes | 잘못된 데이터 전파를 방지해요 |
| 역직렬화 버그 디버깅 | Yes (일시적으로) | 정확히 어떤 행/필드가 문제인지 특정해요 |

기본값 — validator 없음, 오버헤드 제로 — 이 대부분의 내부 쿼리에 맞는 선택이에요. 데이터가 신뢰 경계를 넘는 곳에서 검증을 추가하세요.

### 쿼리 실행하기

쿼리를 만들었으니 실행해야겠죠. Query builder는 안전성과 타이핑 보장 수준이 다른 세 단계의 실행 메서드를 제공해요.

**Safe — required 컬럼 검증이 있는 클래스 인스턴스:**

| Method | Returns | 설명 |
|--------|---------|------|
| `getMany()` | `T[]` | 클래스 인스턴스. `select()` 사용 시 required 컬럼 검증 |
| `getOne()` | `T \| null` | 단일 클래스 인스턴스 또는 null (자동으로 LIMIT 1 추가) |
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

### 실전 예제 — 필터 검색 + 페이지네이션

지금까지 배운 것을 합쳐볼게요. 선택적 필터를 받아서 총 개수와 함께 페이지네이션된 결과를 반환하는 검색 엔드포인트예요.

```typescript
async function searchPosts(filters: {
  authorName?: string;
  category?: string;
  minLikes?: number;
  page: number;
  pageSize: number;
}) {
  const qb = em
    .createQueryBuilder(Post, "p")
    .select(["id", "title", "createdAt"])
    .leftJoin("users", "u", sql`"p"."author_id" = "u"."id"`);

  // Each filter is optional — add conditions only when present
  if (filters.authorName) {
    qb.where(sql`"u"."name" LIKE ${`%${filters.authorName}%`}`);
  }
  if (filters.category) {
    qb.andWhere("category", filters.category);
  }
  if (filters.minLikes) {
    qb.andWhere("likeCount", ">=", filters.minLikes);
  }

  const [posts, total] = await qb
    .orderBy({ createdAt: "DESC" })
    .skip(filters.page * filters.pageSize)
    .take(filters.pageSize)
    .getPartialManyAndCount();

  return { posts, total, page: filters.page, pageSize: filters.pageSize };
}
```

Query builder가 쿼리를 **조건부로 빌드**할 수 있다는 점에 주목하세요. `find()`로는 `where` 객체를 수동으로 구성해야 하지만, query builder에서는 필요한 메서드를 그냥 호출하면 돼요.

---

## RawQueryBuilder — 완전한 SQL 제어

UNION, CTE, window function, subquery 같은 고급 SQL 기능은 [Raw SQL & CTE](./raw-sql.md) 가이드를 참고하세요.

간단한 미리보기예요:

```typescript
import sql from "sql-template-tag";

const qb = em.createQueryBuilder();

const query = qb
  .select(['"id"', '"name"', '"email"'])
  .from('"users"')
  .where([sql`"is_active" = ${true}`])
  .orderBy([{ column: '"created_at"', direction: "DESC" }])
  .limit(10)
  .build();

const users = await em.query(query);
```

RawQueryBuilder는 UNION / INTERSECT / EXCEPT, Common Table Expression (CTE), recursive CTE, window function (ROW_NUMBER, RANK, LAG 등), DISTINCT ON을 지원해요. 자세한 내용은 [전체 가이드](./raw-sql.md)를 참고하세요.

---

## 올바른 실행 메서드 선택하기

Query builder는 세 단계의 실행 메서드를 제공해요. 결과에서 무엇이 필요한지에 따라 선택하세요.

```typescript
const qb = em.createQueryBuilder(User, "u")
  .select(["id", "name"])
  .where("isActive", true);

// 1. Safe — class instances, validates required columns
const entities = await qb.getMany();         // T[] — instanceof User === true
await em.save(User, entities[0]);             // ✓ works

// 2. Partial — typed plain objects, no validation
const dtos = await qb.getPartialMany();       // Pick<User, "id" | "name">[]
dtos[0].email;                                // ✗ compile error
dtos[0] instanceof User;                      // false

// 3. Raw — untyped plain objects
const raw = await qb.getRawMany();            // Record<string, unknown>[]
```

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

---

## 두 Builder 중 어떤 걸 선택할까요

| 질문 | SelectQueryBuilder | RawQueryBuilder |
|------|-------------------|----------------|
| 등록된 엔티티를 쿼리하나요? | Yes | 필수 아님 |
| `keyof T` 자동완성이 필요하나요? | Yes | No |
| UNION / INTERSECT / EXCEPT가 필요하나요? | No | Yes |
| CTE (WITH / WITH RECURSIVE)가 필요하나요? | No | Yes |
| Window function이 필요하나요? | No | Yes |
| 클래스 인스턴스를 반환하나요? | `getMany()` yes / `getPartialMany()` no | No — `em.query()`를 통한 raw object |

실무에서는 일상적인 쿼리에 `SelectQueryBuilder`로 시작하세요. 한계에 부딪히면 — UNION, 재귀 계층 탐색, window 분석이 필요하면 — 해당 쿼리만 `RawQueryBuilder`로 전환하세요.

## Next Steps

- [Raw SQL & CTE](./raw-sql.md) — UNION, CTE, window function, DISTINCT ON
- [Pagination & Streaming](./pagination.md) — Offset, cursor, streaming 전략
- [EntityManager](./entity-manager.md) — find(), save() 등 기본 CRUD
- [API Reference](./api-reference.md) — 모든 메서드 시그니처 빠른 참조
