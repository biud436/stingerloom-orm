# 3.0 업그레이드

3.0에서 바뀐 것은 크게 두 가지입니다. 하나는 2.0의 연장선입니다. 틀린 결과를 내면서도 아무 경고가 없던 곳들이 이제 예외나 경고를 냅니다. 다른 하나는 조회 결과의 타입입니다. `select`로 고른 컬럼만 타입에 남고, 관계마다 읽을 컬럼도 따로 고를 수 있습니다.

```bash
pnpm add @stingerloom/orm@3
```

## 업그레이드 전 점검

타입 검사를 한 번, 로깅을 켜고 테스트를 한 번 돌려 보세요. 3.0의 변경은 대부분 컴파일 에러로 나거나 실행 중 예외·경고로 드러나기 때문에, 이 두 번이면 손볼 곳이 거의 다 나옵니다.

```bash
npx tsc --noEmit
```

```typescript
await em.register({ /* ... */, logging: true });
```

## 타입 변경

### `select`로 고른 컬럼만 결과 타입에 남습니다

지금까지는 `select`에 무엇을 적든 `find()`가 `T[]`를 돌려줬습니다. 고르지 않은 컬럼도 타입으로는 멀쩡히 있는 것처럼 보였고, 막상 읽으면 `undefined`였죠. 3.0부터는 `select`가 있으면 결과 타입에 고른 프로퍼티, 함께 로드한 관계, `withCount`로 센 개수, 엔티티의 메서드만 남습니다.

```typescript
const users = await em.find(User, { select: ["id", "name"] });
//    ^? Pick<User, "id" | "name" | "greet">[]
```

`findOne()`, `findOneOrFail()`, `findAndCount()`, `findWithPage()`, `stream()`, `streamBatch()`도 마찬가지이고, `EntityManager`든 리포지토리든 `MultiTenantEntityManager`든 똑같습니다. `relations: { author: { select: ["name"] } }`처럼 관계 쪽에 `select`를 적으면 그 관계의 타입도 같은 식으로 좁혀집니다.

그래서 이런 조회 결과를 엔티티 타입으로 받던 코드는 컴파일되지 않습니다.

```typescript
const users: User[] = await em.find(User, { select: ["id"] });  // 3.0에서는 에러
```

타입 표기를 지우거나, 실제로 읽는 컬럼을 `select`에 추가하면 됩니다. `select`가 없는 조회는 그대로 `User`를 돌려주고, 옵션을 `FindOption<User>` 타입으로 받아 넘길 때도 마찬가지입니다. 옵션을 받아서 넘겨주기만 하는 제네릭 코드는 손댈 필요가 없어요.

예외가 하나 있습니다. 컬렉션 관계를 부모와 짝짓느라 ORM이 따로 읽는 기본 키는 객체에는 들어 있지만 좁혀진 타입에는 없습니다. 이 값을 읽어야 한다면 캐스트하세요.

### `select` 객체 형식에는 `true` / `false`만 씁니다

`ISelectOption`에는 `{ author: { ... } }`처럼 객체를 중첩하는 세 번째 형식이 있었습니다. 관계의 컬럼을 고르는 문법처럼 생겼고 타입 검사도 통과했지만, 실제로는 아무 효과가 없었어요. 3.0에서 이 형식을 없앴고, 불리언이 아닌 값을 넣으면 `InvalidQueryError`가 납니다. 관계의 컬럼은 `relations` 쪽에서 고르세요.

```typescript
em.find(Post, { relations: { author: { select: ["id", "name"] } } });
```

### `em.pipe()`에 `find()` 옵션을 넘길 수 없습니다

`RawPipelineOptions`가 `FindOption`을 상속하고 있었던 탓에 `take`, `limit`, `relations`, `withDeleted` 같은 옵션이 타입 검사는 통과하고 실제로는 무시됐습니다. `em.pipe(User, { take: 10 })`가 테이블 전체를 읽은 것도 이 때문입니다.

이제 파이프라인이 받는 옵션은 `where`, `orderBy`, `select`(프로퍼티 이름 배열), `batchSize`, `keyset`뿐입니다. 다른 옵션은 컴파일 에러가 나고, 실행 중에 만든 객체로 넘겨도 이유를 적은 `InvalidQueryError`가 납니다. 일부만 읽고 싶다면 순회하다가 `break`하면 됩니다.

