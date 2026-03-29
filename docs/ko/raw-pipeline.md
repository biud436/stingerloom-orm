# Raw Pipeline

## 왜 Entity 변환이 비용인가

`em.find(User)`를 호출하면 내부에서 많은 일이 벌어집니다. ORM이 SQL 쿼리를 보내고, 데이터베이스 드라이버가 행을 수신하고, 그 행을 하나씩 타입이 지정된 Entity 인스턴스로 변환합니다. 컬럼 이름을 재매핑하고, 컬럼 트랜스포머를 적용하고, 객체를 역직렬화하고, 관계를 로딩합니다.

100행이면 보이지 않습니다. 100,000행이면 병목이 됩니다.

`em.find()`의 데이터 흐름을 따라가 봅시다:

```
데이터베이스 wire protocol
    → pg/mysql2/sqlite가 JS 객체로 파싱         (드라이버 레이어)
    → ResultTransformer가 컬럼 이름 재매핑       (ORM 레이어)
    → deserializeEntity()가 클래스 인스턴스 생성   (ORM 레이어)
    → applyColumnTransforms()가 변환기 실행       (ORM 레이어)
    → RelationLoader가 eager/lazy 관계 해석      (ORM 레이어)
    → 타입이 지정된 Entity 인스턴스를 받음          (코드)
```

드라이버 레이어 이후의 모든 단계가 오버헤드입니다. gRPC 서비스로 데이터를 보내거나, CSV로 내보내거나, ETL 파이프라인에 넣어야 한다면 Entity 인스턴스가 필요 없습니다. 원시 데이터를 최대한 빠르게, 최소한의 메모리로 받아야 합니다.

식당에 비유하면 이렇습니다. 보통은 주방(ORM)이 원재료(데이터베이스 행)를 가지고 멋지게 플레이팅된 요리(Entity 인스턴스)를 만듭니다. 그런데 다른 주방에 재료를 넘겨줄 식자재 납품업자라면, 그 플레이팅은 전부 낭비입니다. 창고에서 재료를 바로 가져가면 됩니다.

Raw Pipeline 플러그인이 하는 일이 바로 그것입니다. 창고에 직접 접근할 수 있게 해줍니다.

## em.query()와 뭐가 다른가

"이미 `em.query(sql)`로 raw 결과를 받을 수 있는데, 왜 플러그인이 필요한가?"라는 의문이 들 수 있습니다.

`em.query()`는 단일 SQL 문을 실행하고 모든 결과를 한 번에 반환합니다. 동작하지만, 두 가지 한계가 있습니다:

1. **배치 처리가 없습니다.** 쿼리가 50만 행을 반환하면, 50만 개의 객체가 동시에 메모리에 존재합니다. 점진적으로 처리할 방법이 없습니다.

2. **SQL을 직접 작성해야 합니다.** SQL 문자열을 직접 구성하고, 파라미터 바인딩을 관리하고, 테이블/컬럼 이름을 수동으로 처리해야 합니다. Entity 메타데이터, NamingStrategy, ORM의 WHERE 리졸버와의 연동이 없습니다.

Raw Pipeline은 이 공백을 메웁니다. Entity 메타데이터를 읽어 올바른 SQL을 생성하고(NamingStrategy 컬럼 매핑 포함), `em.find()`와 동일한 WHERE 리졸버를 사용하며(필터 문법이 완전히 같음), 설정 가능한 배치 크기로 결과를 스트리밍하여 메모리 사용량을 일정하게 유지합니다.

```
em.find()     → 전체 Entity 변환. 타입 안전. 대규모에서 느림.
em.query()    → 변환 없음. Raw SQL. 배치 없음.
em.pipe()     → 변환 없음. Entity 인식 SQL. 배치 스트리밍.
```

## 설치

Raw Pipeline은 플러그인입니다. 다른 플러그인과 동일한 방식으로 설치합니다:

```typescript
import { rawPipelinePlugin } from "@stingerloom/orm";

em.extend(rawPipelinePlugin());
```

