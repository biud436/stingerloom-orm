# Raw 쿼리 결과에 타입 붙이기

`defineRow()`로 raw SQL 결과 행의 모양을 적어 두고 `em.query()`에 넘기면, 그 모양대로 타입이 붙고 값까지 변환된 행을 받습니다. 컬럼은 `defineEntity()`와 같은 `t` 빌더로 적습니다. 테이블을 엔티티로 매핑할 필요가 없고, ORM에 무언가 등록되지도 않습니다.

```typescript
import { defineRow, t } from "@stingerloom/orm";

const CachedLocation = defineRow({
  id:       t.int(),
  x:        t.double(),
  y:        t.double(),
  cachedAt: t.datetime().name("cached_at"),
});

const [loc] = await em.query(CachedLocation)`
  SELECT * FROM cached_location AS a WHERE a.id = ${16}
`;
// loc: { id: number; x: number; y: number; cachedAt: Date }
```

## 왜 필요한가

### ORM이 관리하지 않는 테이블도 있습니다

게임 서버로 예를 들어 보겠습니다. 인벤토리 아이템은 `items` 테이블에 들어 있습니다. 이 테이블은 ORM이 매핑하고, 만들고, 마이그레이션하고, 관계까지 묶어서 읽어 옵니다. 엔티티 매핑은 원래 이런 일을 하려고 있는 기능이죠.

그런데 같은 데이터베이스에 다른 개발자가 좌표 캐시용 `cached_location` 테이블을 추가했다고 해 봅시다. 이 테이블을 채우는 건 그 사람의 서비스입니다. 이쪽 코드는 거기서 행 하나만 읽으면 되고, 그마저도 거의 실행되지 않는 분기에서만 필요합니다.

```sql
SELECT * FROM cached_location AS a WHERE a.id = 16
```

쿼리 자체는 이게 전부입니다. 어려운 건 이 결과를 타입이 맞는 행으로 꺼내는 일이었습니다. Row Shape가 나오기 전에는 방법이 세 가지 있었는데, 셋 모두 이 읽기 한 번에는 필요 없는 비용을 요구했습니다.

### `em.query<T>()`: 타입은 붙지만 아무도 확인하지 않습니다

```typescript
interface CachedLocation {
  id: number;
  isHot: boolean;
  cachedAt: Date;
  meta: { zone: string };
}

const [loc] = await em.query<CachedLocation>`
  SELECT * FROM cached_location WHERE id = ${16}
`;
```

여기서 `T`는 타입 단언일 뿐입니다. ORM은 드라이버가 준 값을 그대로 돌려주는데, 드라이버마다 주는 값이 다릅니다.

| 컬럼 | PostgreSQL (`pg`) | MySQL / MariaDB (`mysql2`) | SQLite (`better-sqlite3`) |
|---|---|---|---|
| `DATETIME` / `TIMESTAMP` | `Date` | `Date` | `"2026-10-24 09:30:00"` |
| `BOOLEAN` / `TINYINT(1)` | `true` | `1` | `1` |
| `JSON` | 파싱된 값 | 파싱된 값(MySQL), `'{"zone":"z1"}'`(MariaDB) | `'{"zone":"z1"}'` |
| `BIGINT` | `"42"` | `42` | `42` |
| `NUMERIC` / `DECIMAL` | `"19.90"` | `"19.90"` | `19.9` |
| `COUNT(*)` | `"2"` | `2` | `2` |

컴파일은 통과하는데 실행 결과가 DB마다 달라집니다. `loc.cachedAt.getTime()`은 SQLite에서만 `TypeError`를 던집니다. `loc.isHot === true`는 MySQL에서 `false`가 됩니다. `row.total + 1`은 PostgreSQL에서 `"21"`이 되고요. 이런 버그는 쿼리와 멀리 떨어진 곳에서, 그것도 특정 DB에서만 터집니다. 운영과 다른 드라이버로 도는 테스트에서 처음 발견되는 경우가 많습니다.

### 엔티티로 매핑하기: 값은 맞지만 남의 테이블을 떠안습니다