### `defineEntity`에서 `.transformer()`를 단 컬럼의 타입

예전에는 트랜스포머를 달아도 필드 타입이 컬럼 타입 그대로였습니다. 값 객체로 바꿔 읽는 트랜스포머를 달아도 `string`으로 잡혔죠. 이제는 `from`이 돌려주고 `to`가 받는 타입이 필드 타입이 됩니다. 예전 타입 때문에 넣어 둔 캐스트가 있다면 지워야 할 수도 있습니다.

## 새로 던지는 예외

2.x에서는 아래 경우 모두 틀린 결과를 그대로 돌려주거나, 원인과 동떨어진 곳에서 에러가 났습니다.

| 이런 코드 | 2.x | 3.0 |
| --- | --- | --- |
| `register({ synchronize: "yes" })`, 철자가 틀린 `tenantStrategy`, 중첩 옵션 객체의 모르는 키 | 받아 놓고 기본값으로 동작 | `register()`에서 `OrmError(INVALID_CONFIG)`. 가장 비슷한 값도 알려 줌 |
| 등록되지 않은 엔티티를 가리키는 관계, 없는 프로퍼티를 가리키는 `mappedBy` / `inverseSide` | 첫 로드에서 실패하거나, `null`로 로드되거나 아예 빠짐 | 테이블을 만들기 전에 `register()`에서 `OrmError(SCHEMA_ERROR)`. 문제가 있는 관계를 한꺼번에 알려 줌 |
| 알 수 없는 컬럼 타입, 불러오지 못한 엔티티 glob 파일, 실패한 스키마 비교 | 로그만 남기고 그 엔티티나 변경을 뺀 채 부팅 | 원인을 알리고 부팅 중단 |
| 철자가 틀린 `propagation`, 알 수 없는 `isolationLevel` | 기본값으로 실행 | `OrmError(INVALID_CONFIG)` |
| 버전 값이 아닌 `versionOverride` | 무시 | `register()`에서 `OrmError(INVALID_CONFIG)` |
| alias 없이 부른 `createQueryBuilder(Entity)` | alias가 빠진 SQL을 만듦 | `InvalidQueryError` |
| 실행 중에 만든 조회 옵션, `where`, 쓰기 조건의 모양이 틀린 경우(`take: "10"`, `orderBy: "title"`, 옵션 키 오타) | 드라이버 에러가 나거나 옵션이 무시됨 | 문제를 전부 담은 `InvalidQueryError` |
| `id`가 `undefined`인 채로 부른 `findOne(User, { where: { id } })`. `findByPK()`, `exists()` 같은 단건 조회도 마찬가지 | 아무 행이나 하나 읽음 | `undefined`인 경로를 알려 주는 `InvalidQueryError` |
| 조건이 결국 비어 버리는(값이 전부 `undefined`인 경우 등) `delete()`, `softDelete()`, `restore()` | 이벤트와 cascade를 먼저 실행하고 나서 실패 | 아무것도 실행하기 전에 거부 |
| 배열이나 객체를 담을 수 없는 컬럼에 그런 값을 바인딩 | 값이 여러 파라미터로 펼쳐져 뒤쪽 값이 한 칸씩 밀림 | 프로퍼티 이름을 알려 주는 `InvalidQueryError` |
| ±2^53을 넘는 `bigint` 값을 `number` 프로퍼티로 읽음 | 반올림됨 | `OrmError` `BIGINT_PRECISION_LOSS`. `bigintMode: "string"`이나 `"bigint"`로 해결 |
| 복합 기본 키 엔티티에 스칼라 id로 부른 `deleteMany()` | 첫 번째 키 컬럼 값이 같은 행을 전부 삭제 | `InvalidQueryError`. 키 객체를 넘겨야 함 |
| `tenant_column` 전략에서 현재 테넌트에 속하지 않은 행으로 부른 `attachRelation()` | 그대로 연결됨 | `EntityNotFoundError`(`detachRelation()`은 `{ affected: 0 }`) |
| 알 수 없는 다이얼렉트 이름으로 부른 `createDialectExpression()` / `createColumnDefinitionBuilder()` | `undefined`가 돌아와 엉뚱한 곳에서 `TypeError` | `OrmError(ORM_UNSUPPORTED_DATABASE)` |

