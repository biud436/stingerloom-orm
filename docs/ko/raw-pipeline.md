# Raw Pipeline

## 엔티티 변환의 비용

`em.find(User)`를 호출하면 내부에서 많은 일이 일어납니다. ORM은 SQL 쿼리를 보내고 데이터베이스 드라이버에서 행을 받습니다. 그리고 각 행을 타입이 지정된 엔티티 인스턴스로 변환합니다. 이 변환에는 여러 작업이 들어갑니다. 컬럼 이름을 다시 매핑하고 컬럼 트랜스포머를 적용합니다. 객체를 역직렬화하고 관계도 로드합니다.

행이 100개일 때는 이 비용이 드러나지 않습니다. 하지만 100,000개가 되면 병목이 됩니다.

일반적인 `em.find()` 호출의 데이터 흐름은 다음과 같습니다.

```
데이터베이스 wire protocol
    → pg/mysql2/sqlite가 JS 객체로 파싱         (드라이버 레이어)
    → ResultTransformer가 컬럼 이름 재매핑       (ORM 레이어)
    → deserializeEntity()가 클래스 인스턴스 생성   (ORM 레이어)
    → applyColumnTransforms()가 변환기 실행       (ORM 레이어)
    → RelationLoader가 eager/lazy 관계 해석      (ORM 레이어)
    → 타입이 지정된 엔티티 인스턴스를 받음          (코드)
```

드라이버 레이어 다음의 단계는 모두 오버헤드입니다. 데이터를 gRPC 서비스로 보내거나 CSV로 내보낼 때는 엔티티 인스턴스가 필요 없습니다. ETL 파이프라인에 넣을 때도 마찬가지입니다. 이때 필요한 것은 가공하지 않은 데이터입니다. 이 데이터를 최대한 빠르게 받고 메모리도 최소한으로 써야 합니다.

식당에 비유해 봅시다. 주방은 ORM이고 원재료는 데이터베이스 행입니다. 요리는 엔티티 인스턴스입니다. 보통은 주방이 원재료로 요리를 만들고 접시에 보기 좋게 담습니다. 그런데 식자재 납품업자는 재료를 다른 주방에 넘기기만 하면 됩니다. 이 사람에게 요리를 보기 좋게 담는 일은 전부 헛수고입니다. 창고에서 재료를 바로 가져가는 편이 낫습니다.

Raw Pipeline 플러그인이 바로 이 일을 합니다. 창고에 직접 접근하게 해 줍니다.

## em.query()와의 차이

"`em.query(sql)`로도 raw 결과를 받을 수 있는데 플러그인이 왜 필요한가요?"라는 의문이 들 수 있습니다.

`em.query()`는 SQL 문 하나를 실행하고 결과를 한 번에 모두 반환합니다. 동작은 하지만 한계가 두 가지 있습니다.

1. **배치 처리가 없습니다.** 쿼리가 행 50만 개를 반환하면 객체 50만 개가 동시에 메모리에 올라갑니다. 이 객체들을 조금씩 나눠 처리하는 기능은 기본으로 제공하지 않습니다.

2. **SQL을 직접 작성해야 합니다.** SQL 문자열을 직접 만들고 파라미터 바인딩도 직접 관리합니다. 테이블 이름과 컬럼 이름도 손으로 처리해야 합니다. 엔티티 메타데이터, 네이밍 전략, ORM의 WHERE 리졸버와도 연동되지 않습니다.

Raw Pipeline은 이 빈틈을 메웁니다. 엔티티 메타데이터를 읽어 올바른 SQL을 생성합니다. 이 SQL에는 네이밍 전략의 컬럼 매핑도 반영됩니다. WHERE 리졸버는 `em.find()`와 같은 것을 씁니다. 그래서 필터 문법이 완전히 같습니다. 결과는 배치 크기를 정해 스트리밍하므로 메모리 사용량이 일정한 범위를 넘지 않습니다.

```
em.find()     → 전체 엔티티 변환. 타입 안전. 대규모에서 느림.
em.query()    → 변환 없음. Raw SQL. 배치 없음.
em.pipe()     → 변환 없음. 엔티티 인식 SQL. 배치 스트리밍.
```

## 설치

Raw Pipeline은 플러그인입니다. 다른 플러그인과 같은 방식으로 설치합니다.

```typescript
import { rawPipelinePlugin } from "@stingerloom/orm";

em.extend(rawPipelinePlugin());
```

`register()`의 `plugins` 배열로 설치해도 됩니다.

```typescript
await em.register({
  type: "postgres",
  // ... 연결 옵션
  entities: [User, Post],
  plugins: [rawPipelinePlugin()],
});
```

이렇게 하면 EntityManager에 `pipe()` 메서드가 추가됩니다. 플러그인을 설치하지 않고 `em.pipe()`를 호출하면 ORM이 에러를 던집니다. 이 에러 메시지에는 해야 할 일이 분명하게 적혀 있습니다.

## 기본 사용법

### Raw 행 스트리밍

`pipe()`는 파이프라인을 생성합니다. `raw()`를 호출하면 async generator를 받습니다. 이 generator는 일반 객체의 배치를 yield합니다. 엔티티 변환도 클래스 인스턴스화도 하지 않습니다.

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

각 배치는 컬럼 이름을 키로 가진 일반 JavaScript 객체의 배열입니다. 페이지네이션은 파이프라인이 내부에서 처리합니다. 먼저 `SELECT ... LIMIT 5000 OFFSET 0`을 실행하고 다음에는 `LIMIT 5000 OFFSET 5000`을 실행합니다. 이렇게 더 반환할 행이 없을 때까지 계속합니다.

### 배치 처리가 중요한 이유

행 100만 개를 한 번에 로드하면 Node.js는 객체 100만 개를 동시에 메모리에 들고 있어야 합니다. 배치로 처리하면 메모리에는 한 번에 배치 하나만 있습니다(예: 5,000행). 각 배치를 처리하고 해제하면 가비지 컬렉터가 메모리를 회수합니다.