`@Entity`나 `defineEntity()`로 정의하면 변환은 전부 맞게 나옵니다. 대신 아래 비용이 따라옵니다.

- **쓰기 전에 등록부터 해야 합니다.** 데코레이터와 `defineEntity()`는 모듈이 평가되는 순간 엔티티 메타데이터를 기록합니다. 클래스는 `entities`에도 넣어야 합니다. 그 테이블을 읽는 코드가 한 번도 실행되지 않더라도 이 비용은 부팅 때 나갑니다.
- **스키마의 주인이 ORM으로 바뀝니다.** `synchronize`가 켜져 있으면 ORM은 그 테이블을 자기 것으로 봅니다. 테이블이 없으면 만들고, `synchronize: true`에서는 컬럼을 엔티티에 맞게 고치고 엔티티에 없는 컬럼은 지웁니다. 남의 테이블에서 읽을 컬럼 세 개만 매핑했다면 나머지 컬럼은 삭제됩니다.
- **쿼리 하나 때문에 모델이 하나 생깁니다.** 엔티티는 쓰기 계약이기도 해서 PK, 훅, 검증, 테넌트 범위, 관계가 함께 따라옵니다. 읽기 한 번에는 전부 군더더기입니다.

### `getRawMany({ coerce })`: 변환은 되지만 엔티티가 필요하고 같은 내용을 두 번 적습니다

```typescript
// qb: 엔티티에서 시작한 SelectQueryBuilder
const rows = await qb.getRawMany<{ day: Date; total: number }>({
  coerce: { day: "date", total: "number" },
});
```

`coerce`는 런타임에 실제로 값을 바꿔 줍니다. 하지만 엔티티에서 시작하는 쿼리 빌더에만 있는 기능입니다. 게다가 행 타입과 coerce 맵을 따로 적고 손으로 맞춰야 해서, 한쪽만 고쳐도 컴파일러가 알려 주지 않습니다.

### 일회성 읽기에 필요한 네 가지

1. **타입이 실제 값과 같아야 합니다.** 어느 드라이버에서든 정적 타입이 런타임 값과 일치해야 합니다.
2. **변환은 ORM이 맡아야 합니다.** 한 번 선언하면 ORM이 적용해야 합니다.
3. **등록이 없어야 합니다.** 메타데이터도, `entities` 항목도, DDL도 없어야 합니다.
4. **쓴 만큼만 비용을 내야 합니다.** 한 번도 실행되지 않는 읽기는 비용이 없어야 합니다.

세 방법 중 이 넷을 모두 채우는 것은 없었습니다. Row Shape는 이 넷을 채우려고 만든 기능입니다.

### 설계 원칙