저장되지 않고 버려지는 데이터도 이제 알려 줍니다. 연결 옵션 `unknownWriteKeys`가 어떻게 할지 정하고, 기본값은 경고입니다.

- `save()` / `insertMany()` / `upsert()`에 넘긴 객체에 어떤 컬럼과도 맞지 않는 키(`firstNam` 같은 오타)가 있으면, 예전에는 SQL에서 그냥 빠졌습니다. 이제는 엔티티와 키마다 한 번씩, 가장 비슷한 이름과 함께 경고를 남깁니다. `"throw"`로 두면 쓰기를 거부하고, `"ignore"`로 두면 예전처럼 넘어가요.
- 어떤 쓰기로도 저장되지 않는 관련 행도 같은 정책을 따릅니다. `posts`에 cascade가 없는데 `save(User, { posts: [{ title }] })`를 했거나, 일괄 쓰기에 관련 행을 넘긴 경우입니다.

## 동작 변경

### `clear()`가 `TRUNCATE` 대신 `DELETE`를 씁니다

PostgreSQL에서는 `TRUNCATE ... RESTART IDENTITY CASCADE`를 실행해서, 이 테이블을 참조하는 다른 테이블까지 함께 비웠습니다. MySQL에서는 외래 키 검사를 끄고 TRUNCATE했고요. 이제 `clear()`는 호출한 쪽의 트랜잭션 안에서 `DELETE`로 지우고, 지우는 범위도 호출한 쪽이 볼 수 있는 행으로 한정합니다. 현재 테넌트의 행, 단일 테이블 상속의 자식이라면 그 타입의 행, 상속 계층이라면 계층에 속한 테이블 전부입니다. 다른 테이블은 건드리지 않습니다.

- ID 카운터가 초기화되지 않습니다. `clear()` 뒤에 id가 1부터 다시 시작한다고 가정한 테스트는 생성된 id를 읽어 쓰도록 바꿔야 합니다.
- 다른 테이블이 아직 참조하는 행이 있으면, 기본값인 `NO ACTION`에서는 `clear()`가 실패합니다. 참조하는 쪽 테이블을 먼저 비우거나 `onDelete: "CASCADE"`를 선언하세요.

### after 이벤트는 실제로 바뀐 행이 있을 때만 발생합니다

`delete()`, `deleteMany()`, `softDelete()`, `restore()`, `update()`, `updateMany()`, `increment()`, `decrement()`는 호출할 때마다 after 이벤트를 발생시켰습니다. 그래서 `delete(User, { id: 9999 })`처럼 지운 행이 없어도 삭제 이벤트가 나갔어요. 이제는 영향받은 행이 하나 이상일 때만 after 이벤트가 발생하고, 그 행 수를 `affected`에 담아 줍니다. before 이벤트는 지금처럼 매번 발생합니다.

### 스키마 동기화가 컬럼 이름 변경을 넘겨짚지 않습니다

예전에는 사라진 컬럼과 새로 생긴 컬럼의 타입이 같으면, 처음 맞은 쌍을 이름 변경으로 보고 처리했습니다. 그 바람에 전혀 상관없는 컬럼으로 기존 값이 옮겨 가기도 했습니다.

이제는 엔티티에 `renamedFrom`을 선언했거나, 두 이름이 누가 봐도 같은 컬럼일 때(`user_name` → `userName`, `name` → `fullName`, 짧은 오타)만 이름을 바꿉니다. 나머지는 엔티티에 선언된 대로 컬럼을 지우고 새로 만들며, 어떤 `renamedFrom`을 추가하면 되는지 경고로 알려 줍니다. 예전 추측에 기대고 있었다면 동기화하기 전에 `renamedFrom`부터 추가하세요.

### 배열 프로퍼티는 `json` 컬럼이 됩니다

`type` 없이 선언한 `@Column() tags!: string[]`는 지금까지 `text`로 매핑됐습니다. 이제는 nullable `json` 컬럼이 되기 때문에, MySQL과 PostgreSQL에서는 기존 `text` 컬럼이 엔티티와 맞지 않게 됩니다. `text`를 계속 쓰려면 `type: "text"`를 적어 주고, `json`으로 옮기려면 동기화 전에 데이터를 먼저 마이그레이션하세요.

