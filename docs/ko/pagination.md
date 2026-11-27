# Pagination & Streaming

Stingerloom은 대량 데이터를 다루는 세 가지 전략을 제공합니다. 오프셋(offset) 기반 페이지네이션, 커서(cursor) 기반 페이지네이션, 스트리밍(streaming)입니다. 전략마다 용도가 다르므로 무엇을 만드는지에 따라 알맞은 전략을 골라야 합니다.

## Deep Page 문제 -- 왜 세 가지 전략이 필요한가요?

API를 살펴보기 전에 근본적인 문제를 먼저 이해하면 도움이 됩니다.

사용자가 데이터셋의 "500페이지"를 요청하면 오프셋 기반 페이지네이션은 다음 SQL을 생성합니다.

```sql
SELECT * FROM "post" ORDER BY "id" ASC LIMIT 10 OFFSET 4990
```

단순해 보이지만 데이터베이스는 비용이 큰 작업을 합니다. 5,000행을 읽고 앞의 4,990행을 버린 뒤 마지막 10행만 반환합니다. 페이지가 깊어질수록 읽고 버리는 행이 늘어납니다. 10,000페이지에서는 10행을 반환하려고 100,000행을 스캔합니다.

커서 기반 페이지네이션은 WHERE 절을 사용해서 이 문제를 완전히 해결합니다.

```sql
SELECT * FROM "post" WHERE "id" > 4990 ORDER BY "id" ASC LIMIT 11
```

데이터베이스는 `id` 인덱스를 사용해서 바로 해당 위치로 이동합니다. 1페이지든 10,000페이지든 성능이 같습니다.

그런데 API 응답이 아니라 이메일 발송 같은 배치 작업에서 테이블의 모든 행을 처리해야 한다면 어떨까요? 이때는 두 페이지네이션 전략 모두 적합하지 않습니다. 이런 작업에는 스트리밍이 필요합니다. 스트리밍은 행을 배치 단위로 조회하고 하나씩 yield합니다.

요약하면 다음과 같습니다.

| Strategy | Best for | Trade-off |
|----------|----------|-----------|
| Offset (`skip`/`take`) | 소규모 데이터셋, "Page X of Y" UI | 오프셋이 크면 느려짐 |
| Cursor (`findWithCursor`) | 대규모 데이터셋, 무한 스크롤 | 임의 페이지 접근 불가 |
| Streaming (`stream()`) | 수백만 행 배치 처리 | API 응답에는 부적합 |

## Offset-Based Pagination

전통적인 LIMIT/OFFSET 페이지네이션입니다. 사용자가 특정 페이지로 바로 이동해야 하는 중소규모 데이터셋에 적합합니다.

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

두 방법은 같은 SQL을 생성합니다.

```sql
SELECT "id", "title", "content", "createdAt"
FROM "post"
ORDER BY "createdAt" DESC
LIMIT 10 OFFSET 10
```

### findAndCount -- 한 번의 호출로 총 개수까지

페이지가 있는 UI를 만들 때는 데이터와 총 개수가 함께 필요한 경우가 많습니다. `findAndCount()`는 같은 연결에서 데이터 쿼리와 COUNT 쿼리를 실행하고 두 결과를 한 번에 반환합니다.

```typescript
const [posts, total] = await em.findAndCount(Post, {
  orderBy: { createdAt: "DESC" },
  skip: 0,
  take: 10,
});

console.log(posts.length); // 10
console.log(total);        // Total number of posts (e.g., 235)
```

ORM은 내부에서 쿼리 두 개를 실행합니다.

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

`findAndCount()`는 `[rows, total]` 튜플만 반환합니다. 총 개수와 함께 `totalPages`, `hasNextPage` 같은
파생 페이지 메타데이터도 필요하면 쿼리 빌더의 `paginate()`를 쓰세요. `paginate()`는
1부터 시작하는 `page`/`pageSize`를 받아 결과 전체를 감싼 객체를 반환합니다. 조인, `qAlias` 조건,
서브쿼리 등으로 쿼리를 빌더에서 조립할 때 특히 잘 맞습니다.

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