```typescript
// 나쁜 방법: 전체를 한 번에 메모리에 올림
const allRows = await em.find(User); // 100만 행 → 메모리 부족

// 좋은 방법: 5,000행씩 처리
for await (const batch of em.pipe(User, { batchSize: 5000 }).raw()) {
  await sendToExternalService(batch);
  // 이번 이터레이션이 끝나면 batch가 해제됨
}
```

### WHERE 조건: em.find()와 같은 문법

파이프라인의 `where` 옵션은 `em.find()`와 완전히 같은 리졸버를 씁니다. 그래서 모든 필터 연산자가 똑같이 동작합니다.

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

중요한 점은 파이프라인이 WHERE 처리를 코어 `WhereResolver`에 맡긴다는 것입니다. 그래서 `em.find()`와 동작이 전혀 다르지 않습니다.

이름 검사도 `find()`와 같은 방식으로 합니다. 검사 시점은 파이프라인을 생성할 때입니다. 컬럼이나 연산자 이름을 잘못 쓰면 `find()`와 같은 메시지로 거부됩니다. 그래서 잘못된 이름이 드라이버까지 가서 다이얼렉트마다 다른 에러로 실패하지 않습니다.

```typescript
em.pipe(User, { where: { nmae: "Alice" } });
// InvalidQueryError: Unknown column "nmae" in "where" for entity "User".
// Suggestion: Valid columns: id, name, email, ...

em.pipe(User, { where: { email: { isNotNull: true } } });
// InvalidQueryError: Invalid where for entity "User":
//   unknown operator "isNotNull" on "email" (where.email). Did you mean "isNull"?
```

`orderBy`와 `select`도 같은 방식으로 검사합니다.

### NamingStrategy 지원

`SnakeNamingStrategy` 같은 `NamingStrategy`를 쓰면 파이프라인이 속성 이름을 데이터베이스 컬럼 이름으로 자동 매핑합니다.

```typescript
// SnakeNamingStrategy를 쓰는 엔티티:
//   firstName (속성) → first_name (컬럼)
//   lastName  (속성) → last_name  (컬럼)

em.pipe(User, {
  where: { firstName: "Alice" },      // → WHERE "first_name" = 'Alice'
  select: ["firstName", "lastName"],   // → SELECT "first_name", "last_name"
  orderBy: { firstName: "ASC" },       // → ORDER BY "first_name" ASC
})
```

`@ManyToOne` / `@OneToOne` 관계의 외래 키 속성도 `find()`처럼 조인 컬럼으로 풀립니다. 예를 들어 `where: { authorId: 1 }`은 `author_id`로 거릅니다.

### 멀티테넌시

파이프라인은 활성 테넌트 기준으로 읽습니다. 그래서 `em.find()`와 같은 행을 반환합니다.

- **`tenant_column`**: 모든 배치와 `count()`에 `tenant_id = ?` 조건이 붙습니다. 이 조건은 넘긴 `where`와 AND로 묶입니다. `MetadataContext.runUnscoped()`, `"public"` 컨텍스트, `@NonTenantEntity()`에서는 `find()`와 마찬가지로 이 조건이 빠집니다. 테넌트 컨텍스트가 없으면 `tenantOnMissingContext` 정책을 따릅니다. 그래서 정책이 `"throw"`이면 첫 배치에서 거부됩니다.
- **`search_path`** (PostgreSQL 기본값): ORM은 `find()`를 실행하는 트랜잭션 안에서 `SET LOCAL search_path`로 테넌트 스키마를 고릅니다. 파이프라인의 배치는 이 설정에 기대지 않습니다. 트랜잭션 밖의 배치는 `SET LOCAL`이 없는 풀의 연결에서 실행되기 때문입니다. 대신 테이블 이름에 스키마를 붙입니다. `SELECT * FROM "acme"."user"`가 그 형태입니다. `@Entity({ schema })`로 고정한 테이블은 그 스키마를 그대로 씁니다. 테넌트 ID가 올바른 식별자가 아니면 `find()`처럼 기본 스키마를 읽습니다.
- **`schema_qualified`**: 테이블 이름에 이미 테넌트 스키마가 붙어 있습니다.

```typescript
await MetadataContext.run("acme", async () => {
  const total = await em.pipe(Order).count(); // acme의 주문만
  for await (const batch of em.pipe(Order).raw()) {
    // acme의 행만
  }
});
```

테넌트는 순회가 첫 배치를 조회할 때 한 번만 읽습니다. 그래서 한 번의 순회 안에서 테넌트가 섞이지 않습니다. `count()`는 실행할 때 테넌트를 읽습니다.

### 상속 계층

엔티티가 상속 계층에 속해 있으면 파이프라인은 `em.find()`가 읽는 행을 읽습니다. 다만 행은 raw 행 그대로입니다.

| 엔티티 | 파이프라인이 읽는 것 |
|--------|---------------------|
| `SINGLE_TABLE` 자식 | 자기 서브타입만: 공유 테이블을 구분 컬럼(discriminator column)으로 거른 행 |
| `JOINED` 자식 | 자식 테이블을 루트 테이블과 조인한 행. 상속한 컬럼도 함께 반환되고 `where`·`select`·`orderBy`에 쓸 수 있습니다 |
| `TABLE_PER_CLASS` 루트 | 모든 구체 테이블을 `UNION ALL`로 합친 행. 각 행에는 계층의 모든 컬럼과 구분 컬럼이 들어 있습니다. 자기 테이블에 없는 컬럼은 `NULL`입니다. 서브클래스 속성으로 `where`를 걸 수 있습니다 |
| 그 밖의 엔티티(`SINGLE_TABLE`·`JOINED` 루트, `TABLE_PER_CLASS` 자식) | 자기 테이블 |

`JOINED` 루트는 자기 테이블을 읽습니다. 그래서 계층의 모든 행이 나오지만 컬럼은 루트의 컬럼만 있습니다.

`TABLE_PER_CLASS` 루트에 keyset 페이지네이션을 쓰면 기본 키 다음에 구분 컬럼으로도 정렬합니다. 구체 테이블마다 키를 따로 매기므로 같은 `id`가 여러 테이블에 나오기 때문입니다.