### `bigint` 값이 더 이상 반올림되지 않습니다

드라이버가 ±2^53을 넘는 정수를 반올림하지 않고 10진수 문자열로 넘깁니다. 프로퍼티에 무엇이 들어갈지는 `bigintMode`로 정합니다. 기본값 `"number"`는 ±2^53을 넘는 값에서 예외를 던지고, `"string"`과 `"bigint"`는 각각 문자열과 `bigint`로 담습니다. 프로퍼티를 `bigint` 타입으로 선언했다면 `bigintMode: "bigint"`로 추론해요. SQLite에서는 bigint 컬럼을 `BIGINT`로 선언하는데, 저장 방식은 전과 같습니다.

### 키셋 페이지네이션이 기본 키까지 봅니다

쿼리 빌더의 `getCursor()`는 정렬 값만 보고 페이지를 나눴기 때문에, 정렬 값이 같은 행은 건너뛰었습니다. 이제는 `findWithCursor()`와 같은 키셋을 씁니다. 정렬 프로퍼티로 먼저 정렬하고, 값이 같으면 기본 키 컬럼들로 순서를 정합니다. 오름차순에서 NULL은 맨 뒤에 옵니다.

그래서 정렬 값이 같은 행들 사이의 순서는 빌더에 건 `orderBy()`로 바꿀 수 없습니다. 2.x에서 받은 커서로 이어서 읽으면 그 첫 페이지만 예전 방식으로 나뉘고, 다음 페이지부터는 새 방식을 따릅니다.

### MySQL 8.0.19 이상에서 upsert SQL이 바뀝니다

서버가 MySQL 8.0.19 이상이면 `upsert()`, `batchUpsert()`, `createInsertBuilder()`가 deprecated된 `VALUES(col)` 대신 행 별칭을 쓴 `INSERT … AS new (…) ON DUPLICATE KEY UPDATE`를 만듭니다. MariaDB와 그보다 낮은 MySQL은 여전히 `VALUES()`를 씁니다. 직접 만든 드라이버라면 새로 추가된 선택 메서드 `ISqlDriver.supportsInsertRowAlias()`로 켤 수 있어요.

### 롤백되면 넘긴 객체도 원래대로 돌아갑니다

트랜잭션이 ROLLBACK되면, 쓰기 과정에서 객체에 채워 넣었던 값(생성된 기본 키, cascade로 채운 외래 키, 타임스탬프, `@Version` 초기값)을 원래대로 되돌립니다. 그래서 데드락 재시도처럼 같은 객체를 다시 저장해도 문제가 없습니다. COMMIT되면 바뀌는 것은 없습니다.

### 그 밖의 작은 차이

- 요청한 격리 수준이 데이터베이스 기본값과 같아도 항상 지정해서 보냅니다. 서버나 세션의 기본값을 바꿔 둔 환경에서도 요청한 수준으로 실행됩니다.
- 쿼리 결과 캐시는 쓰기 문장이 실행될 때가 아니라 그 트랜잭션이 끝날 때 무효화됩니다.
- 기존 테이블에 컬럼을 추가할 때도 새 테이블을 만들 때처럼 선언한 `default`가 적용됩니다.
- `upsert()`, `insertIgnore()`, `batchUpsert()`도 `@Version`, `@CreateTimestamp`, `@UpdateTimestamp`, `@DeletedAt` 값을 채우고, `tenant_column` 전략에서는 현재 테넌트 범위 안에서만 동작합니다.
- 상속 계층은 어느 경로(관계, 쿼리 빌더, 커서 페이지, `em.pipe()`)로 읽든 각 행이 해당 서브클래스 인스턴스로 만들어지고, `SINGLE_TABLE` 인스턴스에는 자기 클래스의 컬럼만 들어 있습니다.
- SQLite에서도 `contains` / `startsWith` / `endsWith`가 `%`, `_`, `\`를 이스케이프합니다.
- `em.pipe()`는 현재 트랜잭션 안에서, 현재 테넌트의 행만 읽습니다.

변경 사항 전체와 각각의 이유는 [changelog](https://github.com/biud436/stingerloom-orm/blob/main/CHANGELOG.md)에서 볼 수 있습니다.
