# Pagination & Streaming

Stingerloom은 대량 데이터를 다루기 위해 세 가지 전략을 제공해요: offset 기반 pagination, cursor 기반 pagination, 그리고 streaming이에요. 각각 용도가 다르기 때문에, 어떤 걸 만드느냐에 따라 적절한 전략을 골라야 해요.

## Deep Page 문제 -- 왜 세 가지 전략이 필요한가요?

API를 살펴보기 전에, 근본적인 문제를 이해하면 도움이 돼요.

사용자가 데이터셋의 "500페이지"를 요청하면, offset 기반 pagination은 이런 SQL을 생성해요:

```sql
SELECT * FROM "post" ORDER BY "id" ASC LIMIT 10 OFFSET 4990
```

단순해 보이지만, 데이터베이스는 비용이 큰 작업을 수행해요: 5,000행을 읽고, 앞의 4,990행을 버리고, 마지막 10행만 반환하는 거예요. 페이지가 깊어질수록 읽고 버리는 행이 늘어나요. 10,000페이지에서는 10행을 반환하기 위해 100,000행을 스캔해요.

Cursor 기반 pagination은 WHERE 절을 사용해서 이 문제를 완전히 해결해요:

```sql
SELECT * FROM "post" WHERE "id" > 4990 ORDER BY "id" ASC LIMIT 11
```

데이터베이스가 `id` 인덱스를 사용해서 바로 해당 위치로 점프해요. 1페이지든 10,000페이지든 성능이 동일해요.

그런데 테이블의 모든 행을 처리해야 하는 경우는 어떨까요? API 응답이 아니라 이메일 발송 같은 배치 작업이라면요. 두 pagination 전략 모두 적합하지 않아요. 이때는 streaming이 필요해요 -- 행을 배치 단위로 가져오고 하나씩 yield하는 방식이에요.

요약하면 이래요:

| Strategy | Best for | Trade-off |
|----------|----------|-----------|
| Offset (`skip`/`take`) | 소규모 데이터셋, "Page X of Y" UI | 높은 offset에서 느려져요 |
| Cursor (`findWithCursor`) | 대규모 데이터셋, infinite scroll | 임의 페이지 접근 불가 |
| Streaming (`stream()`) | 수백만 행 배치 처리 | API 응답에는 부적합해요 |

## Offset-Based Pagination

전통적인 LIMIT/OFFSET pagination이에요. 사용자가 특정 페이지로 바로 이동해야 하는 중소규모 데이터셋에 적합해요.

```typescript
// Method 1: skip + take (recommended)
const page2 = await em.find(Post, {
  orderBy: { createdAt: "DESC" },
  skip: 10,
  take: 10,
});

// Method 2: limit tuple [offset, count]
const page2Alt = await em.find(Post, {
  orderBy: { createdAt: "DESC" },
  limit: [10, 10], // OFFSET 10, LIMIT 10
});
```

두 방법 모두 동일한 SQL을 생성해요:

```sql
SELECT "id", "title", "content", "createdAt"
FROM "post"
ORDER BY "createdAt" DESC
LIMIT 10 OFFSET 10
```

### findAndCount -- 한 번의 호출로 총 개수까지

Paginated UI를 만들 때, 데이터와 총 개수가 동시에 필요한 경우가 많아요. `findAndCount()`는 동일한 연결 내에서 데이터 쿼리와 COUNT 쿼리를 실행해서 둘 다 반환해줘요.

```typescript
const [posts, total] = await em.findAndCount(Post, {
  orderBy: { createdAt: "DESC" },
  skip: 0,
  take: 10,
});

console.log(posts.length); // 10
console.log(total);        // Total number of posts (e.g., 235)
```

ORM은 내부적으로 두 개의 쿼리를 실행해요:

```sql
-- Data query
SELECT "id", "title", "content", "createdAt"
FROM "post"
ORDER BY "createdAt" DESC
LIMIT 10 OFFSET 0

-- Count query
SELECT COUNT(*) FROM "post"
```

### paginate() -- 페이지 데이터와 메타데이터를 한 번에

`findAndCount()`는 `[rows, total]` 튜플만 돌려줍니다. 총 개수에 더해 파생된 페이지
메타데이터(`totalPages`, `hasNextPage` 등)까지 원할 때는, 쿼리 빌더의 `paginate()`가
1-based `page`/`pageSize`로부터 envelope 전체를 돌려줘요. 쿼리를 (조인, `qAlias` 조건,
서브쿼리 등) 빌더로 조립하는 경우에 특히 잘 맞습니다.

```typescript
const result = await em
  .createQueryBuilder(Post, "p")
  .where("p.isPublished", true)
  .orderBy({ createdAt: "DESC" })
  .paginate({ page: 2, pageSize: 10 });

result.data;            // 2페이지의 Post[]
result.total;           // 235
result.page;            // 2
result.pageSize;        // 10
result.totalPages;      // 24
result.hasNextPage;     // true
result.hasPreviousPage; // true
```