### 트랜잭션 안에서

트랜잭션 밖에서는 배치마다 풀의 연결에서 평범한 쿼리 하나를 실행합니다. 앞뒤로 `BEGIN`/`COMMIT`을 붙이지 않습니다. `em.transaction()`이나 `@Transactional` 메서드 안에서는 모든 배치가 그 트랜잭션의 연결에서 실행됩니다. 그래서 파이프라인도 트랜잭션의 나머지 코드와 같은 데이터를 읽습니다.

- **커밋 전 쓰기.** 트랜잭션 앞부분에서 저장한 행은 나옵니다. 삭제한 행은 나오지 않습니다. `count()`도 배치와 같은 수를 반환합니다.
- **하나의 스냅샷.** `REPEATABLE READ`나 `SERIALIZABLE`에서는 순회하는 도중 다른 연결이 커밋한 행이 중간에 끼어들지 않습니다.

```typescript
await em.transaction(async () => {
  await em.save(Order, { status: "pending", total: 120 });
  for await (const batch of em.pipe(Order).raw()) {
    // 위에서 저장한 주문도 포함
  }
});
```

`raw()`, `binary()`, keyset 페이지네이션은 모두 같은 규칙을 따릅니다. 연결은 순회가 첫 배치를 조회할 때 정해집니다. 그래서 한 번의 순회 안에서 연결이 바뀌지 않습니다. 순회는 트랜잭션이 끝나기 전에 마치세요. 커밋이나 롤백이 끝나면 연결이 풀로 돌아갑니다. 그러면 다음 배치가 실패합니다.

## 페이지네이션 전략

파이프라인은 두 가지 페이지네이션 전략을 지원합니다. 어느 전략이 맞는지는 순회할 데이터의 양에 달려 있습니다.

### LIMIT/OFFSET (기본값)

기본 전략은 각 배치 쿼리에 `LIMIT N OFFSET M`을 붙입니다.

```
Batch 1:  SELECT * FROM "user" WHERE ... LIMIT 5000 OFFSET 0
Batch 2:  SELECT * FROM "user" WHERE ... LIMIT 5000 OFFSET 5000
Batch 3:  SELECT * FROM "user" WHERE ... LIMIT 5000 OFFSET 10000
...
```

이 전략은 작거나 중간 크기인 데이터셋에서 잘 동작합니다(약 100K행까지). 하지만 offset이 커질수록 데이터베이스는 필요한 행을 반환하기 전에 건너뛸 행을 모두 스캔하고 버려야 합니다. offset이 1,000,000이면 데이터베이스는 행 1,000,000개를 스캔한 뒤 그냥 버립니다.

### Keyset 페이지네이션

Keyset 페이지네이션이 이 문제를 해결합니다. 데이터베이스에 "N행을 건너뛰세요"라고 하지 않고 "마지막으로 본 값 다음의 행을 주세요"라고 합니다. 그러면 데이터베이스는 인덱스를 써서 해당 위치로 바로 이동할 수 있습니다.

```
Batch 1:  SELECT * FROM "user" WHERE ... ORDER BY "id" ASC LIMIT 5000
Batch 2:  SELECT * FROM "user" WHERE ... AND "id" > 5000 ORDER BY "id" ASC LIMIT 5000
Batch 3:  SELECT * FROM "user" WHERE ... AND "id" > 10000 ORDER BY "id" ASC LIMIT 5000
...
```

`keyset: true`로 켭니다.

```typescript
for await (const batch of em.pipe(User, {
  orderBy: { id: "ASC" },
  keyset: true,
  batchSize: 5000,
}).raw()) {
  process(batch);
}
```

파이프라인은 각 배치의 마지막 값을 자동으로 추적합니다. 그리고 그 값을 다음 쿼리의 WHERE 조건에 넣습니다. 그래서 커서를 직접 관리하지 않아도 됩니다.

`keyset: true`를 쓰려면 `orderBy` 속성이 정확히 하나 있어야 합니다. 엔티티에도 기본 키가 있어야 합니다. 이 조건이 맞지 않으면 LIMIT/OFFSET으로 넘어가지 않고 파이프라인을 생성하는 시점에 거부합니다. 각 배치는 앞 배치의 마지막 행 값에서 이어 읽습니다. 그래서 `select`에서 정렬 컬럼이나 기본 키를 빼도 파이프라인은 그 컬럼을 함께 읽습니다. 이때는 반환되는 행에도 그 컬럼이 들어 있습니다.

#### 값이 겹치는 컬럼으로 정렬할 때

