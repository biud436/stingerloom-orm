# Raw Pipeline

## 왜 Entity 변환이 비용인가

`em.find(User)`를 호출하면 내부에서 많은 일이 벌어집니다. ORM이 SQL 쿼리를 보내고, 데이터베이스 드라이버가 행을 수신하고, 그 행을 하나씩 타입이 지정된 Entity 인스턴스로 변환합니다. 컬럼 이름을 다시 매핑하고, 컬럼 트랜스포머를 적용하고, 객체를 역직렬화하고, 관계를 로딩합니다.

100행이면 눈에 띄지 않습니다. 100,000행이면 병목이 됩니다.

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

이렇게 하면 EntityManager에 `pipe()` 메서드가 추가됩니다.

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

`.map()`을 여러 번 체이닝할 수도 있습니다:

```typescript
const csvLines = await em.pipe(User)
  .map(row => ({ id: row.id, name: row.name }))
  .map(row => `${row.id},${row.name}`)
  .collect();
// csvLines는 string[]
```

### filter()

`.map()` 뒤에 `.filter()`를 체이닝해서 조건에 맞지 않는 행을 제거할 수 있습니다:

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

파이프라인의 Entity 테이블에 해당하는 전체 행 수를 조회합니다:

```typescript
const pipeline = em.pipe(User);
const total = await pipeline.count();
console.log(`전체 사용자 수: ${total}`);
```

## 성능 벤치마크

행당 6개 컬럼이 있는 SQLite 인메모리 데이터베이스에서 4가지 방식을 측정했습니다. 각 방식을 5회 실행하고 중앙값을 보고합니다.

### 1,000행

| 방식 | 시간 | 메모리 | 처리량 |
|------|------|--------|--------|
| `em.find()` | 6.8ms | 9.28 MB | 146,701 rows/s |
| `em.query()` | 0.7ms | 0.69 MB | 1,432,837 rows/s |
| `pipe().raw()` | 0.9ms | 0.74 MB | 1,137,442 rows/s |
| `pipe().binary()` | 0.4ms | 0.28 MB | 2,225,521 rows/s |

### 10,000행

| 방식 | 시간 | 메모리 | 처리량 |
|------|------|--------|--------|
| `em.find()` | 42.0ms | 20.19 MB | 238,334 rows/s |
| `em.query()` | 4.8ms | 6.74 MB | 2,097,096 rows/s |
| `pipe().raw()` | 5.6ms | 7.18 MB | 1,800,315 rows/s |
| `pipe().binary()` | 5.5ms | 2.79 MB | 1,833,573 rows/s |

### 100,000행

| 방식 | 시간 | 메모리 | 처리량 |
|------|------|--------|--------|
| `em.find()` | 388.9ms | 84.81 MB | 257,120 rows/s |
| `em.query()` | 121.8ms | 67.15 MB | 821,264 rows/s |
| `pipe().raw()` | 111.1ms | 64.48 MB | 900,467 rows/s |
| **`pipe().binary()`** | **88.0ms** | **27.14 MB** | **1,136,339 rows/s** |

### 수치가 말해주는 것

100,000행 기준:

- **`pipe().binary()`는 `em.find()`보다 4.4배 빠르고**, 메모리를 68% 적게 사용합니다.
- **`pipe().raw()`는 `em.find()`보다 3.5배 빠르고**, 메모리를 24% 적게 사용합니다.
- `em.query()`도 이미 빠르지만(Entity 변환을 건너뛰니까), `pipe()`는 배치 스트리밍을 추가해서 전체 행 수에 관계없이 메모리를 일정하게 유지합니다.

행이 많아질수록 격차가 벌어집니다. 1,000행에서는 오버헤드가 무시할 수준이니 `em.find()`를 쓰고 타입 안전성을 누리세요. 100,000행 이상에서 Raw Pipeline의 진가가 발휘됩니다.

### 벤치마크 재현 방법

```bash
NODE_OPTIONS="--expose-gc" npx ts-node __tests__/bench/raw-pipeline-bench.ts
```

## 실전 패턴

### ETL CSV 내보내기

```typescript
import { createWriteStream } from "fs";

const out = createWriteStream("users.csv");
out.write("id,name,email,age\n");

for await (const batch of em.pipe(User, { batchSize: 10000 }).raw()) {
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

for await (const batch of em.pipe(SensorReading, { batchSize: 50000 }).raw()) {
  for (const row of batch) {
    total += Number(row.value);
    count++;
  }
}

console.log(`평균: ${total / count}`);
```

## API 레퍼런스

### `rawPipelinePlugin()`

플러그인을 생성하는 팩토리 함수입니다. `em.extend()`로 설치합니다.

```typescript
import { rawPipelinePlugin } from "@stingerloom/orm";

em.extend(rawPipelinePlugin());
```

### `em.pipe(entity, options?)`

| 파라미터 | 타입 | 설명 |
|---------|------|------|
| `entity` | `ClazzType<T>` | Entity 클래스 (테이블 이름 해석에 사용) |
| `options.where` | `WhereClause<T>` | 필터 조건 (`em.find()`와 동일한 문법) |
| `options.orderBy` | `OrderByOption<T>` | 정렬 순서 |
| `options.select` | `string[]` | 선택할 컬럼 (기본값: `*`) |
| `options.batchSize` | `number` | 배치당 행 수 (기본값: 1000, 최소: 1) |

`RawPipeline<T>`을 반환합니다.

### `RawPipeline<T>`

| 메서드 | 반환 | 설명 |
|--------|------|------|
| `raw()` | `AsyncGenerator<Record<string, unknown>[]>` | 일반 객체 배치를 yield |
| `binary(opts?)` | `AsyncGenerator<any[]>` | 드라이버 레벨 옵션으로 배치 yield |
| `map(fn)` | `MappedPipeline<U>` | 행 변환 체이닝 |
| `filter(fn)` | `MappedPipeline<Record<string, unknown>>` | 조건에 따라 행 필터링 |
| `collect()` | `Promise<Record<string, unknown>[]>` | 모든 배치를 하나의 배열로 수집 |
| `count()` | `Promise<number>` | Entity 테이블의 전체 행 수 |

### `MappedPipeline<U>`

| 메서드 | 반환 | 설명 |
|--------|------|------|
| `raw()` | `AsyncGenerator<U[]>` | 변환된 배치를 yield |
| `map(fn)` | `MappedPipeline<V>` | 추가 변환 체이닝 |
| `filter(fn)` | `FilteredMappedPipeline<U>` | 변환된 행 필터링 |
| `collect()` | `Promise<U[]>` | 모든 배치를 하나의 배열로 수집 |

### `DriverQueryOptions`

| 옵션 | 타입 | 설명 |
|------|------|------|
| `binary` | `boolean` | 드라이버에서 바이너리 포맷 결과를 요청 |
| `arrayMode` | `boolean` | 객체 대신 배열로 행을 반환 |

## 다음 단계

- [플러그인](./plugins.md) -- 플러그인 시스템의 동작 원리
- [Raw SQL & CTE](./raw-sql.md) -- SQL 전체 제어가 필요할 때
- [페이지네이션 & 스트리밍](./pagination.md) -- Entity 레벨 스트리밍 `em.stream()`