`register()`의 `plugins` 배열로도 설치할 수 있습니다:

```typescript
await em.register({
  type: "postgres",
  // ... 연결 옵션
  entities: [User, Post],
  plugins: [rawPipelinePlugin()],
});
```

이렇게 하면 EntityManager에 `pipe()` 메서드가 추가됩니다. 플러그인을 설치하지 않고 `em.pipe()`를 호출하면 명확한 에러 메시지가 표시됩니다.

## 기본 사용법

### Raw 행 스트리밍

`pipe()`는 파이프라인을 생성합니다. `raw()`를 호출하면 일반 객체 배치를 yield하는 async generator를 받습니다. Entity 변환 없이, 클래스 인스턴스화 없이.

```typescript
const pipeline = em.pipe(User, {
  where: { active: true },
  batchSize: 5000,
});

for await (const batch of pipeline.raw()) {
  // batch는 Record<string, unknown>[]
  // 데이터베이스 드라이버에서 온 그대로의 일반 객체
  console.log(batch.length); // 배치당 최대 5,000행
}
```

각 배치는 컬럼 이름을 키로 가진 일반 JavaScript 객체 배열입니다. 파이프라인이 내부적으로 페이지네이션을 처리합니다 — `SELECT ... LIMIT 5000 OFFSET 0`을 실행하고, 다음은 `LIMIT 5000 OFFSET 5000`, 행이 없을 때까지 계속합니다.

### 배치 처리가 중요한 이유

100만 행을 한 번에 로드하면, Node.js가 100만 개의 객체를 동시에 메모리에 올려야 합니다. 배치 처리를 사용하면 한 번에 하나의 배치(예: 5,000행)만 메모리에 존재합니다. 각 배치를 처리하고 해제하면, 가비지 컬렉터가 메모리를 회수합니다.

```typescript
// 나쁜 방법: 전체를 한 번에 메모리에 올림
const allRows = await em.find(User); // 100만 행 → 메모리 부족

// 좋은 방법: 5,000행씩 처리
for await (const batch of em.pipe(User, { batchSize: 5000 }).raw()) {
  await sendToExternalService(batch);
  // 이번 이터레이션이 끝나면 batch가 해제됨
}
```

### WHERE 조건 — em.find()와 동일한 문법

파이프라인의 `where` 옵션은 `em.find()`와 완전히 동일한 리졸버를 사용합니다. 모든 필터 연산자가 그대로 동작합니다:

```typescript
// 단순 등호
em.pipe(User, { where: { role: "admin" } })

// 비교 연산자
em.pipe(User, { where: { age: { gte: 18, lt: 65 } } })

// 문자열 연산자
em.pipe(User, { where: { name: { contains: "alice" } } })
em.pipe(User, { where: { email: { startsWith: "admin" } } })
em.pipe(User, { where: { bio: { ilike: "%engineer%" } } })  // PostgreSQL 전용

// 논리 조합
em.pipe(User, {
  where: {
    OR: [
      { status: "active" },
      { role: "admin" },
    ],
  },
})

// NOT
em.pipe(User, {
  where: {
    NOT: { status: "banned" },
  },
})

// IN / NOT IN
em.pipe(User, { where: { id: { in: [1, 2, 3] } } })

// NULL 체크
em.pipe(User, { where: { deletedAt: { isNull: true } } })

// BETWEEN
em.pipe(Order, { where: { total: { between: [100, 500] } } })

// 전문 검색 (MySQL: MATCH AGAINST, PostgreSQL: to_tsvector)
em.pipe(Post, { where: { content: { search: "typescript orm" } } })
```

중요한 점은 파이프라인이 코어 `WhereResolver`에 위임한다는 것입니다. `em.find()`와의 동작 차이가 전혀 없습니다.

### NamingStrategy 지원

`NamingStrategy`(예: `SnakeNamingStrategy`)를 사용하면, 파이프라인이 프로퍼티 이름을 데이터베이스 컬럼 이름으로 자동 매핑합니다:

```typescript
// SnakeNamingStrategy를 사용하는 Entity:
//   firstName (프로퍼티) → first_name (컬럼)
//   lastName  (프로퍼티) → last_name  (컬럼)

em.pipe(User, {
  where: { firstName: "Alice" },      // → WHERE "first_name" = 'Alice'
  select: ["firstName", "lastName"],   // → SELECT "first_name", "last_name"
  orderBy: { firstName: "ASC" },       // → ORDER BY "first_name" ASC
})
```

## 페이지네이션 전략

파이프라인은 두 가지 페이지네이션 전략을 지원합니다. 데이터 규모에 따라 적절한 것을 선택하세요.

### LIMIT/OFFSET (기본값)

기본 전략은 각 배치 쿼리에 `LIMIT N OFFSET M`을 붙입니다:

```
Batch 1:  SELECT * FROM "user" WHERE ... LIMIT 5000 OFFSET 0
Batch 2:  SELECT * FROM "user" WHERE ... LIMIT 5000 OFFSET 5000
Batch 3:  SELECT * FROM "user" WHERE ... LIMIT 5000 OFFSET 10000
...
```

소규모~중규모 데이터셋(~100K행 이하)에서 잘 동작합니다. 하지만 offset이 커질수록, 데이터베이스가 스킵할 모든 행을 스캔해야 합니다. offset 1,000,000이면, 데이터베이스가 1,000,000행을 스캔한 후 버립니다.

### Keyset 페이지네이션

Keyset 페이지네이션이 이 문제를 해결합니다. "N행을 건너뛰세요"라고 말하는 대신, "마지막으로 본 값 이후의 행을 주세요"라고 합니다. 데이터베이스가 인덱스를 써서 바로 해당 위치로 점프할 수 있습니다.

```
Batch 1:  SELECT * FROM "user" WHERE ... ORDER BY "id" ASC LIMIT 5000
Batch 2:  SELECT * FROM "user" WHERE ... AND "id" > 5000 ORDER BY "id" ASC LIMIT 5000
Batch 3:  SELECT * FROM "user" WHERE ... AND "id" > 10000 ORDER BY "id" ASC LIMIT 5000
...
```

`keyset: true`로 활성화합니다:

```typescript
for await (const batch of em.pipe(User, {
  orderBy: { id: "ASC" },
  keyset: true,
  batchSize: 5000,
}).raw()) {
  process(batch);
}
```

파이프라인이 각 배치의 마지막 값을 자동으로 추적하고 다음 쿼리의 WHERE 조건으로 주입합니다. 커서를 직접 관리할 필요가 없습니다.

::: tip Keyset을 쓸 때
다음 경우에 `keyset: true`를 사용하세요:
- 전체 데이터셋이 대규모 (100K행 이상)
- `orderBy` 컬럼에 인덱스가 있을 때
- 테이블 전체 또는 대규모 부분집합을 순회할 때

기본값(LIMIT/OFFSET)을 사용하세요:
- 전체 데이터셋이 작을 때
- 임의 페이지 점프가 필요할 때 (keyset은 앞으로만 이동 가능)
- 여러 컬럼으로 정렬할 때 (keyset은 현재 단일 컬럼만 지원)
:::

## 변환 체이닝

### map()

`.map()`을 체이닝해서 각 행을 yield하기 전에 변환할 수 있습니다. 필요한 필드만 선택하거나, 키 이름을 바꾸거나, 타입을 변환할 때 유용합니다.

```typescript
const pipeline = em.pipe(User, { batchSize: 5000 });

for await (const batch of pipeline.map(row => ({
  userId: row.id,
  displayName: row.name,
  email: row.email,
})).raw()) {
  // batch는 { userId, displayName, email }[]
  sendToGrpc(batch);
}
```

`.map()`을 여러 번 체이닝할 수도 있습니다. 각 변환은 내부적으로 하나의 함수로 합쳐지므로, 중간 배열 할당이 없습니다:

```typescript
const csvLines = await em.pipe(User)
  .map(row => ({ id: row.id, name: row.name }))
  .map(row => `${row.id},${row.name}`)
  .collect();
// csvLines는 string[]
```