`page`/`pageSize`는 `findWithPage()`와 동일하게 정규화되고(0 이하 → 1, 소수 → 내림;
기본값 `page` 1 / `pageSize` 20), `paginate()`는 빌더를 복제하므로 원본 인스턴스에는
LIMIT/OFFSET이 남지 않아 다시 페이징할 수 있어요. 특정 컬럼만 뽑는 목록 화면
(`select(["id", "title"])`)에서는 엔티티 인스턴스 대신 plain `Pick<T, K>` 객체를
돌려주는 `paginatePartial()`을 쓰세요.

반환 형태는 `em.findWithPage()`와 동일하므로, `FindOption`에서 시작하느냐 빌더에서
시작하느냐에 따라 둘을 바꿔 쓸 수 있습니다:

```typescript
// FindOption 기반 — 동일한 PagePaginationResult 형태
const result = await em.findWithPage(Post, {
  where: { isPublished: true },
  orderBy: { createdAt: "DESC" },
  page: 2,
  pageSize: 10,
});
```

### Offset Pagination을 쓰면 좋은 경우

- 사용자가 5페이지나 50페이지로 직접 이동해야 할 때
- 총 행 수가 적을 때 (10만 건 이하)
- "Page X of Y" UI가 필요할 때

> **Warning** 대규모 데이터셋에서는 성능이 저하돼요. 데이터베이스가 결과를 반환하기 전에 `OFFSET`만큼의 행을 스캔하고 버려야 하거든요. 100만 행 테이블에서 5,000페이지를 요청하면 50,000행을 읽고 49,990행을 버리게 돼요.

## Cursor-Based Pagination

대규모 데이터셋에서는 cursor 기반 pagination이 페이지 깊이에 관계없이 일정한 성능을 제공해요.

### 동작 원리

데이터베이스에 "N행을 건너뛰어"라고 하는 대신, "이 특정 값 이후부터 시작해"라고 알려주는 방식이에요. 이 값은 Base64 cursor 문자열로 인코딩되어 클라이언트가 매 요청마다 전달해요.

SQL 비교를 나란히 보면 이래요:

```sql
-- Offset at page 500 (skip = 4990): reads 5000 rows, discards 4990
SELECT "id", "title", "isPublished"
FROM "post"
WHERE "isPublished" = $1
ORDER BY "id" ASC
LIMIT 10 OFFSET 4990

-- Cursor at the same position: jumps directly to id > 4990
SELECT "id", "title", "isPublished"
FROM "post"
WHERE "isPublished" = $1 AND "id" > $2
ORDER BY "id" ASC
LIMIT 11
-- Parameters: [true, 4990]
```

Cursor 방식은 `LIMIT 11`(페이지 크기 10보다 1개 더)을 요청해요. 11행이 돌아오면 다음 페이지가 있다는 뜻이고, 마지막으로 반환된 행의 값을 다음 cursor로 사용해요. 10행 이하가 돌아오면 마지막 페이지예요.

### 사용법

```typescript
// First page
const page1 = await em.findWithCursor(Post, {
  take: 20,
  orderBy: "id",
  direction: "ASC",
});

console.log(page1.data);        // Post[] (up to 20 records)
console.log(page1.hasNextPage); // true
console.log(page1.nextCursor);  // "eyJ2IjoyMH0=" (Base64)

// Second page -- pass the previous cursor
const page2 = await em.findWithCursor(Post, {
  take: 20,
  cursor: page1.nextCursor!,
  orderBy: "id",
  direction: "ASC",
});
```

두 번째 페이지는 이런 SQL을 생성해요:

```sql
SELECT "id", "title", "content", "createdAt"
FROM "post"
WHERE "id" > $1
ORDER BY "id" ASC
LIMIT 21
-- Parameters: [20]  (the cursor value decoded from Base64)
```

### REST API 예제

```typescript
// GET /posts?take=20&cursor=eyJ2IjoyMH0=
async function getPosts(req: Request, res: Response) {
  const result = await em.findWithCursor(Post, {
    take: parseInt(req.query.take as string) || 20,
    cursor: req.query.cursor as string | undefined,
    orderBy: "id",
    direction: "ASC",
    where: { isPublished: true },
  });

  res.json({
    items: result.data,
    nextCursor: result.nextCursor,
    hasNextPage: result.hasNextPage,
  });
}
```

### Cursor Pagination을 쓰면 좋은 경우

- Infinite scroll이나 "Load more" UI
- 대규모 데이터셋 (10만 건 이상)
- 행이 계속 추가되는 실시간 피드
- 페이지 깊이에 관계없이 성능이 일정해야 할 때

> **Hint** Cursor pagination은 정렬된 고유 컬럼(보통 primary key)이 필요해요. 임의 페이지로 점프하는 건 지원하지 않아요 -- 클라이언트가 순차적으로 앞으로만 이동해야 해요.

`findWithCursor()`는 `find()`와 동일한 필터를 적용합니다. `withDeleted: true`를 넘기지 않으면 soft-delete된 행은 제외되고, 단일 테이블 상속(STI) 자식 클래스를 페이징하면 discriminator 술어가 자동으로 붙어 해당 서브타입 행만 반환돼요.