Keyset 배치는 [`findWithCursor()`](./pagination.md#커서-기반-페이지네이션)와 같은 방식으로 페이지를 넘깁니다. 위 예시처럼 기본 키로 정렬하면 컬럼 하나로 끝납니다. 다른 컬럼으로 정렬하면 그 컬럼 다음에 기본 키로 정렬합니다. 그래서 같은 값을 가진 행들이 배치 경계에 걸려도 빠지거나 두 번 읽히지 않습니다. NULL은 모든 다이얼렉트에서 오름차순이면 맨 뒤에 모이고 내림차순이면 맨 앞에 모입니다.

```
Batch 2:  SELECT * FROM "order" WHERE ...
            AND ("created_at" > ? OR ("created_at" = ? AND "id" > ?) OR "created_at" IS NULL)
            ORDER BY ("created_at" IS NULL) ASC, "created_at" ASC, "id" ASC LIMIT 5000
```

복합 기본 키는 모든 키 컬럼을 선언 순서대로 써서 동점을 가립니다. 첫 번째 키 컬럼으로 정렬하면 키 전체로 페이지를 넘깁니다(`ORDER BY "order_id" ASC, "line_no" ASC`). 그래서 한 주문의 행들이 배치 경계에서 갈라져 빠지는 일이 없습니다.

`("created_at" IS NULL)` 정렬 키 때문에 `created_at`만 담은 인덱스로는 이 순서대로 행을 꺼내지 못합니다. 데이터베이스는 대신 배치마다 조건에 맞는 행을 정렬합니다. 그래서 아주 큰 테이블을 내보낼 때는 여전히 기본 키로 정렬하는 것이 가장 빠릅니다.

::: tip Keyset을 쓸 때
다음 경우에는 `keyset: true`를 쓰세요.
- 전체 데이터셋이 클 때(100K행 이상)
- `orderBy` 컬럼에 인덱스가 있을 때
- 테이블 전체나 큰 부분집합을 순회할 때

다음 경우에는 기본값인 LIMIT/OFFSET을 쓰세요.
- 전체 데이터셋이 작을 때
- 임의의 페이지로 바로 이동해야 할 때(keyset은 앞으로만 이동)
- 여러 컬럼으로 정렬할 때(keyset은 현재 컬럼 하나만 지원)
:::

## 변환 체이닝

### map()

`.map()`을 체이닝하면 각 행을 yield하기 전에 변환합니다. 필요한 필드만 고르거나 키 이름을 바꿀 때 유용합니다. 타입을 변환할 때도 씁니다.

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

`.map()`은 여러 번 체이닝해도 됩니다. 각 변환은 내부에서 함수 하나로 합쳐집니다. 그래서 중간 배열을 할당하지 않습니다.

```typescript
const csvLines = await em.pipe(User)
  .map(row => ({ id: row.id, name: row.name }))
  .map(row => `${row.id},${row.name}`)
  .collect();
// csvLines는 string[]
```

### filter()

`.filter()`를 체이닝하면 조건에 맞지 않는 행을 제거합니다. 이 필터는 행을 조회한 뒤 JavaScript에서 실행됩니다. SQL 쿼리는 바꾸지 않습니다.

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

::: tip filter()와 where 비교
되도록 `where`로 거르세요. `where`는 데이터베이스에서 거르므로 전송되는 데이터 양이 줄어듭니다. `.filter()`는 SQL로 표현할 수 없는 조건에만 쓰세요. 복잡한 JavaScript 로직이나 필드 사이의 계산이 그 예입니다.

```typescript
// 좋은 방법: 데이터베이스에서 필터링
em.pipe(User, { where: { active: true, age: { gte: 18 } } })

// filter()는 SQL로 표현 불가능한 복잡한 JS 로직에 사용
em.pipe(User).filter(row => someComplexJsFunction(row))
```
:::

### collect()

`collect()`는 모든 배치를 배열 하나로 모으는 편의 메서드입니다. 전체 데이터가 메모리에 들어갈 때 쓰면 됩니다.

```typescript
const allRows = await em.pipe(User, { where: { active: true } }).collect();
// allRows는 Record<string, unknown>[]
```

::: warning
`collect()`는 모든 데이터를 메모리에 올립니다. 큰 데이터셋에서는 대신 `for await`로 순회하세요.
:::

## Binary 모드

### Binary 모드의 역할

`em.find()`나 `pipe().raw()`를 호출하면 데이터베이스 드라이버가 wire protocol 응답을 JavaScript 객체로 파싱합니다. 여기서 드라이버는 pg, mysql2, better-sqlite3입니다. 컬럼 값은 자동으로 변환됩니다. 정수는 `number`가 되고 문자열은 `string`이 되며 타임스탬프는 `Date`가 됩니다.

`binary()`는 드라이버가 이 파싱의 일부나 전부를 건너뛰게 합니다. 결과는 넘기는 옵션에 따라 달라집니다.

**`binary: true`**: 파싱된 값 대신 raw 바이트 버퍼를 요청합니다.

```typescript
for await (const batch of em.pipe(User, { batchSize: 5000 }).binary()) {
  // 기본값: { binary: true }
  // pg:     row.name이 "user_0" 대신 Buffer<75 73 65 72 5f 30>
  // mysql2: row.name이 "user_0" 대신 Buffer<75 73 65 72 5f 30>
  // sqlite: 효과 없음 (바이너리 wire 포맷 없음)
}
```

**`arrayMode: true`**: 키가 있는 객체 대신 위치 기반 배열로 행을 반환합니다.

```typescript
for await (const batch of em.pipe(User).binary({ arrayMode: true })) {
  // 행이 { id: 1, name: "user_0", age: 25, active: true } 대신
  // [1, "user_0", 25, true]
  // 객체 키 문자열 할당 없음 = 메모리 감소, GC 부하 감소
}
```

**둘 다 사용**: 두 옵션을 함께 쓰면 오버헤드가 가장 작습니다.

```typescript
for await (const batch of em.pipe(User).binary({ binary: true, arrayMode: true })) {
  // 행이 [Buffer, Buffer, Buffer, Buffer]
  // 행당 가능한 최소 할당: 다른 바이너리 프로토콜로 전달할 때 유용
}
```

### 드라이버별 동작

`binary()` 메서드는 하위 드라이버의 `queryWithOptions()`를 호출합니다. `queryWithOptions()`는 옵션을 드라이버 고유의 설정으로 변환합니다.

| 옵션 | PostgreSQL (pg) | MySQL (mysql2) | SQLite (better-sqlite3) |
|------|----------------|----------------|------------------------|
| `binary: true` | `QueryConfig`에 `binary: true` 설정. PostgreSQL wire protocol은 바이너리 포맷을 자체적으로 지원합니다. 서버는 컬럼 값을 텍스트 대신 바이너리 표현으로 보냅니다. `varchar` 컬럼은 `Buffer`로 도착합니다. pg는 일부 바이너리 타입을 직접 처리하므로 `int4`는 `number`로 올 수도 있습니다. | 쿼리 옵션에 `typeCast: false` 설정. mysql2는 타입 변환을 모두 건너뜁니다. 그래서 타입과 관계없이 모든 컬럼 값이 raw `Buffer`로 반환됩니다. | 효과 없음. SQLite는 임베디드 데이터베이스라서 wire protocol이 없습니다. BLOB 컬럼은 원래 `Buffer`로 반환됩니다. |
| `arrayMode: true` | `QueryConfig`에 `rowMode: 'array'` 설정. pg는 `{ column: value }` 객체 대신 컬럼 순서대로 담은 `any[]`로 행을 반환합니다. | `rowsAsArray: true` 설정. mysql2는 컬럼 순서대로 담은 `any[]`로 행을 반환합니다. | `.all()` 전에 `stmt.raw(true)` 호출. better-sqlite3는 컬럼 순서대로 담은 배열로 행을 반환합니다. |

### 실제 데이터베이스로 검증

이 동작은 실제 PostgreSQL과 MySQL 인스턴스에서 통합 테스트 27개로 검증했습니다.

**PostgreSQL (pg 8.18.0):**

```typescript
// binary: true → varchar 컬럼이 Buffer로 도착
const batch = await collectFirst(em.pipe(User).binary({ binary: true }));
const row = batch[0];
// row.name은 Buffer: 다음과 같이 디코딩
Buffer.isBuffer(row.name); // true (varchar 컬럼의 경우)
row.name.toString("utf-8"); // "user_0"

// arrayMode: true → 위치 기반 배열
const batch2 = await collectFirst(em.pipe(User).binary({ arrayMode: true }));
Array.isArray(batch2[0]); // true
batch2[0].length; // 4 (id, name, age, active)

// 결합: binary + array → Buffer 배열
const batch3 = await collectFirst(em.pipe(User).binary({ binary: true, arrayMode: true }));
Array.isArray(batch3[0]); // true
```

**MySQL (mysql2 3.16.3):**

```typescript
// binary: true → typeCast 비활성화, 모든 값이 Buffer
const batch = await collectFirst(em.pipe(User).binary({ binary: true }));
const row = batch[0];
Buffer.isBuffer(row.name); // true
row.name.toString("utf-8"); // "user_0"

// arrayMode: true → 위치 기반 배열
const batch2 = await collectFirst(em.pipe(User).binary({ arrayMode: true }));
Array.isArray(batch2[0]); // true
batch2[0].length >= 4; // true

// Buffer를 거쳐도 데이터 무결성 보존
const nameBuffer = row.name as Buffer;
nameBuffer.toString("utf-8") === "user_0"; // true ✓
```

### 옵션별 사용 시점

| 옵션 | 사용 사례 | 이점 |
|------|----------|------|
| `{ binary: true }` | protobuf / MessagePack / Avro 인코더로 전달 | JS 타입 파싱 건너뜀. 인코더가 Buffer를 직접 읽음. |
| `{ arrayMode: true }` | 컬럼 순서를 아는 고처리량 ETL | 메모리 ~20% 감소 (객체 키 문자열 없음). 순회 속도 향상. |
| `{ binary: true, arrayMode: true }` | 최대 처리량 파이프라인. 데이터가 다른 바이너리 시스템으로 곧장 감 | 행당 가능한 최소 할당. |
| `{}` 또는 `raw()` | 사람이 읽을 수 있는 데이터가 필요하고 컬럼 이름이 중요 | 다루기 쉬움. 대부분의 경우에 사용. |

### Keyset 페이지네이션과 Binary 모드

Keyset 페이지네이션은 배열이 아닌 `binary()` 모드에서 동작합니다. `arrayMode: true`를 `keyset: true`와 함께 쓰면 파이프라인은 자동으로 LIMIT/OFFSET으로 넘어갑니다. keyset은 컬럼 이름으로 커서 값을 꺼내야 합니다. 그런데 행이 위치 기반 배열이면 컬럼 이름으로 값을 꺼낼 수 없기 때문입니다.

```typescript
// 동작함: keyset + binary (비배열)
for await (const batch of em.pipe(User, {
  orderBy: { id: "ASC" },
  keyset: true,
  batchSize: 5000,
}).binary({ binary: true })) {
  // 바이너리 Buffer와 함께 keyset 페이지네이션
}

// 이것도 동작함: 다만 내부에서 LIMIT/OFFSET으로 넘어감
for await (const batch of em.pipe(User, {
  orderBy: { id: "ASC" },
  keyset: true,
  batchSize: 5000,
}).binary({ arrayMode: true })) {
  // arrayMode + keyset → 자동으로 LIMIT/OFFSET으로 넘어감
}
```

### Binary 모드 벤치마크: 실제 데이터베이스

같은 벤치마크를 로컬 네트워크의 실제 PostgreSQL과 MySQL에서 실행했습니다. 결과는 SQLite 인메모리 벤치마크와 매우 다릅니다. 알맞은 방법을 고르려면 그 이유를 이해해야 합니다.

**PostgreSQL (pg 8.18.0, 원격 서버):**

| 방식 | 1K행 | 10K행 | 100K행 | 메모리 (100K) |
|------|------|-------|--------|--------------|
| `em.find()` | 19.0ms | 155.1ms | 1.54s | 44.28 MB |
| `pipe().raw()` | 24.2ms | 257.8ms | 3.04s | 27.87 MB |
| `pipe().binary()` | 22.2ms | 204.5ms | 2.79s | 27.36 MB |
| `pipe().arrayMode()` | 19.7ms | 268.2ms | 2.77s | 27.40 MB |

**MySQL (mysql2 3.16.3, 원격 MariaDB):**

| 방식 | 1K행 | 10K행 | 100K행 | 메모리 (100K) |
|------|------|-------|--------|--------------|
| `em.find()` | 17.9ms | 146.4ms | 1.32s | 41.84 MB |
| `pipe().raw()` | 22.9ms | 262.6ms | 5.99s | 29.97 MB |
| `pipe().binary()` | 23.5ms | 288.6ms | 5.76s | 36.41 MB |
| `pipe().arrayMode()` | 21.0ms | 299.0ms | 5.58s | 31.37 MB |

### 원격 DB에서 pipe()가 em.find()보다 느린 이유

직관과 반대되는 결과입니다. `pipe()`는 엔티티 변환을 건너뛰므로 더 빨라야 합니다. 하지만 원격 데이터베이스에서는 `em.find()`보다 2-5배 *느립니다*. 이유는 다음과 같습니다.

병목은 변환이 아니라 쿼리 횟수입니다.

```
em.find()       →  쿼리 1회   (SELECT * FROM "users")
pipe(bs=1000)   →  쿼리 101회  (SELECT ... LIMIT 1000) × 100 + 빈 결과 체크 1
```

쿼리 하나하나가 완전한 네트워크 라운드 트립입니다. 클라이언트는 TCP로 SQL을 보냅니다. 서버는 SQL을 파싱해 실행하고 결과를 다시 보냅니다. 지연이 약 1ms인 로컬 네트워크에서는 라운드 트립 101번에 네트워크 오버헤드만 약 100ms가 듭니다. 데이터를 전송하기도 전에 드는 비용입니다.

SQLite는 프로세스 안에서 실행되고 네트워크를 거치지 않습니다. 그래서 라운드 트립 비용이 없습니다. 이때는 엔티티 변환을 건너뛰어 아낀 CPU만큼 `pipe()`가 빠릅니다. 원격 데이터베이스에서는 추가 쿼리 100번의 네트워크 비용이 아낀 CPU보다 훨씬 큽니다.

이 차이는 배치 스트리밍이 원래 가진 트레이드오프입니다.

| | em.find() | pipe() |
|---|---|---|
| 쿼리 수 | 1 | N (100K행 / batchSize) |
| 네트워크 라운드 트립 | 1 | N |
| 피크 메모리 | 모든 행 한 번에 | 배치 1개분 |
| 엔티티 변환 | 있음 (CPU 비용) | 없음 (CPU 절감) |

### 원격 DB에서 pipe()의 진짜 가치: 메모리 제어

위 수치는 pipe() 결과를 `collect()`로 전부 배열 하나에 모은 것입니다. 그러면 배치로 처리하는 의미가 없어집니다. 실제로는 각 배치를 처리하고 버립니다.

```typescript
// 전체 행 수와 관계없이 ~27 MB 사용
for await (const batch of em.pipe(User, { batchSize: 5000 }).raw()) {
  await sendToExternalService(batch);
  // 이 이터레이션이 끝나면 batch가 GC됨
}

// 100K행에서 ~44 MB, 1M행에서 ~440 MB 사용
const all = await em.find(User);
```

행이 100K개이면 `em.find()`는 44 MB를 한 번에 로드합니다. 1M행이면 약 440 MB가 됩니다. 10M행이면 메모리가 부족합니다. `pipe()`는 행 수와 관계없이 약 27 MB를 유지합니다. 이것이 핵심입니다.

::: tip 원격 DB에서 pipe()와 em.find() 선택 가이드
- **50K행 이하, 메모리에 들어감:** `em.find()`를 쓰세요. 쿼리가 하나뿐이라 더 빠릅니다.
- **50K행 초과, 또는 메모리 제한 환경:** `pipe()`를 쓰세요. 벽시계 시간은 더 길지만 메모리 사용량이 일정한 범위를 넘지 않습니다.
- **외부 시스템으로 전달 (gRPC, CSV 등):** `pipe()`를 쓰세요. 어차피 외부 싱크로 스트리밍하므로 배치마다 드는 오버헤드가 분산됩니다.
- **raw Buffer가 필요:** `pipe().binary()`를 쓰세요. 드라이버 레벨의 바이너리 데이터를 받는 방법은 이것뿐입니다.

큰 데이터셋을 스트리밍할 때 처리량을 최대로 끌어올리려면 `batchSize`를 늘려 라운드 트립 횟수를 줄이세요(예: `batchSize: 10000` 또는 `batchSize: 50000`).
:::

### 통합 테스트 결과

Binary 모드는 실제 PostgreSQL과 MySQL에서 통합 테스트 27개로 검증했습니다.

```
MySQL: 13개 테스트 통과
  ✓ raw baseline (plain 객체, WHERE, count)
  ✓ arrayMode (배열, 전체 수, 데이터 값)
  ✓ binary (Buffer, 전체 행, 데이터 무결성 round-trip)
  ✓ keyset 페이지네이션 (raw 모드, binary 비배열)
  ✓ map() 체인, 성능 비교

PostgreSQL: 14개 테스트 통과
  ✓ raw baseline (plain 객체, WHERE, count)
  ✓ arrayMode (배열, 전체 수, 데이터 값)
  ✓ binary (바이너리 wire 포맷, 전체 행, Buffer round-trip)
  ✓ binary + arrayMode 결합
  ✓ keyset 페이지네이션 (raw 모드, binary 비배열)
  ✓ map() 체인, 성능 비교
```

### 벤치마크 재현 방법

```bash
# PostgreSQL만
INTEGRATION_TEST=true INTEGRATION_TEST_MYSQL=false \
  NODE_OPTIONS="--expose-gc" npx ts-node --project __tests__/bench/tsconfig.json \
  __tests__/bench/raw-pipeline-binary-bench.ts

# MySQL만
INTEGRATION_TEST=true INTEGRATION_TEST_POSTGRES=false \
  NODE_OPTIONS="--expose-gc" npx ts-node --project __tests__/bench/tsconfig.json \
  __tests__/bench/raw-pipeline-binary-bench.ts
```

## count()

파이프라인의 WHERE 조건에 맞는 행 수를 조회합니다.

```typescript
const pipeline = em.pipe(User, { where: { active: true } });
const total = await pipeline.count();
console.log(`활성 사용자: ${total}`);
```

`count()` 메서드는 `raw()`와 같은 WHERE 조건을 적용합니다. `where: { active: true }`로 파이프라인을 생성하면 `count()`도 전체 사용자가 아니라 활성 사용자 수만 반환합니다.

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
  // count()로 센 행과 같은 행을 처리
}
```

## 성능 벤치마크

성능은 드라이버에 따라 크게 다릅니다. SQLite는 프로세스 안에서 실행되고 네트워크를 거치지 않습니다. PostgreSQL과 MySQL은 원격이라 네트워크 라운드 트립이 생깁니다. 고르기 전에 세 결과를 모두 읽고 트레이드오프를 파악하세요.

### SQLite (인메모리, 네트워크 없음)

전체 결과를 메모리에 모았습니다. 행마다 컬럼은 6개이고 값은 5회 실행의 중앙값입니다.

| 방식 | 100K 시간 | 100K 메모리 | 처리량 |
|------|-----------|-------------|--------|
| `em.find()` | 322.7ms | 83.11 MB | 309,866 rows/s |
| `em.query()` | 111.4ms | 67.15 MB | 897,864 rows/s |
| `pipe().raw()` | 96.7ms | 63.94 MB | 1,033,701 rows/s |
| `pipe().binary()` | 76.4ms | 27.22 MB | 1,308,623 rows/s |

SQLite는 네트워크 오버헤드가 없습니다. 그래서 `pipe()`가 `em.find()`보다 4.2배 빠릅니다. 이 차이는 모두 엔티티 변환을 건너뛴 데서 나옵니다.

### PostgreSQL (원격 서버, ~1ms 네트워크 지연)

전체 결과를 메모리에 모았습니다. 행마다 컬럼은 6개이고 값은 5회 실행의 중앙값입니다.

| 방식 | 100K 시간 | 100K 메모리 |
|------|-----------|-------------|
| `em.find()` | 1.54s | 44.28 MB |
| `pipe().raw()` | 3.04s | 27.87 MB |
| `pipe().binary()` | 2.79s | 27.36 MB |
| `pipe().arrayMode()` | 2.77s | 27.40 MB |

### MySQL (원격 MariaDB, ~1ms 네트워크 지연)

전체 결과를 메모리에 모았습니다. 행마다 컬럼은 6개이고 값은 5회 실행의 중앙값입니다.

| 방식 | 100K 시간 | 100K 메모리 |
|------|-----------|-------------|
| `em.find()` | 1.32s | 41.84 MB |
| `pipe().raw()` | 5.99s | 29.97 MB |
| `pipe().binary()` | 5.76s | 36.41 MB |
| `pipe().arrayMode()` | 5.58s | 31.37 MB |

### 원격 DB에서 pipe()가 느린 이유

PostgreSQL과 MySQL에서 `pipe()`는 엔티티 변환을 건너뛰는데도 `em.find()`보다 2-5배 *느립니다*. 병목은 변환이 아니라 쿼리 횟수입니다.

```
em.find()       →  쿼리 1회    (SELECT *)
pipe(bs=1000)   →  쿼리 101회   (SELECT ... LIMIT 1000) × 100 + 빈 결과 체크 1
```

쿼리 하나하나가 완전한 TCP 라운드 트립입니다. 라운드 트립 101번에 각각 약 1ms가 걸리면 데이터를 전송하기 전에 네트워크 오버헤드만 약 100ms가 됩니다. 프로세스 안에서 실행되는 SQLite에서는 이 비용이 0입니다.

### Stream-and-Discard: pipe()가 유리한 경우

위 벤치마크는 pipe() 결과를 전부 배열 하나에 모았습니다. 그러면 배치의 의미가 없어집니다. 실제로는 각 배치를 처리하고 버립니다. 이때 핵심 지표는 **MaxBatch**입니다. MaxBatch는 어느 한 시점에 들고 있는 데이터의 최대량입니다.

**PostgreSQL, 100,000행:**

| 방식 | 시간 | MaxBatch (한 시점 보유량) | 전체 행 |
|------|------|-------------------------|---------|
| `em.find()` | 1.42s | 17.10 MB | 100,000 |
| `pipe().raw()` | 2.86s | 0.17 MB | 100,000 |
| `pipe().arrayMode()` | 3.18s | 0.13 MB | 100,000 |

**MySQL, 100,000행:**

| 방식 | 시간 | MaxBatch (한 시점 보유량) | 전체 행 |
|------|------|-------------------------|---------|
| `em.find()` | 937.9ms | 16.76 MB | 100,000 |
| `pipe().raw()` | 5.83s | 0.17 MB | 100,000 |
| `pipe().arrayMode()` | 6.38s | 0.13 MB | 100,000 |

행이 100K개이면 `em.find()`는 17 MB를 한 번에 들고 있습니다. `pipe()`는 0.17 MB만 들고 있으므로 100배 적습니다.

1M행이면 `em.find()`는 약 170 MB를 들고 있게 됩니다. 10M행이면 약 1.7 GB입니다. `pipe()`는 행 수와 관계없이 0.17 MB를 유지합니다. 이것이 핵심입니다.

### 수치를 올바르게 읽는 법

::: warning pipe()와 em.find()는 속도만으로 비교하지 않습니다
`pipe()`는 `em.find()`를 그대로 대신하는 메서드가 아닙니다. 두 메서드는 서로 다른 문제를 해결합니다.

- **`em.find()`**: 빠른 쿼리 한 번으로 모든 것을 메모리에 올립니다. 결과가 RAM에 들어가고 엔티티 인스턴스가 필요할 때 쓰세요.
- **`pipe()`**: 메모리 사용량이 정해진 배치로 데이터를 스트리밍합니다. 결과가 RAM에 들어가지 않을 때 쓰세요. 외부 싱크로 전달할 때도 씁니다(gRPC, CSV 파일, 메시지 큐).

원격 데이터베이스에서 `pipe()`는 쿼리를 더 많이 보내므로 벽시계 시간이 항상 더 깁니다. 하지만 어느 순간의 메모리 사용량은 100배 적습니다. 데이터셋이 가용 RAM보다 크면 중요한 것은 이 점뿐입니다.
:::

### 벤치마크 재현 방법

```bash
# SQLite (인메모리)
NODE_OPTIONS="--expose-gc" npx ts-node --project __tests__/bench/tsconfig.json \
  __tests__/bench/raw-pipeline-bench.ts