### filter()

`.filter()`를 체이닝해서 조건에 맞지 않는 행을 제거할 수 있습니다. 이 필터는 행을 가져온 후 JavaScript에서 실행됩니다. SQL 쿼리를 수정하지 않습니다.

```typescript
const activeAdults = await em.pipe(User)
  .map(row => ({
    id: row.id as number,
    age: row.age as number,
    active: row.active as boolean,
  }))
  .filter(row => row.active && row.age >= 18)
  .collect();
```

::: tip filter() vs where
가능하면 `where`를 사용하세요 — 데이터베이스에서 필터링하므로 전송되는 데이터량이 줄어듭니다. `.filter()`는 SQL로 표현할 수 없는 조건, 예를 들어 복잡한 JavaScript 로직이나 필드 간 계산에만 사용하세요.

```typescript
// 좋은 방법: 데이터베이스에서 필터링
em.pipe(User, { where: { active: true, age: { gte: 18 } } })

// filter()는 SQL로 표현 불가능한 복잡한 JS 로직에 사용
em.pipe(User).filter(row => someComplexJsFunction(row))
```
:::

### collect()

`collect()`는 모든 배치를 하나의 배열로 모으는 편의 메서드입니다. 전체 데이터가 메모리에 들어갈 때 쓰면 됩니다.

```typescript
const allRows = await em.pipe(User, { where: { active: true } }).collect();
// allRows는 Record<string, unknown>[]
```

::: warning
`collect()`는 모든 데이터를 메모리에 올립니다. 대규모 데이터셋에서는 `for await`로 반복 처리하세요.
:::

## Binary 모드

`binary()`는 한 단계 더 깊이 들어갑니다. 드라이버의 일반적인 파싱(wire 데이터를 JavaScript 객체로 변환) 대신, 데이터베이스 드라이버에서 raw buffer나 배열 형식 결과를 직접 요청합니다.

```typescript
for await (const batch of em.pipe(User, { batchSize: 5000 }).binary()) {
  // pg: 각 행 값이 Buffer (바이너리 wire 포맷)
  // mysql2: 각 행 값이 Buffer (typeCast 비활성화)
  // sqlite: raw()와 동일 (SQLite에는 바이너리 wire 포맷이 없음)
}
```

배열 모드도 요청할 수 있습니다. 키가 있는 객체 대신 배열로 행을 반환합니다:

```typescript
for await (const batch of em.pipe(User).binary({ arrayMode: true })) {
  // 각 행이 { col1: value1, ... } 대신 [value1, value2, value3, ...]
  // 객체 키 할당이 없으므로 메모리가 줄고, GC 부하가 낮아짐
}
```

Binary 모드도 keyset 페이지네이션을 지원합니다:

```typescript
for await (const batch of em.pipe(User, {
  orderBy: { id: "ASC" },
  keyset: true,
  batchSize: 10000,
}).binary({ arrayMode: true })) {
  // 최대 처리량: keyset + 배열 모드
}
```

### 드라이버별 동작

| 옵션 | PostgreSQL (pg) | MySQL (mysql2) | SQLite (better-sqlite3) |
|------|----------------|----------------|------------------------|
| `binary: true` | 쿼리 설정에 `binary: true` 적용. 컬럼 값이 PostgreSQL 네이티브 바이너리 포맷의 `Buffer`로 도착. | `typeCast: false` 적용. 모든 컬럼이 타입 변환 없이 raw `Buffer`로 반환. | 효과 없음. BLOB 컬럼은 이미 `Buffer`. |
| `arrayMode: true` | `rowMode: 'array'` 적용. 행이 컬럼 순서의 `any[]`. | `rowsAsArray: true` 적용. | `stmt.raw().all()` 사용. |

### Binary 모드를 쓸 때

Binary 모드는 다음과 같은 경우에 가장 유용합니다:
- 바이너리를 받는 다른 시스템으로 데이터를 전달할 때 (protobuf, MessagePack)
- 메모리 할당을 최소화할 때 (배열 모드는 객체 키 문자열을 피함)
- BLOB 컬럼을 이중 파싱 없이 처리할 때