`page`/`pageSize`는 `findWithPage()`와 같은 방식으로 정규화됩니다. `page`가 1보다 작으면
1페이지를 조회하고 소수는 내림합니다. `pageSize`가 1보다 작으면 기본값 20을 씁니다. 두 값은 모두
숫자여야 하고 `pageSize`는 정수여야 합니다. 그래서 쿼리 스트링 값은 먼저 `Number(...)`로
바꿔 주세요. `paginate()`는 빌더를 복제합니다. 그래서 원본 인스턴스에는
LIMIT/OFFSET이 남지 않고 원본으로 다시 페이지네이션할 수 있습니다. `select(["id", "title"])`처럼 특정 컬럼만 고르는 목록 화면에서는
`paginatePartial()`을 쓰세요. `paginatePartial()`은 엔티티 인스턴스 대신 plain `Pick<T, K>` 객체를
반환합니다.

빌더에 `groupBy()`가 있으면 페이지의 각 행이 그룹입니다. 그래서 `total`은 `HAVING`을
통과한 그룹의 개수를 셉니다. `findWithPage()`가 `FindOption.groupBy`에 적용하는 규칙과
같습니다. [GROUP BY가 있는 getCount()](./query-builder-execution.md#group-by가-있는-getcount-는-그룹-수를-셉니다)를 참고하세요.

반환 형태는 `em.findWithPage()`와 같습니다. 그래서 `FindOption`에서 시작하는지 빌더에서
시작하는지에 따라 둘을 바꿔 쓸 수 있습니다.

```typescript
// FindOption 기반: 같은 PagePaginationResult 형태
const result = await em.findWithPage(Post, {
  where: { isPublished: true },
  orderBy: { createdAt: "DESC" },
  page: 2,
  pageSize: 10,
});
```

### Offset Pagination을 쓰면 좋은 경우

- 사용자가 5페이지나 50페이지로 직접 이동해야 할 때
- 총 행 수가 10만 개 이하로 적을 때
- "Page X of Y" UI가 필요할 때

> 경고: 대규모 데이터셋에서는 성능이 떨어집니다. 데이터베이스가 결과를 반환하기 전에 `OFFSET`만큼의 행을 스캔하고 버려야 하기 때문입니다. 100만 행 테이블에서 5,000페이지를 요청하면 데이터베이스는 50,000행을 읽고 그중 49,990행을 버립니다.

## Cursor-Based Pagination

대규모 데이터셋에서는 커서 기반 페이지네이션이 페이지 깊이에 관계없이 일정한 성능을 냅니다.

### 동작 원리

커서 기반 페이지네이션은 데이터베이스에 "N행을 건너뛰라"고 하는 대신 "이 값 다음부터 시작하라"고 알려 줍니다. 이 값은 Base64 커서 문자열로 인코딩됩니다. 클라이언트는 요청할 때마다 이 문자열을 다시 보냅니다.

두 방식의 SQL을 나란히 비교하면 다음과 같습니다.

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

커서 방식은 페이지 크기 10보다 하나 많은 `LIMIT 11`을 요청합니다. 11행이 반환되면 ORM은 다음 페이지가 있다고 판단합니다. 그리고 마지막으로 반환한 행의 값을 다음 커서로 사용합니다. 10행 이하가 반환되면 마지막 페이지입니다.

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

두 번째 페이지는 다음 SQL을 생성합니다.

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

- 무한 스크롤이나 "Load more" UI
- 10만 행 이상의 대규모 데이터셋
- 행이 계속 추가되는 실시간 피드
- 페이지 깊이에 관계없이 성능이 일정해야 할 때

> 힌트: 커서 페이지네이션은 컬럼 하나로 정렬합니다. 그리고 값이 같은 행은 기본 키로 순서를 정합니다. 복합 키라면 키 컬럼을 모두 씁니다. 그래서 정렬 컬럼에 같은 값이 있어도 됩니다. 임의 페이지로 이동하는 것은 지원하지 않습니다. 클라이언트는 앞으로 한 페이지씩 차례로 이동해야 합니다.

`findWithCursor()`는 `find()`와 같은 필터를 적용합니다. `withDeleted: true`를 넘기지 않으면 소프트 삭제된 행은 제외됩니다. 단일 테이블 상속(STI) 자식 클래스를 페이지네이션하면 구분 컬럼 조건이 자동으로 붙습니다. 그래서 해당 서브타입의 행만 반환됩니다.

관계도 같은 규칙으로 로드합니다. `eager: true` 관계는 따로 요청하지 않아도 붙습니다. `relations: ["author", "comments"]`로 나열한 관계는 `@ManyToOne`, `@OneToMany`, `@ManyToMany`, `@OneToOne` 모두 로드됩니다. 키셋 쿼리 자체는 JOIN하지 않습니다. ORDER BY와 커서가 루트 테이블에 묶여 있기 때문입니다. 그래서 관계마다 페이지당 배치 쿼리가 하나씩 추가될 뿐이고 행마다 쿼리가 실행되지는 않습니다. `withDeleted: true`는 이 관계 로드의 소프트 삭제 필터도 함께 걷어냅니다. `"comments.author"`나 객체 형식으로 쓴 [중첩 관계](./relations.md#중첩-관계)도 페이지마다 로드됩니다. 이때 단계별·관계별로 배치 쿼리가 하나씩 실행됩니다.

```typescript
const page = await em.findWithCursor(Post, {
  take: 20,
  orderBy: "id",
  relations: ["comments"], // page.data[i].comments: Comment[]
});
```

## Streaming

수백만 행을 처리할 때 행을 한꺼번에 메모리에 올리는 것은 비현실적입니다. `stream()`은 설정한 배치 크기만큼 행을 조회하는 `AsyncGenerator`를 반환합니다. 그래서 전체 결과 집합을 메모리에 올리지 않고 엔티티를 하나씩 처리할 수 있습니다.

### find()를 루프에서 쓰면 안 되나요?

`find()`로 오프셋을 직접 관리하며 배치 처리를 구현할 수도 있습니다. 하지만 `stream()`은 이 일을 대신하면서 세부 사항도 정확히 처리합니다. 빈 배치를 처리하고 데이터의 끝을 감지하며 엔티티를 하나씩 yield합니다. 그래서 처리 코드가 깔끔해집니다.

### Batching SQL

`stream()`은 내부에서 LIMIT/OFFSET으로 한 번에 배치 하나를 조회합니다. 배치 크기가 500이면 다음과 같습니다.

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

배치를 조회하면 AsyncGenerator가 엔티티를 하나씩 yield합니다. 그리고 다음 배치를 조회하기 전에 이전 배치는 가비지 컬렉션됩니다. 그래서 메모리 사용량은 총 사용자 수 200만이 아니라 배치 크기 500에 비례합니다.

```typescript
async *stream<T>(entity: Class<T>, options?: FindOption<T>, batchSize?: number): AsyncGenerator<T>
```

### 기본 사용법

```typescript
for await (const user of em.stream(User, { where: { isActive: true } })) {
  await sendEmail(user.email);
}
```

세 번째 파라미터로 배치 크기를 조절합니다. 기본값은 1000입니다. 배치에서 반환된 행 수가 배치 크기보다 적으면 제너레이터는 끝에 도달했다고 판단하고 멈춥니다.

```typescript
// Fetch in batches of 500
for await (const post of em.stream(Post, { orderBy: { id: "ASC" } }, 500)) {
  await indexPost(post);
}
```

### 지원하는 옵션

`stream()`은 `where`, `orderBy`, `relations`, `select`, `withDeleted` 등 모든 `FindOption` 속성을 지원합니다.

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

처리하기 전에 총 개수가 필요하면 `count()`를 먼저 호출하세요.

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
| 페이지 단위로 결과를 반환하는 API 엔드포인트 | 페이지네이션을 적용한 `find()` |
| 테이블의 모든 행 처리 (ETL, export, 배치 이메일) | `stream()` |
| 대규모 데이터셋에서 집계 | `stream()` 또는 `em.query()`로 데이터베이스에서 집계 |

> 힌트: 변경될 수 있는 대규모 테이블에서 일관된 결과가 필요하면 `REPEATABLE READ` 격리 수준의 트랜잭션 안에서 스트림을 실행하는 것을 고려하세요. 그러면 반복하는 동안 팬텀 리드(phantom read)를 막을 수 있습니다.

## 전략 선택 가이드

| Question | Offset | Cursor | Stream |
|----------|--------|--------|--------|
| 사용자가 N페이지로 바로 이동 | Yes | No | No |
| 깊은 페이지에서의 성능 | 떨어짐 | 일정함 | N/A |
| 실시간 삽입과의 호환 | 누락/중복 가능 | 안정적 | 격리 수준에 따라 다름 |
| 메모리 사용량 | 페이지 크기에 비례 | 페이지 크기에 비례 | 배치 크기에 비례 |
| Use case | Admin dashboard | Infinite scroll | ETL / batch job |

## Next Steps

- [EntityManager](./entity-manager.md): 전체 CRUD 레퍼런스
- [Query Builder](./query-builder.md): GROUP BY, JOIN, 집계를 쓰는 복잡한 쿼리
- [Production Guide](./production-guide.md): 트래픽이 많은 환경을 위한 튜닝
