# 3.0 업그레이드

3.0은 2.0이 하던 일을 이어 갑니다. 조용히 틀리던 자리를 더 찾아 실패를 실패라고 말하게 바꿨고, 여기에 하나가 더해졌습니다. 조회 결과의 타입이 실제로 읽은 것을 따릅니다. `select`를 쓰면 반환 타입이 좁혀지고, 관계마다 읽을 컬럼을 따로 고를 수 있어요.

업그레이드는 보통 버전을 올리고, 컴파일러와 테스트가 가리키는 곳을 고치면 끝납니다. 어디가 깨질 수 있는지를 아래에 모아 뒀습니다.

```bash
pnpm add @stingerloom/orm@3
```

## 올리기 전에 한 번

배포 전에 타입 검사와, 로깅을 켠 테스트를 한 번씩 돌려 보세요. 3.0에서 바뀐 것은 컴파일 에러(결과 타입, 옵션 타입)로 드러나거나, 조용히 넘어가던 상태가 예외나 경고로 바뀐 것이라 두 가지를 한 번씩 돌리면 손볼 자리가 거의 다 나옵니다.

```bash
npx tsc --noEmit
```

```typescript
await em.register({ /* ... */, logging: true });
```

## 빌드가 깨질 수 있는 곳

### 조회 결과 타입이 `select`를 따릅니다

예전에는 `select`에 무엇을 적든 `find()`가 `T[]`를 돌려줬습니다. 그래서 빼놓은 컬럼도 타입상으로는 있는 것처럼 보였고, 읽으면 `undefined`가 나왔어요. 이제 `select`를 쓰면 엔티티마다 선택한 프로퍼티, 조회가 로드하는 관계, `withCount`가 써 넣는 개수, 엔티티의 메서드만 타입에 남습니다.

```typescript
const users = await em.find(User, { select: ["id", "name"] });
//    ^? Pick<User, "id" | "name" | "greet">[]
```

`findOne()`, `findOneOrFail()`, `findAndCount()`, `findWithPage()`, `stream()`, `streamBatch()`도 같고, `EntityManager`, 리포지토리, `MultiTenantEntityManager` 모두 해당합니다. 관계 항목에 적은 `select`(`relations: { author: { select: ["name"] } }`)도 그 관계를 같은 방식으로 좁혀요.

이런 조회를 엔티티 전체 타입으로 적어 둔 코드는 이제 컴파일되지 않습니다.

```typescript
const users: User[] = await em.find(User, { select: ["id"] });  // 3.0에서는 에러
```

타입 표기를 지우거나, 코드가 읽는 컬럼을 `select`에 넣어 주세요. `select` 없는 조회와, 옵션을 그냥 `FindOption<User>`로 지정한 경우는 계속 `User`를 돌려받으므로 옵션을 넘기기만 하는 제네릭 코드는 영향이 없습니다. 조회가 스스로 추가하는 컬럼(컬렉션 관계를 짝짓는 데 쓰는 기본 키)은 객체에는 있지만 좁혀진 타입에는 없으니, 읽어야 한다면 캐스트하세요.

### `select` 객체 형식의 값은 `true` / `false`만 받습니다

`ISelectOption`에는 `{ author: { ... } }` 꼴의 세 번째 형식이 있었습니다. 관계의 컬럼을 고르는 방법처럼 타입 검사를 통과했지만 실행 시에는 무시됐어요. 이 형식을 없앴고, 불리언이 아닌 값을 넣으면 `InvalidQueryError`를 던집니다. 관계의 컬럼은 관계 항목에서 고르세요.

```typescript
em.find(Post, { relations: { author: { select: ["id", "name"] } } });
```

### `em.pipe()`는 자기 옵션만 받습니다