Entity 변환 없이 일반 객체만 필요하다면, `raw()`로 충분하고 다루기도 더 쉽습니다.

## count()

파이프라인의 WHERE 조건에 맞는 행 수를 조회합니다:

```typescript
const pipeline = em.pipe(User, { where: { active: true } });
const total = await pipeline.count();
console.log(`활성 사용자: ${total}`);
```

`count()` 메서드는 `raw()`와 동일한 WHERE 조건을 적용합니다. `where: { active: true }`로 파이프라인을 만들면, `count()`도 활성 사용자 수만 반환합니다.

```typescript
const pipeline = em.pipe(Order, {
  where: {
    status: "pending",
    total: { gte: 100 },
  },
});

const pendingCount = await pipeline.count();
console.log(`$100 이상 미결제 주문 ${pendingCount}건`);

for await (const batch of pipeline.raw()) {
  // count된 것과 동일한 행을 처리
}
```

## 성능 벤치마크

행당 6개 컬럼이 있는 SQLite 인메모리 데이터베이스에서 4가지 방식을 측정했습니다. 각 방식을 5회 실행하고 중앙값을 보고합니다.

### 1,000행

| 방식 | 시간 | 메모리 | 처리량 |
|------|------|--------|--------|
| `em.find()` | 6.5ms | 8.79 MB | 153,579 rows/s |
| `em.query()` | 0.6ms | 0.69 MB | 1,626,016 rows/s |
| `pipe().raw()` | 1.0ms | 0.74 MB | 988,631 rows/s |
| `pipe().binary()` | 0.5ms | 0.28 MB | 2,095,338 rows/s |

### 10,000행

| 방식 | 시간 | 메모리 | 처리량 |
|------|------|--------|--------|
| `em.find()` | 36.6ms | 18.80 MB | 272,947 rows/s |
| `em.query()` | 3.8ms | 6.74 MB | 2,610,114 rows/s |
| `pipe().raw()` | 5.6ms | 7.19 MB | 1,794,299 rows/s |
| `pipe().binary()` | 3.6ms | 2.88 MB | 2,772,644 rows/s |

### 100,000행

| 방식 | 시간 | 메모리 | 처리량 |
|------|------|--------|--------|
| `em.find()` | 319.5ms | 83.12 MB | 313,015 rows/s |
| `em.query()` | 110.2ms | 67.15 MB | 907,842 rows/s |
| `pipe().raw()` | 102.6ms | 64.55 MB | 974,222 rows/s |
| **`pipe().binary()`** | **76.7ms** | **27.25 MB** | **1,303,337 rows/s** |

### 수치가 말해주는 것

100,000행 기준:

- **`pipe().binary()`는 `em.find()`보다 4.2배 빠르고**, 메모리를 67% 적게 사용합니다.
- **`pipe().raw()`는 `em.find()`보다 3.1배 빠르고**, 메모리를 22% 적게 사용합니다.
- `em.query()`도 `pipe().raw()`와 비슷한 속도이지만, `pipe()`는 배치 스트리밍을 추가해서 전체 행 수에 관계없이 메모리를 일정하게 유지합니다.

행이 많아질수록 격차가 벌어집니다. 1,000행에서는 오버헤드가 무시할 수준이니 `em.find()`를 쓰고 타입 안전성을 누리세요. 100,000행 이상에서 Raw Pipeline의 진가가 발휘됩니다.

### 벤치마크 재현 방법

```bash
NODE_OPTIONS="--expose-gc" npx ts-node --project __tests__/bench/tsconfig.json __tests__/bench/raw-pipeline-bench.ts
```

## 상황별 선택 가이드