- **Shape는 등록이 아니라 값입니다.** `defineRow()`는 얼린(frozen) 객체 하나를 돌려줄 뿐입니다. 메타데이터 레이어, 스키마 동기화, `entities` 목록 어느 것도 건드리지 않습니다.
- **선언 하나에서 타입과 변환이 함께 나옵니다.** 같은 빌더가 TypeScript 타입(`InferRow`)과 런타임 변환을 둘 다 만들기 때문에 둘이 어긋날 수 없습니다.
- **변환 규칙은 엔티티와 같습니다.** Row Shape와 엔티티 하이드레이션은 ORM 안에서 컬럼 읽기 함수 하나를 공유합니다. 그래서 같은 컬럼 타입이면 `em.query(shape)`로 읽든 `find()`로 읽든 같은 값이 나옵니다. 통합 테스트가 PostgreSQL, MySQL, SQLite에서 이를 확인합니다.
- **모양이 안 맞으면 바로 실패합니다.** 선언한 컬럼이 결과에 없거나 정수가 JS number에 담기지 않으면, `undefined`나 반올림된 숫자를 돌려주는 대신 컬럼 이름이 적힌 에러를 던집니다.
- **나중에 엔티티로 옮길 수 있습니다.** 테이블이 이쪽 소유가 되면 같은 필드 맵을 그대로 `defineEntity()`에 넘기면 됩니다([아래](#to-entity) 참고).

## 호출하는 방법

```typescript
// 1. 태그드 템플릿. 값은 파라미터로 바인딩되고, 엔티티 클래스는
//    테이블 참조로 바뀝니다. 태그드 em.query와 규칙이 같습니다.
const rows = await em.query(CachedLocation)`
  SELECT l.* FROM cached_location AS l
  JOIN ${Item} AS i ON i.location_id = l.id
  WHERE i.owner_id = ${ownerId}
`;

// 2. 러너를 받아 두고 여러 번 호출할 수 있습니다.
const locations = em.query(CachedLocation);
const north = await locations`SELECT * FROM cached_location WHERE zone = ${"north"}`;

// 3. 위치 바인딩을 쓰는 SQL 문자열(플레이스홀더는 드라이버 문법),
//    또는 RawQueryBuilder.build() 같은 Sql 조각도 받습니다.
const byId = await em.query(
  CachedLocation,
  "SELECT * FROM cached_location WHERE id = $1",
  [16],
);
const built = await em.query(CachedLocation, sql`SELECT * FROM cached_location WHERE id = ${16}`);
```

쿼리는 `em.query()`와 똑같이 실행됩니다. 진행 중인 트랜잭션이 있으면 그 안에서 돌고, 없으면 자체 트랜잭션을 엽니다. shape가 관여하는 건 결과 행을 다듬는 단계뿐이에요. 행 타입이 따로 필요하면 `InferRow`로 꺼냅니다.

```typescript
import type { InferRow } from "@stingerloom/orm";

type CachedLocation = InferRow<typeof CachedLocation>;
```

## 타입별로 값이 바뀌는 규칙

| 빌더 | 행 타입 | 읽을 때 하는 변환 |
|---|---|---|
| `t.int()`, `t.integer()`, `t.float()`, `t.double()`, `t.number()`, `t.decimal(p, s)` | `number` | 숫자 문자열을 숫자로 바꿉니다. PostgreSQL의 `NUMERIC`과 `COUNT(*)`, mysql2의 `DECIMAL`과 `SUM()`이 여기에 해당합니다. ±2^53을 넘는 정수는 `BIGINT_PRECISION_LOSS`를 던집니다. 숫자가 아닌 텍스트는 그대로 둡니다. |
| `t.bigint()` | `number` | ±2^53을 넘으면 `BIGINT_PRECISION_LOSS` |
| `t.bigint({ mode: "string" })` | `string` | 손실 없는 10진 문자열 |
| `t.bigint({ mode: "bigint" })` | `bigint` | 손실 없는 `BigInt` |
| `t.boolean()` | `boolean` | MySQL, SQLite의 `0` / `1`을 `false` / `true`로 |
| `t.datetime()`, `t.timestamp()`, `t.timestamptz()`, `t.date()` | `Date` | SQLite 텍스트를 파싱합니다. 오프셋 없는 `YYYY-MM-DD HH:MM:SS`는 로컬 시각, 끝에 `Z`가 붙으면 UTC, `YYYY-MM-DD`만 있으면 로컬 자정입니다. pg와 mysql2가 준 `Date`는 그대로 둡니다. 숫자도 그대로 두는데, epoch가 초 단위인지 밀리초 단위인지 알 수 없어서입니다(필요하면 transformer를 쓰세요). |
| `t.json<T>()`, `t.jsonb<T>()` | `T` | 문자열로 온 값(MariaDB, SQLite)은 파싱하고, 이미 파싱된 값은 그대로 둡니다. 깨진 JSON은 경고를 한 번 남기고 원본 문자열을 돌려줍니다. |
| `t.array<T>()` | `T[]` | MySQL, SQLite의 JSON 텍스트를 파싱합니다. pg 배열은 그대로 둡니다. |
| `t.varchar()`, `t.char()`, `t.text()`, `t.longtext()`, `t.uuid()`, `t.enum([...])`, `t.blob()` | `string`, 리터럴 유니언, `Buffer` | 드라이버 값 그대로 |
| `.transformer({ from })`을 붙인 빌더 | 빌더의 타입 | 지정한 `from` 함수 |
| `ColumnTypeRegistry`에 등록한 타입을 쓰는 `new ColumnBuilder<T>({ type: "point" })` | `T` | 등록된 `transformer.from` |

SQL `NULL`은 언제나 `null`로 읽히고, 변환 함수에는 넘어가지 않습니다. `.nullable()`을 붙이면 필드 타입이 `T | null`로 넓어집니다.

첫 줄의 숫자 문자열 변환을 빼면, 나머지는 엔티티 하이드레이션이 하는 변환과 정확히 같습니다. 숫자 문자열 변환은 `find()`에는 없는 규칙입니다. 엔티티 컬럼은 드라이버가 준 값 그대로 읽히는데, raw 쿼리는 이 타입들을 `COUNT(*)`, `AVG()`, `NUMERIC` 컬럼 같은 표현식에서 돌려주는 경우가 많고, 드라이버는 이런 값을 문자열로 넘기거든요.

## 컬럼 이름 맞추기

필드는 기본적으로 키와 이름이 같은 결과 컬럼을 읽습니다. 이름이 다른 컬럼을 읽으려면 `.name()`을 붙입니다.

```typescript
const Row = defineRow({
  cachedAt: t.datetime().name("cached_at"), // "cached_at" 컬럼을 cachedAt에 담습니다
});
```

EntityManager의 `NamingStrategy`는 적용하지 않습니다. shape는 ORM이 이름을 붙인 테이블이 아니라 쿼리가 돌려준 결과를 설명하는 것이기 때문입니다. 결과 컬럼은 별칭일 수도 있고, 표현식일 수도 있고, 자기만의 명명 규칙을 쓰는 남의 테이블 컬럼일 수도 있습니다. 여기서 이름을 암묵적으로 바꾸면 shape의 동작이 커넥션 설정에 따라 달라집니다.

PostgreSQL은 따옴표 없는 식별자를 소문자로 바꿉니다. 그래서 `AVG(price) AS avgPrice`는 `avgprice`라는 이름으로 돌아옵니다. 별칭을 따옴표로 감싸거나(`AS "avgPrice"`) `.name("avgprice")`를 쓰면 됩니다. 컬럼을 못 찾은 원인이 이것이라면 에러 메시지에서 짚어 줍니다.

## 선언하지 않은 컬럼과 결과에 없는 컬럼

쿼리가 돌려줬지만 shape에 선언하지 않은 컬럼은 그대로 복사됩니다. 추론된 타입에는 포함되지 않고요. 그래서 컬럼이 많은 테이블에 `SELECT *`를 하면서 shape에는 실제로 쓰는 컬럼만 적어도 됩니다.

반대로 선언한 컬럼이 결과에 없으면 `em.query`가 코드 `QUERY_ERROR`인 `OrmError`를 던집니다. 메시지에는 빠진 컬럼과 실제로 돌아온 컬럼이 모두 적힙니다.

```
em.query(CachedLocation): the result has no column "cached_at" (field "cachedAt"). Result columns: id, x, y.
```

이 검사는 첫 행을 기준으로 합니다. 결과가 비어 있으면 그냥 `[]`를 돌려줍니다. 에러에 찍히는 이름은 `defineRow(columns, { name: "CachedLocation" })`로 정하며, 기본값은 `row`입니다.

## Row Shape가 하지 않는 일

- **쓰기.** `em.query`는 직접 작성한 SQL을 실행할 뿐이고, shape에 대한 save나 update는 없습니다.
- **관계.** 결과 행은 평평한 구조라서 `defineRow()`는 관계 빌더를 받지 않습니다. 대신 외래 키 컬럼을 SELECT하고 그 타입을 선언하세요. 계산 컬럼 빌더도 받지 않으니, 표현식은 SQL에 직접 쓰고 결과 타입만 선언하면 됩니다.
- **DDL·쓰기용 수식어.** `primary()`, `generated()`, `unique()`, `index()`, `default()`, `length()`, `createTimestamp()`, `version()`, `validate()`, `tenant()` 같은 수식어도 받기는 합니다. 필드 맵을 `defineEntity()`와 같이 쓸 수 있게 하려는 것이고, shape에서는 아무 효과가 없습니다.
- **테넌트 범위 적용.** shape를 붙여도 raw SQL이라는 점은 다른 `em.query`와 같습니다. `tenant_column` 전략에서는 테넌트 조건을 직접 써야 하고, raw SQL에 대한 테넌트 경고도 평소처럼 뜹니다. `MultiTenantEntityManager`에서는 `query(shape)`가 현재 테넌트의 커넥션으로 실행됩니다.
- **엔티티 라이프사이클.** 훅, 이벤트, 검증, 결과 캐시, identity map 모두 적용되지 않습니다.

## 드는 비용

- `defineRow()`는 객체 하나를 만들어 얼려 둘 뿐입니다. 메타데이터 기록도, 부팅 단계도, DDL도 없습니다. 한 번도 쿼리하지 않은 shape는 그냥 객체 하나입니다.
- 처음 `em.query(shape)`를 호출할 때 컬럼별 읽기 계획을 만들어 그 shape에 캐시합니다. 약한 참조로 캐시하기 때문에 shape가 사라지면 계획도 함께 정리됩니다.
- 행마다 선언한 컬럼을 한 번 훑고, 선언하지 않은 컬럼을 복사하는 비용이 듭니다.

## 엔티티로 옮겨 가기 {#to-entity}

shape와 엔티티는 같은 빌더를 쓰기 때문에 필드 맵 하나를 같이 쓸 수 있습니다.

```typescript
const locationFields = {
  id:       t.int(),
  x:        t.double(),
  y:        t.double(),
  cachedAt: t.datetime().name("cached_at"),
};

export const CachedLocationRow = defineRow(locationFields);

// 나중에 테이블이 이쪽 소유가 되면:
export const CachedLocation = defineEntity("cached_location", {
  ...locationFields,
  id: t.int().primary(),
});
```

빌더가 같고 읽기 규칙도 같으니, `find(CachedLocation)`도 shape로 읽던 것과 같은 값을 돌려줍니다.

## `coerce`와는 어떻게 다른가

엔티티에서 시작한 쿼리 빌더의 raw 결과를 다룰 때는 여전히 `getRawMany({ coerce })`를 씁니다. 다만 엔티티 규칙과 어긋나던 두 군데를 이번에 맞췄습니다.

- `"date"`에 문자열이 들어오면 엔티티 시각 컬럼과 같은 방식으로 파싱합니다. 그래서 `YYYY-MM-DD`만 있는 값은 이제 로컬 자정이 됩니다. 예전에는 UTC 자정으로 읽혀서, UTC보다 서쪽 시간대에서는 하루 전 날짜가 됐습니다.
- `"number"`는 ±2^53을 넘는 정수를 반올림하지 않고 `BIGINT_PRECISION_LOSS`를 던집니다. 이런 컬럼에는 `"bigint"`나 `"string"`을 쓰세요.

## API

```typescript
function defineRow<Cols extends Record<string, ColumnBuilder<any>>>(
  columns: Cols,
  options?: { name?: string },
): RowShape<InferRowColumns<Cols>>;

type InferRow<S>;                                   // shape의 행 타입
function isRowShape(value: unknown): value is RowShape<unknown>;

// EntityManager, MultiTenantEntityManager (BaseEntityManager 타입 선언 포함)
em.query<Row>(shape: RowShape<Row>): (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Row[]>;
em.query<Row>(shape: RowShape<Row>, sql: string | Sql, params?: unknown[]): Promise<Row[]>;
```

## Next Steps

- [Raw SQL & CTE](./raw-sql.md): 태그드 `em.query`, `em.ref()`, `RawQueryBuilder`
- [엔티티 정의](./define-entity.md): `t` 빌더, 그리고 ORM이 관리하는 테이블을 위한 `defineEntity()`
- [날짜와 타임존](./timezone.md): 시각 값을 쓰고 읽는 방식