`RawPipelineOptions`가 `FindOption`을 확장하고 있어서 `take`, `limit`, `relations`, `withDeleted` 같은 옵션이 타입 검사를 통과한 뒤 무시됐습니다. `em.pipe(User, { take: 10 })`이 테이블 전체를 읽은 이유입니다. 이제는 파이프라인이 실제로 하는 일만 선언합니다. `where`, `orderBy`, `select`(프로퍼티 이름 배열), `batchSize`, `keyset`입니다. `find()` 옵션을 넘기면 컴파일 에러가 나고, 같은 키를 실행 중에 만들어 넘기면 이유와 함께 `InvalidQueryError`를 던져요. 적게 읽고 싶으면 순회를 중간에 멈추면 됩니다.

### `.transformer()`를 단 `defineEntity` 컬럼은 변환된 값의 타입을 가집니다

예전에는 컬럼 자체의 타입이 그대로 남아서, 값 객체를 읽는 트랜스포머를 달아도 필드가 `string`으로 잡혔습니다. 이제 `from`이 돌려주고 `to`가 받는 타입을 따릅니다. 예전 타입에 맞추느라 넣었던 캐스트는 지워야 할 수 있어요.

## 이제 예외를 던지는 곳

모두 예전에는 조용히 틀린 답을 내거나, 원인과 먼 곳에서 실패하던 자리입니다.

| 작성한 코드 | 2.x | 3.0 |
| --- | --- | --- |
| `register({ synchronize: "yes" })`, 철자가 틀린 `tenantStrategy`, 중첩 옵션 객체의 모르는 키 | 받아들이고 기본값으로 동작 | `register()`에서 가장 가까운 값과 함께 `OrmError(INVALID_CONFIG)` |
| 등록되지 않은 대상을 가리키는 관계, 아무것도 가리키지 않는 `mappedBy` / `inverseSide` | 첫 로드에서 실패하거나 `null` / 누락으로 로드 | 테이블을 만들기 전에 `register()`에서 해당 관계를 모두 적은 `OrmError(SCHEMA_ERROR)` |
| 알 수 없는 컬럼 타입, 로드되지 않는 엔티티 glob 파일, 실패한 스키마 비교 | 로그만 남기고 그 엔티티나 변경 없이 부팅 | 원인과 함께 부팅 중단 |
| 철자가 틀린 `propagation`, 알 수 없는 `isolationLevel` | 기본값으로 실행 | `OrmError(INVALID_CONFIG)` |
| 버전이 아닌 `versionOverride` | 무시 | `register()`에서 `OrmError(INVALID_CONFIG)` |
| alias 없는 `createQueryBuilder(Entity)` | alias가 빠진 SQL 생성 | `InvalidQueryError` |
| 실행 중에 만든 조회 옵션, `where`, 쓰기 조건의 모양이 틀린 경우(`take: "10"`, `orderBy: "title"`, 철자가 틀린 옵션 키) | 드라이버 에러, 또는 옵션 무시 | 문제를 모두 적은 `InvalidQueryError` |
| `id`가 `undefined`인 `findOne(User, { where: { id } })`, `findByPK()`·`exists()` 등 단일 행 조회에서의 같은 경우 | 아무 행이나 읽음 | `undefined`인 경로를 적은 `InvalidQueryError` |
| 아무것도 가리키지 않는 조건으로 `delete()`, `softDelete()`, `restore()` | 이벤트와 cascade를 실행한 뒤 실패 | 아무것도 실행하기 전에 거부 |
| 담을 수 없는 컬럼에 배열이나 객체를 바인딩 | 행의 파라미터에 펼쳐져 뒤쪽 값이 밀림 | 프로퍼티 이름을 적은 `InvalidQueryError` |
| ±2^53을 넘는 `bigint` 값을 `number` 프로퍼티로 읽음 | 반올림 | `OrmError` `BIGINT_PRECISION_LOSS` — `bigintMode: "string"`이나 `"bigint"`를 지정 |
| 복합 기본 키 엔티티에 스칼라 id로 `deleteMany()` | 첫 키 컬럼이 같은 행을 모두 삭제 | `InvalidQueryError` — 키 객체를 넘기세요 |
| `tenant_column`에서 현재 테넌트 밖의 행에 `attachRelation()` | 그대로 연결 | `EntityNotFoundError`(`detachRelation()`은 `{ affected: 0 }`) |
| 알 수 없는 다이얼렉트 이름으로 `createDialectExpression()` / `createColumnDefinitionBuilder()` 호출 | `undefined`를 돌려준 뒤 먼 곳에서 `TypeError` | `OrmError(ORM_UNSUPPORTED_DATABASE)` |