| 상황 | 방식 | 이유 |
|------|------|------|
| 일반 CRUD, 10K행 이하 | `em.find()` | 완전한 타입 안전성, 관계 로딩, 트랜스포머. 오버헤드 무시할 수준. |
| 리포트, 집계, 100K행 이하 | `em.query()` 또는 `pipe().raw()` | Entity 오버헤드 제거. 배치가 필요하면 `pipe()`. |
| 대규모 내보내기 (CSV, JSON lines) | `pipe().raw()` + `keyset: true` | 메모리 일정. Keyset으로 속도 유지. |
| gRPC / protobuf 전달 | `pipe().binary()` | 최소 할당. 배열 모드로 객체 키 문자열 제거. |
| 데이터 웨어하우스로 ETL | `pipe().raw()` + `.map()` | 변환 체인으로 중간 배열 없이 데이터 재구성. |
| 필터된 행 수 조회 | `pipe().count()` | 파이프라인과 동일한 WHERE 사용. |

## 실전 패턴

### ETL CSV 내보내기

```typescript
import { createWriteStream } from "fs";

const out = createWriteStream("users.csv");
out.write("id,name,email,age\n");

for await (const batch of em.pipe(User, {
  orderBy: { id: "ASC" },
  keyset: true,
  batchSize: 10000,
}).raw()) {
  for (const row of batch) {
    out.write(`${row.id},${row.name},${row.email},${row.age}\n`);
  }
}

out.end();
```

### gRPC 스트림 전송

```typescript
for await (const batch of em.pipe(Order, {
  where: { status: "pending" },
  orderBy: { id: "ASC" },
  keyset: true,
  batchSize: 1000,
}).map(row => ({
  orderId: String(row.id),
  amount: Number(row.amount),
  currency: String(row.currency),
})).raw()) {
  for (const item of batch) {
    grpcStream.write(OrderProto.encode(item).finish());
  }
}
```

### 메모리 제한 집계

```typescript
let total = 0;
let count = 0;

for await (const batch of em.pipe(SensorReading, {
  where: { timestamp: { gte: new Date("2026-01-01") } },
  batchSize: 50000,
}).raw()) {
  for (const row of batch) {
    total += Number(row.value);
    count++;
  }
}

console.log(`평균: ${total / count}`);
```

### 처리 전 필터된 건수 확인

```typescript
const pipeline = em.pipe(Invoice, {
  where: { status: "unpaid", dueDate: { lt: new Date() } },
  orderBy: { dueDate: "ASC" },
  keyset: true,
  batchSize: 5000,
});

const overdue = await pipeline.count();
console.log(`연체 청구서 ${overdue}건 처리 중...`);

let processed = 0;
for await (const batch of pipeline.raw()) {
  await sendReminders(batch);
  processed += batch.length;
  console.log(`${processed}/${overdue}`);
}
```

### Node.js Readable Stream 연동

`raw()`가 반환하는 async generator는 `Readable.from()`과 호환됩니다:

```typescript
import { Readable } from "stream";
import { pipeline as streamPipeline } from "stream/promises";
import { createGzip } from "zlib";
import { createWriteStream } from "fs";

const generator = em.pipe(User, {
  orderBy: { id: "ASC" },
  keyset: true,
  batchSize: 5000,
}).map(row => JSON.stringify(row) + "\n").raw();

// 배치를 개별 행으로 평탄화
async function* flatten(source: AsyncGenerator<string[]>) {
  for await (const batch of source) {
    for (const line of batch) {
      yield line;
    }
  }
}

await streamPipeline(
  Readable.from(flatten(generator)),
  createGzip(),
  createWriteStream("users.jsonl.gz"),
);
```

## API 레퍼런스

### `rawPipelinePlugin()`

플러그인을 생성하는 팩토리 함수입니다. `em.extend()`로 설치합니다.

```typescript
import { rawPipelinePlugin } from "@stingerloom/orm";

em.extend(rawPipelinePlugin());
```

### `em.pipe(entity, options?)`