# PostgreSQL / MySQL (실제 DB 필요)
INTEGRATION_TEST=true \
  NODE_OPTIONS="--expose-gc" npx ts-node --project __tests__/bench/tsconfig.json \
  __tests__/bench/raw-pipeline-binary-bench.ts
```

## 상황별 선택 가이드

| 상황 | 방식 | 이유 |
|------|------|------|
| 일반 CRUD, 10K행 이하 | `em.find()` | 완전한 타입 안전성, 관계 로딩, 트랜스포머. 오버헤드는 무시할 수준. |
| 리포트, 집계, 100K행 이하 | `em.query()` 또는 `pipe().raw()` | 엔티티 오버헤드 제거. 배치가 필요하면 `pipe()`. |
| 대규모 내보내기 (CSV, JSON lines) | `pipe().raw()` + `keyset: true` | 메모리 일정. Keyset으로 속도 유지. |
| gRPC / protobuf 전달 | `pipe().binary()` | 최소 할당. 배열 모드로 객체 키 문자열 제거. |
| 데이터 웨어하우스로 ETL | `pipe().raw()` + `.map()` | 변환 체인으로 중간 배열 없이 데이터 재구성. |
| 필터된 행 수 조회 | `pipe().count()` | 파이프라인과 같은 WHERE 사용. |

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

`raw()`가 반환하는 async generator는 `Readable.from()`과 호환됩니다.

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
| `entity` | `ClazzType<T>` | *(필수)* | 엔티티 클래스(테이블 이름과 컬럼 해석에 사용) |
| `options.where` | `WhereClause<T>` | 없음 | 필터 조건(`em.find()`와 같은 문법) |
| `options.orderBy` | `IOrderBy<T>` | 없음 | 속성별 정렬 순서. `"ASC"`/`"DESC"`, 대소문자 무관(네이밍 전략 적용) |
| `options.select` | `(keyof T)[]` | `*` | 선택할 속성(네이밍 전략 적용) |
| `options.batchSize` | `number` | `1000` | 배치당 행 수. 양의 정수 |
| `options.keyset` | `boolean` | `false` | LIMIT/OFFSET 대신 keyset 페이지네이션 사용. `orderBy` 속성 정확히 하나와 기본 키 필요. |

`RawPipeline<T>`을 반환합니다.

알 수 없는 옵션이나 형식이 틀린 옵션을 넘기면 `em.pipe()`가 `InvalidQueryError`를 던집니다. 엔티티에 없는 컬럼을 넘겨도 마찬가지입니다. `find()` 옵션 중에서 파이프라인이 적용하지 않는 옵션은 이유와 함께 거부합니다.

| 옵션 | 거부하는 이유 |
|------|---------------|
| `take`, `limit`, `skip` | 파이프라인은 `where`에 맞는 행을 전부 읽습니다. `where`를 좁히세요. 아니면 필요한 만큼 읽은 뒤 순회를 멈추세요. |
| `withDeleted`, `onlyDeleted` | 파이프라인은 소프트 삭제된 행을 거르지 않습니다. 그래서 이미 함께 읽습니다. 조건은 `where`에 직접 적습니다. 예: `{ deletedAt: { isNull: true } }` |
| `relations`, `withCount` | 파이프라인은 테이블 하나의 raw 행을 읽습니다. 관계는 `find()`로 로드하세요. |

### `RawPipeline<T>`

| 메서드 | 반환 | 설명 |
|--------|------|------|
| `raw()` | `AsyncGenerator<Record<string, unknown>[]>` | 일반 객체 배치를 yield |
| `binary(opts?)` | `AsyncGenerator<any[]>` | 드라이버 레벨 옵션으로 배치 yield |
| `map(fn)` | `MappedPipeline<U>` | 행 변환 체이닝 |
| `filter(fn)` | `MappedPipeline<Record<string, unknown>>` | JS 조건 함수로 행 필터링 |
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

파이프라인은 SQL 생성 로직을 새로 만들지 않습니다. 대신 ORM의 코어 모듈 두 가지를 재사용합니다.

1. **`WhereResolver`**: `em.find()`, `em.update()`, `em.softDelete()`가 쓰는 것과 같은 모듈입니다. 그래서 모든 WHERE 연산자가 똑같이 동작합니다(`contains`, `ilike`, `search`, `OR`, `AND`, `NOT`, `between` 포함).

2. **엔티티 메타데이터**: 컬럼 이름, 속성과 컬럼의 매핑(네이밍 전략), 테이블 이름을 `Reflect.getMetadata()`에서 읽습니다. 엔티티 클래스마다 한 번만 읽고 `WeakMap`에 캐시합니다.

여기에 `find()`가 적용하는 테넌트 범위를 `PluginContext.tenantPredicate()`로 더합니다([멀티테넌시](#멀티테넌시) 참고). 상속 계층은 `find()`와 집계가 쓰는 소스를 그대로 읽습니다. JOINED 자식의 파생 테이블과 TABLE_PER_CLASS의 `UNION ALL`이 그 소스입니다([상속 계층](#상속-계층) 참고).

### SelectQueryBuilder를 안 쓰는 이유

SelectQueryBuilder의 목적은 엔티티 인스턴스를 반환하는 타입 안전 쿼리입니다. 그래서 SQL 생성, 결과 변환, 관계 로딩이 서로 얽혀 있습니다. Raw Pipeline에는 변환 *없는* SQL 생성이 필요합니다. 이것은 근본적으로 다른 실행 경로입니다.

파이프라인은 엔티티 메타데이터에서 SQL을 직접 만듭니다. 그래서 QueryBuilder 체인 전체를 만드는 오버헤드가 없습니다. 그리고 스트리밍 용도에 맞춘 최적화를 적용할 수 있습니다(배치 페이지네이션, keyset 커서).

## 다음 단계

- [플러그인](./plugins.md): 플러그인 시스템의 동작 원리
- [Raw SQL & CTE](./raw-sql.md): SQL 전체 제어가 필요할 때
- [페이지네이션 & 스트리밍](./pagination.md): 엔티티 레벨 스트리밍 `em.stream()`
- [API 레퍼런스](./api-reference.md): 전체 메서드 시그니처