## Streaming

수백만 행을 처리할 때, 전부 메모리에 올리는 건 비현실적이에요. `stream()`은 설정 가능한 배치 크기로 행을 가져오는 `AsyncGenerator`를 반환해요 -- 전체 결과셋을 메모리에 들고 있지 않으면서 엔티티를 하나씩 처리할 수 있어요.

### find()를 루프에서 쓰면 안 되나요?

`find()`와 수동 offset 추적으로 직접 배칭을 구현할 수도 있어요. 하지만 `stream()`이 이걸 대신 해주면서 세부 사항도 정확히 처리해줘요: 빈 배치 처리, 데이터 끝 감지, 엔티티 하나씩 yield까지 해주기 때문에 처리 코드가 깔끔해져요.

### Batching SQL

내부적으로 `stream()`은 LIMIT/OFFSET을 사용해서 한 번에 하나의 배치를 가져와요. 배치 크기가 500이면:

```sql
-- Batch 1: rows 0-499
SELECT "id", "name", "email" FROM "user" WHERE "isActive" = $1
ORDER BY "id" ASC LIMIT 500 OFFSET 0

-- Batch 2: rows 500-999
SELECT "id", "name", "email" FROM "user" WHERE "isActive" = $1
ORDER BY "id" ASC LIMIT 500 OFFSET 500

-- Batch 3: rows 1000-1499
SELECT "id", "name", "email" FROM "user" WHERE "isActive" = $1
ORDER BY "id" ASC LIMIT 500 OFFSET 1000

-- Continues until a batch returns fewer than 500 rows
```

각 배치를 가져온 뒤, AsyncGenerator를 통해 엔티티를 하나씩 yield하고, 다음 배치를 가져오기 전에 이전 배치는 가비지 컬렉션돼요. 메모리 사용량은 총 사용자 수(200만)가 아니라 배치 크기(500)에 비례해요.

```typescript
async *stream<T>(entity: Class<T>, options?: FindOption<T>, batchSize?: number): AsyncGenerator<T>
```

### 기본 사용법

```typescript
for await (const user of em.stream(User, { where: { isActive: true } })) {
  await sendEmail(user.email);
}
```

세 번째 파라미터로 배치 크기를 조절할 수 있어요 (기본값: 1000). 배치에서 반환된 행 수가 배치 크기보다 적으면 끝에 도달한 것으로 판단하고 멈춰요.

```typescript
// Fetch in batches of 500
for await (const post of em.stream(Post, { orderBy: { id: "ASC" } }, 500)) {
  await indexPost(post);
}
```

### 지원하는 옵션

`stream()`은 모든 `FindOption` 속성을 지원해요 -- `where`, `orderBy`, `relations`, `select`, `withDeleted` 등이에요.

```typescript
// Stream with relations and filtered columns
for await (const post of em.stream(Post, {
  select: ["id", "title"],
  relations: ["author"],
  where: { isPublished: true },
  orderBy: { createdAt: "DESC" },
}, 2000)) {
  console.log(`${post.title} by ${post.author.name}`);
}
```

### Streaming 전에 총 개수 확인하기

처리 전에 총 개수가 필요하면, `count()`를 먼저 호출하면 돼요:

```typescript
const total = await em.count(User, { isActive: true });
console.log(`Processing ${total} users...`);

let processed = 0;
for await (const user of em.stream(User, { where: { isActive: true } })) {
  await process(user);
  processed++;
  if (processed % 1000 === 0) console.log(`${processed}/${total}`);
}
```

### stream() vs find() 어떤 걸 써야 하나요?

| Scenario | Use |
|----------|-----|
| 페이지 단위로 결과를 반환하는 API 엔드포인트 | `find()` with pagination |
| 테이블의 모든 행 처리 (ETL, export, 배치 이메일) | `stream()` |
| 대규모 데이터셋에서 집계 | `stream()` 또는 `em.query()`로 DB 측 aggregation |

> **Hint** 대규모 변경 가능한 테이블에서 일관된 결과를 보장하려면, `REPEATABLE READ` 격리 수준의 트랜잭션 안에서 stream을 실행하는 걸 고려해보세요. 반복 중 phantom read를 방지할 수 있어요.

## 전략 선택 가이드

| Question | Offset | Cursor | Stream |
|----------|--------|--------|--------|
| 사용자가 N페이지로 바로 이동 가능? | Yes | No | No |
| 깊은 페이지에서의 성능? | 저하돼요 | 일정해요 | N/A |
| 실시간 insert와 호환? | skip/중복 가능 | 안정적 | 격리 수준에 따라 다름 |
| 메모리 사용량 | 페이지 크기에 비례 | 페이지 크기에 비례 | 배치 크기에 비례 |
| Use case | Admin dashboard | Infinite scroll | ETL / batch job |

## Next Steps

- [EntityManager](./entity-manager.md) -- Full CRUD reference
- [Query Builder](./query-builder.md) -- Complex queries with GROUP BY, JOIN, and aggregation
- [Production Guide](./production-guide.md) -- Tuning for high-traffic workloads