| 파라미터 | 타입 | 기본값 | 설명 |
|---------|------|--------|------|
| `entity` | `ClazzType<T>` | *(필수)* | Entity 클래스 (테이블 이름 및 컬럼 해석에 사용) |
| `options.where` | `WhereClause<T>` | — | 필터 조건 (`em.find()`와 동일한 문법) |
| `options.orderBy` | `OrderByOption<T>` | — | 정렬 순서 (NamingStrategy 적용) |
| `options.select` | `string[]` | `*` | 선택할 컬럼 (NamingStrategy 적용) |
| `options.batchSize` | `number` | `1000` | 배치당 행 수 (최소: 1) |
| `options.keyset` | `boolean` | `false` | LIMIT/OFFSET 대신 keyset 페이지네이션 사용. `orderBy` 필요. |

`RawPipeline<T>`을 반환합니다.

### `RawPipeline<T>`

| 메서드 | 반환 | 설명 |
|--------|------|------|
| `raw()` | `AsyncGenerator<Record<string, unknown>[]>` | 일반 객체 배치를 yield |
| `binary(opts?)` | `AsyncGenerator<any[]>` | 드라이버 레벨 옵션으로 배치 yield |
| `map(fn)` | `MappedPipeline<U>` | 행 변환 체이닝 |
| `filter(fn)` | `MappedPipeline<Record<string, unknown>>` | JS predicate로 행 필터링 |
| `collect()` | `Promise<Record<string, unknown>[]>` | 모든 배치를 하나의 배열로 수집 |
| `count()` | `Promise<number>` | 파이프라인의 WHERE 조건에 맞는 행 수 |

### `MappedPipeline<U>`

| 메서드 | 반환 | 설명 |
|--------|------|------|
| `raw()` | `AsyncGenerator<U[]>` | 변환된 배치를 yield |
| `map(fn)` | `MappedPipeline<V>` | 추가 변환 체이닝 |
| `filter(fn)` | `FilteredMappedPipeline<U>` | 변환된 행 필터링 |
| `collect()` | `Promise<U[]>` | 모든 배치를 하나의 배열로 수집 |

### `DriverQueryOptions`

| 옵션 | 타입 | 기본값 | 설명 |
|------|------|--------|------|
| `binary` | `boolean` | `true` | 드라이버에서 바이너리 포맷 결과를 요청 |
| `arrayMode` | `boolean` | `false` | 객체 대신 배열로 행을 반환 |

## 내부 동작

### SQL 생성 방식

파이프라인은 SQL 생성을 새로 구현하지 않습니다. 두 가지 코어 ORM 모듈을 재사용합니다:

1. **`WhereResolver`** — `em.find()`, `em.update()`, `em.softDelete()`가 사용하는 것과 동일한 모듈입니다. 따라서 모든 WHERE 연산자(`contains`, `ilike`, `search`, `OR`, `AND`, `NOT`, `between`)가 동일하게 동작합니다.

2. **Entity 메타데이터** — 컬럼 이름, property-to-column 매핑(NamingStrategy), 테이블 이름은 모두 `Reflect.getMetadata()`에서 Entity 클래스당 한 번만 읽고 `WeakMap`에 캐싱합니다.

### SelectQueryBuilder를 안 쓰는 이유

SelectQueryBuilder는 Entity 인스턴스를 반환하는 타입 안전 쿼리를 위해 설계되었습니다. SQL 생성과 결과 변환, 관계 로딩이 얽혀 있습니다. Raw Pipeline은 변환 *없는* SQL 생성이 필요한데, 이는 근본적으로 다른 실행 경로입니다.

Entity 메타데이터에서 직접 SQL을 구성함으로써, 전체 QueryBuilder 체인을 만드는 오버헤드를 피하고, 스트리밍 사용 사례(배치 페이지네이션, keyset 커서)에 특화된 최적화가 가능합니다.

## 다음 단계

- [플러그인](./plugins.md) — 플러그인 시스템의 동작 원리
- [Raw SQL & CTE](./raw-sql.md) — SQL 전체 제어가 필요할 때
- [페이지네이션 & 스트리밍](./pagination.md) — Entity 레벨 스트리밍 `em.stream()`
- [API 레퍼런스](./api-reference.md) — 전체 메서드 시그니처