데이터를 흘리는 쓰기를 알려 주는 연결 단위 정책도 두 가지 생겼습니다. 기본값은 경고입니다.

- **`unknownWriteKeys`** — `save()` / `insertMany()` / `upsert()` 페이로드에서 어떤 컬럼도 가리키지 않는 키(`firstNam`)는 예전에는 SQL에서 그냥 빠졌습니다. 이제 엔티티와 키마다 한 번, 가장 가까운 이름과 함께 로그를 남깁니다. `"throw"`면 쓰기를 거부하고, `"ignore"`면 예전처럼 동작해요.
- 어떤 쓰기도 저장하지 않는 관련 행(`posts`에 cascade가 없는데 `save(User, { posts: [{ title }] })`, 또는 일괄 쓰기에 넘긴 관련 행)도 같은 정책으로 알려 줍니다.

## 결과가 달라지는 곳

### `clear()`가 호출자 트랜잭션 안에서 `DELETE`로 지웁니다

PostgreSQL은 `TRUNCATE ... RESTART IDENTITY CASCADE`를 실행해서 이 테이블을 참조하는 테이블까지 비웠고, MySQL은 외래 키 검사를 끄고 TRUNCATE했습니다. 이제 `clear()`는 호출자가 볼 수 있는 행만(현재 테넌트의 행, 단일 테이블 자식이면 그 하위 타입, 상속 계층이면 그 계층의 모든 테이블) 호출자의 트랜잭션 안에서 지우고, 다른 테이블에는 쓰지 않습니다.

- ID 카운터를 다시 시작하지 않습니다. `clear()` 뒤에 id가 1부터 시작한다고 가정한 테스트는 생성된 id를 읽도록 고쳐야 합니다.
- 아직 참조되는 행이 있으면 기본값(`NO ACTION`)에서 `clear()`가 실패합니다. 참조하는 테이블을 먼저 비우거나 `onDelete: "CASCADE"`를 선언하세요.

### after 이벤트는 행이 맞았을 때만 발생합니다

`delete()`, `deleteMany()`, `softDelete()`, `restore()`, `update()`, `updateMany()`, `increment()`, `decrement()`는 호출할 때마다 after 이벤트를 발생시켰습니다. 그래서 `delete(User, { id: 9999 })`도 일어나지 않은 삭제를 알렸어요. 이제 after 이벤트는 문장이 한 행 이상을 보고했을 때만 발생하고, 그 수를 `affected`로 실어 보냅니다. before 이벤트는 여전히 매번 발생합니다.

### 스키마 동기화가 컬럼 리네임을 추측하지 않습니다

예전에는 삭제되는 컬럼과 추가되는 컬럼의 타입이 같으면 처음 맞는 쌍을 리네임으로 처리해서, 상관없는 컬럼으로 옛 값이 옮겨 갔습니다. 이제는 엔티티에 `renamedFrom`을 선언했거나, 두 이름이 같은 컬럼으로 읽힐 때(`user_name` → `userName`, `name` → `fullName`, 짧은 오타)만 리네임합니다. 그 밖에는 엔티티가 선언한 대로 삭제와 추가를 하고, 추가할 `renamedFrom`을 알려 주는 경고를 남겨요. 예전 추측에 기대고 있었다면 동기화 전에 `renamedFrom`을 추가하세요.

### 배열 프로퍼티는 `json` 컬럼입니다

`type` 없이 선언한 `@Column() tags!: string[]`은 `text`로 매핑됐습니다. 이제는 nullable `json`이라서, MySQL과 PostgreSQL에서는 기존 `text` 컬럼이 엔티티와 맞지 않게 됩니다. 유지하려면 `type: "text"`를 명시하고, 바꾸려면 동기화 전에 데이터를 마이그레이션하세요.

### `bigint` 컬럼을 손실 없이 읽습니다

이제 드라이버가 ±2^53을 넘는 정수를 반올림하지 않고 10진수 문자열로 넘깁니다. 프로퍼티가 무엇을 담을지는 `bigintMode`가 정해요. `"number"`(기본값, ±2^53을 넘으면 예외), `"string"`, `"bigint"` 중 하나입니다. `bigint`로 선언한 프로퍼티는 `bigintMode: "bigint"`로 추론됩니다. SQLite에서는 bigint 컬럼을 `BIGINT`로 선언합니다(저장 방식은 같습니다).

### 키셋 페이지가 기본 키를 따릅니다

쿼리 빌더의 `getCursor()`는 정렬 값만으로 페이지를 나눠서, 같은 값을 가진 행을 건너뛰었습니다. 이제 `findWithCursor()`와 같은 키셋을 써서 정렬 프로퍼티 다음에 기본 키 컬럼 전부로 순서를 정하고, NULL 정렬 값은 오름차순에서 마지막에 옵니다. 빌더의 `orderBy()`는 더 이상 정렬 값이 같은 행의 순서를 정하지 않습니다. 2.x에서 받은 커서는 전환 페이지 하나만 예전 방식으로 나눕니다.

### MySQL 8.0.19 이상의 upsert는 행 별칭을 씁니다

서버가 MySQL 8.0.19 이상이면 `upsert()`, `batchUpsert()`, `createInsertBuilder()`가 deprecated된 `VALUES(col)` 대신 `INSERT … AS new (…) ON DUPLICATE KEY UPDATE`를 만듭니다. MariaDB와 이전 MySQL은 `VALUES()`를 유지해요. 직접 만든 드라이버는 새 선택 메서드 `ISqlDriver.supportsInsertRowAlias()`로 켤 수 있습니다.

### 롤백된 쓰기는 넘긴 객체에서도 되돌립니다

ROLLBACK되면 쓰기가 넘긴 객체에 넣었던 생성 키, 외래 키, 스탬프를 원래대로 돌려놓습니다. 그래서 같은 객체를 다시 저장할 수 있어요(교착 상태 재시도 등). COMMIT되면 아무것도 바뀌지 않습니다.

### 작은 차이

- 요청한 격리 수준은 데이터베이스의 기본값과 같아도 항상 보냅니다. 서버나 세션의 기본값을 바꿔 둔 환경에서도 요청한 수준으로 실행돼요.
- 쿼리 결과 캐시는 문장이 실행될 때가 아니라 그 트랜잭션이 끝날 때 쓰기를 무효화합니다.
- 기존 테이블에 추가하는 컬럼도 새 테이블과 똑같이 선언한 `default`를 받습니다.
- `upsert()`, `insertIgnore()`, `batchUpsert()`가 `@Version`, `@CreateTimestamp`, `@UpdateTimestamp`, `@DeletedAt`을 관리하고, `tenant_column`에서는 테넌트로 범위를 제한합니다.
- 상속 계층을 읽으면 모든 경로(관계, 쿼리 빌더, 커서 페이지, `em.pipe()`)에서 각 행을 해당 서브클래스로 만들고, `SINGLE_TABLE` 인스턴스는 자기 클래스의 컬럼만 가집니다.
- `contains` / `startsWith` / `endsWith`는 SQLite에서도 `%`, `_`, `\`를 이스케이프합니다.
- `em.pipe()`는 현재 트랜잭션 안에서 현재 테넌트의 행만 읽습니다.

전체 목록과 각 변경의 이유는 [changelog](https://github.com/biud436/stingerloom-orm/blob/main/CHANGELOG.md)에 있습니다.
