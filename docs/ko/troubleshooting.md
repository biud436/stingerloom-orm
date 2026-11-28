# 트러블슈팅

자주 발생하는 문제와 그 해결 방법입니다.

## 연결 에러

### "Database not connected"

```
OrmError [ORM_NOT_CONNECTED]: Database connection has not been established.
```

원인: `em.register()`가 끝나기 전에 쿼리 메서드를 호출했습니다.

```typescript
// 잘못된 사용: register는 비동기입니다
const em = new EntityManager();
em.register({ ... }); // await을 잊었습니다
const users = await em.find(User); // 에러를 던집니다

// 올바른 사용
await em.register({ ... });
const users = await em.find(User);
```

### "Connection refused" 또는 "ECONNREFUSED"

데이터베이스 서버가 실행 중이 아니거나 호스트나 포트가 잘못되었습니다.

```bash
# 데이터베이스가 실행 중인지 확인
# PostgreSQL
pg_isready -h localhost -p 5432

# MySQL
mysqladmin ping -h localhost -P 3306

# SQLite: 서버가 필요 없으므로 파일 경로를 확인
ls ./mydb.sqlite
```

### 데이터베이스 재시작 뒤의 "A pooled ... connection was lost" 로그

```
WARN A pooled PostgreSQL connection was lost. terminating connection due to administrator command
```

연결 풀이 보유하던 연결을 서버가 닫았다는 뜻입니다. 흔한 원인은 데이터베이스 재시작, 페일오버, 관리자의 세션 종료, 방화벽의 유휴 연결 차단입니다. 풀은 이미 그 연결을 버렸습니다. 그리고 다음 쿼리를 실행할 때 새 연결을 엽니다. 그래서 따로 복구할 것은 없습니다. 다만 그 연결에서 실행 중이던 트랜잭션은 실패합니다. 그 트랜잭션은 다시 실행하세요.

끊긴 연결을 직접 집계하거나 경고 로그 대신 자체 로거로 보내려면 `onConnectionError`를 넘깁니다([시작 이후 끊긴 연결](./configuration.md#시작-이후-끊긴-연결)).

```typescript
await em.register({
  // ...
  onConnectionError: (error) => {
    // error.code는 "ORM_CONNECTION_LOST"이고 error.cause는 드라이버 에러입니다
    logger.warn(error.message);
  },
});
```

3.0.0 이하 버전은 PostgreSQL에서 이 에러를 처리하지 않았습니다. 에러는 uncaught exception으로 프로세스까지 올라갔고 애플리케이션이 종료됐습니다. 이때 메시지는 `terminating connection due to administrator command`나 `Connection terminated unexpectedly`였습니다. 데이터베이스를 재시작할 때 프로세스도 함께 종료된다면 업그레이드하세요.

### 잘못된 설정 에러

v0.9.x부터 `register()`는 연결하기 전에 옵션을 검증합니다. 검증에 실패하면 아래처럼 `ORM_INVALID_CONFIG` 에러가 납니다.

```
OrmError [ORM_INVALID_CONFIG]: Invalid database configuration:
  - 'port' must be an integer between 1 and 65535, got "3306".
```

`port`가 `.env`에서 읽은 문자열이 아니라 숫자인지 확인하세요. 필수 필드가 모두 있는지도 확인하세요.

```typescript
// 잘못된 사용
{ port: process.env.DB_PORT } // 문자열 "3306"

// 올바른 사용
{ port: parseInt(process.env.DB_PORT || "5432", 10) }
```

## 엔티티 & 데코레이터 에러

### "Entity metadata not found"

```
OrmError [ORM_ENTITY_METADATA_NOT_FOUND]: Entity metadata for "User" does not exist.
```

원인은 다음 중 하나입니다.

1. 클래스에 `@Entity()` 데코레이터가 없습니다.
2. `entities` 배열에 엔티티 클래스를 등록하지 않았습니다.
3. 진입점 파일 상단에 `import "reflect-metadata"`가 빠졌습니다.
4. 첫 번째 인자로 엔티티 클래스가 아닌 값을 넘겼습니다. 이때는 받은 값이 메시지에 나옵니다. 아래 표를 참고하세요.

```typescript
// 1. @Entity() 추가
@Entity()
class User {
  @PrimaryGeneratedColumn()
  id!: number;
}

// 2. entities 배열에 포함
await em.register({
  entities: [User], // <-- 잊지 마세요
  ...
});

// 3. 앱 최상단에서 reflect-metadata를 한 번 임포트
import "reflect-metadata";
```

EntityManager의 모든 메서드는 첫 번째 인자로 엔티티 클래스를 받습니다(`em.find(User, …)`). 다른 값을 넘기면 에러 메시지에 실제로 받은 값이 나옵니다. `"undefined"`라고만 보고하지 않습니다.

| 메시지 첫 줄 | 무슨 일이 있었나 | 해결 |
|---|---|---|
| `find() received an instance of User where the entity class was expected.` | `em.find(new User())`를 호출했거나 클래스 없이 `em.save(user)`를 호출했습니다. | 클래스를 먼저 넘깁니다: `em.save(User, user)` |
| `Entity metadata for "Plain" does not exist. find() received the class Plain, which is not decorated with @Entity() …` | 클래스에 메타데이터가 없습니다. `@Entity()`가 없거나 모듈을 임포트한 적이 없어서 데코레이터가 실행되지 않았습니다. | 데코레이터를 붙이거나 `defineEntity()`로 정의합니다. 그리고 연결하기 전에 모듈을 임포트합니다. |
| `find() received undefined where an entity class was expected.` | 임포트 결과가 `undefined`입니다. 순환 임포트이거나 `export`가 빠졌습니다. | 엔티티 모듈을 먼저 임포트해서 순환을 끊거나 export를 고칩니다. |
| `find() received the string "user" where an entity class was expected.` | 테이블 이름이나 엔티티 이름을 문자열로 넘겼습니다. | 엔티티는 이름이 아니라 클래스로 참조합니다. 클래스를 임포트해서 넘기세요. |
| `find() received an anonymous function which is not a class.` | 썽크(`() => User`)나 호출하지 않은 팩토리를 넘겼습니다. | 썽크가 반환하는 클래스를 넘깁니다. 팩토리는 호출한 결과를 넘깁니다(`defineEntity(...)`). |
| `Entity "Log" is not registered on connection "primary": its metadata exists, but …` | 클래스는 정상입니다. 하지만 이 연결의 `entities` 배열에 없습니다. | 그 연결에 추가하거나 그 클래스를 등록한 EntityManager를 사용합니다. |

모든 메시지 끝에는 해당 연결에 등록된 엔티티 클래스 목록이 붙습니다(`Registered on connection "primary": User, Post.`). 이름이 비슷한 엔티티가 있으면 `Did you mean "User"?` 힌트도 붙습니다. 에러 클래스와 코드는 모든 경우에 같습니다(`EntityMetadataNotFoundError`, `ORM_ENTITY_METADATA_NOT_FOUND`). `getRepository()`와 `createQueryBuilder()`는 첫 쿼리까지 기다리지 않고 호출하는 시점에 바로 거부합니다.

### 컬럼이 뜻하지 않게 "text"가 됨 / "No design:type metadata" 경고

```
WARN [Column] No design:type metadata for User.name — falling back to "text". ...
```

데코레이터 방식에서 ORM은 TypeScript의 `design:type` 메타데이터를 보고 컬럼 타입을 추론합니다. 이 메타데이터는 `tsc`와 `ts-node`만 생성합니다(`emitDecoratorMetadata`). tsx, esbuild, swc, Vite는 이 메타데이터를 생성하지 않습니다. 그래서 이 도구에서는 타입을 지정하지 않은 `@Column()`이 모두 `"text"`로 넘어갑니다. 그러면 실제 데이터베이스에서 숫자 컬럼과 날짜 컬럼이 깨집니다.

아래 방법 중 하나를 쓰면 해결됩니다.

1. 코드 우선 빌더로 엔티티를 정의합니다. `defineEntity`에는 데코레이터 메타데이터가 전혀 필요하지 않습니다.
2. 모든 `@Column`에 타입을 명시합니다: `@Column({ type: "int" })`
3. `tsc`로 빌드하거나 `ts-node`로 실행해서 메타데이터를 생성합니다.

관련 경고인 `Unknown design:type "Object"`는 이 속성이 객체를 담는다는 뜻이 아닙니다. `Object`는 tsc가 런타임 생성자 하나를 특정하지 못했을 때 기록하는 값입니다. `strictNullChecks`에서는 모든 유니온 타입이 `Object`가 됩니다(`string | null`, `Date | null`, `number | undefined`). 트랜스파일 전용 빌드에서는 다른 모듈에서 임포트한 enum과 타입 별칭도 `Object`가 됩니다(`isolatedModules`, swc, esbuild). 이때 컬럼은 `"text"`로 넘어갑니다. 그래서 nullable `VARCHAR`는 `TEXT`가 되고 nullable `int`는 숫자 컬럼이 아니게 됩니다. 타입을 직접 적어서 해결하세요. nullable 문자열이면 `@Column({ type: "varchar", length: 255, nullable: true })`를 씁니다. 속성이 정말로 객체를 담는다면 `@Column({ type: "json" })`를 씁니다.

배열 속성은 여기에 해당하지 않습니다. tsc는 배열 타입과 튜플 타입에만 `Array`를 기록합니다. 그래서 `@Column() tags!: string[]`는 경고 없이 `json` 컬럼으로 추론됩니다. 다만 `transformer`에 `to()`가 있는 배열 속성은 `"text"`를 유지합니다. 저장 형태를 그 쓰기 트랜스포머가 결정하기 때문입니다. 이때는 그 사실을 알리는 별도 경고가 남습니다. 읽기 전용 `transformer.from`이나 deprecated인 `transform`에는 쓰기 쪽이 없습니다. 그래서 이 경우에는 컬럼이 그대로 `json`입니다.

NestJS 없이 사용하는 전체 설정은 [Express에서 사용하기](./express.md)를 참고하세요.

### "Primary key not found"

```
OrmError [ORM_PRIMARY_KEY_NOT_FOUND]: Primary key for entity "User" was not found.
```

모든 엔티티에는 기본 키 컬럼이 하나 이상 있어야 합니다.

```typescript
@Entity()
class User {
  @PrimaryGeneratedColumn() // 자동 증가
  id!: number;

  // 또는 UUID
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  // 또는 직접 지정하는 기본 키
  @PrimaryColumn()
  code!: string;
}
```

### 컬럼이 데이터베이스에 저장되지 않음

클래스에 있는 속성이 저장되지 않는다면 `@Column()`을 빠뜨렸을 가능성이 큽니다.

```typescript
@Entity()
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column() // <-- 저장하는 모든 속성에 필요합니다
  name!: string;

  bio: string; // @Column()이 없어서 저장되지 않습니다
}
```

엔티티가 선언하지 않은 키가 쓰기에 들어오면 ORM이 이를 보고합니다. `save()`를 비롯한 삽입 계열 메서드는 엔티티와 키마다 한 번 `[WriteInput] Unknown key "bio" in the data passed to save() for entity "User"` 로그를 남깁니다. 비슷한 이름이 있으면 `Did you mean` 제안도 붙습니다. 이런 쓰기를 아예 거부하려면 연결 옵션에 `unknownWriteKeys: "throw"`를 지정하세요. 아래 `"Unknown column"` 항목과 쓰기 가이드의 *쓰기 페이로드의 미지 키* 절도 참고하세요.

## 쿼리 에러

### N+1 쿼리 문제

로그에 아래와 같은 쿼리가 반복해서 나온다면 N+1 문제입니다.

```
SELECT * FROM "post" WHERE "author_id" = 1
SELECT * FROM "post" WHERE "author_id" = 2
SELECT * FROM "post" WHERE "author_id" = 3
```

N+1 감지를 켜고 즉시 로딩을 사용하세요.

```typescript
// 감지 활성화
await em.register({
  logging: { nPlusOne: true },
  ...
});

// 해결: 관계를 미리 로드
const users = await em.find(User, {
  relations: ["posts"],
});
```

### where / orderBy / select / groupBy / criteria / data의 "Unknown column"

```
InvalidQueryError: Unknown column "userNam" in "where" for entity "User". Did you mean "userName"?
```

키가 해당 엔티티의 어떤 컬럼과도 일치하지 않는다는 뜻입니다. 읽기(`find`, `findOne`, `count`, `sum` 등)와 벌크 쓰기(`update`, `delete`)는 모두 SQL을 만들기 전에 키를 검사합니다. 에러의 `suggestion`에는 허용되는 이름이 모두 나옵니다.

따옴표 안의 절 이름은 그 키가 들어온 인자를 가리킵니다.

- `delete`, `softDelete`, `restore`의 조건은 `"criteria"`입니다.
- 읽기와 `updateMany`의 조건은 `"where"`입니다.
- `updateMany`의 SET 페이로드는 `"data"`입니다.
- `unknownWriteKeys: "throw"`이면 `save`, `saveMany`, `insertMany`, `insertManyAndReturn`, `upsert`, `insertIgnore`, `batchUpsert`의 페이로드도 `"data"`입니다. 기본값 `"warn"`에서는 에러를 던지지 않고 같은 키를 한 번 로그로 남깁니다.

`AND`, `OR`, `NOT`은 안쪽 조건을 차례로 검사할 뿐 컬럼으로 보고되지 않습니다. `updateMany`의 `data`에 결합자가 들어오면 별도 메시지로 실패합니다(`Logical combinator "OR" is not allowed in the update data`). 결합자는 `where`에 두세요.

읽기와 `updateMany`에서 허용되는 키는 다음과 같습니다.

- 속성 이름
- DB 컬럼 이름
- `@ManyToOne`과 `@OneToOne`의 외래 키 섀도 속성
- `@ComputedColumn` 이름
- 단일 테이블 상속의 구분 컬럼(discriminator column)
- 단일 테이블 상속에서 같은 테이블을 공유하는 형제 클래스의 컬럼

삽입 계열 쓰기 페이로드는 여기에 더해 관계 속성도 받습니다. 하지만 DB 컬럼 이름은 받지 않습니다. INSERT는 속성 키만 읽기 때문입니다. 그래서 `save(Team, { team_name })`은 `Did you mean "teamName"?`과 함께 보고됩니다.

```typescript
// 엔티티가 다음과 같다면:
@Column({ name: "user_name" })
name!: string;

await em.find(User, { where: { name: "Alice" } });      // 속성 이름 (권장)
await em.find(User, { where: { user_name: "Alice" } }); // DB 컬럼 이름도 허용
await em.find(User, { where: { userName: "Alice" } });  // 둘 다 아니므로 에러
```

관계 속성은 컬럼이 아닙니다. 외래 키로 거르세요(`where: { authorId: 1 }`). 관련 행에 조건을 걸려면 관계 필터를 쓰세요(`where: { author: { is: { name: "Ada" } } }`). `author: { id: 1 }`처럼 평범한 객체를 넘기면 `"author" (where.author) is a relation` 에러로 거부됩니다.

### "... column but received an array / an object"

```
InvalidQueryError: Post.tags is a "text" column but save() received an array, which cannot be bound as one value:
better-sqlite3 would spread it over 2 values and shift every value after it.
```

JS 배열이나 일반 객체를 파라미터 하나로 바인딩하는 드라이버는 없습니다. 그리고 값이 어긋나는 방식은 드라이버마다 다릅니다.

- better-sqlite3는 배열을 위치 플레이스홀더 여러 개에 펼쳐 넣습니다. 일반 객체는 이름 파라미터 묶음으로 읽습니다. 이 묶음은 어떤 플레이스홀더도 채우지 않습니다.
- mysql2는 배열을 값 목록으로 펼칩니다. 객체는 `'[object Object]'`로 렌더링합니다.
- `pg`는 배열 리터럴이나 JSON 텍스트를 보냅니다.

개수가 우연히 맞으면 모든 값이 한 컬럼씩 왼쪽으로 밀린 채 행이 저장됩니다. 그리고 이 사실을 알리는 에러나 경고가 없습니다. 그래서 ORM이 바인딩하기 직전에 값을 먼저 검사합니다. 에러 메시지에는 엔티티 속성, 선언된 컬럼 타입, 그 값을 만든 연산이 나옵니다. 지금 쓰는 드라이버가 그 값을 어떻게 처리했을지도 함께 나옵니다.

이 검사는 `save`, `saveMany`, `insertMany`, `insertManyAndReturn`, `upsert`, `insertIgnore`, `batchUpsert`, `createInsertBuilder()`, `update`, `updateMany`, `createUpdateBuilder().set()`에서 똑같이 동작합니다. 검사는 컬럼의 쓰기 변환을 거친 뒤의 값을 봅니다. 그래서 문자열을 반환하는 `transformer.to`는 그대로 동작합니다. 값을 스스로 직렬화하는 `json` 컬럼도 이 검사에 걸리지 않습니다.

해결 방법은 다음과 같습니다.

1. 컬럼을 `json`으로 선언합니다: `@Column({ type: "json" }) tags!: string[]`. `type`을 지정하지 않은 배열 속성은 `json`으로 추론됩니다. 그러므로 이 에러가 났다면 다른 타입이 선언돼 있다는 뜻입니다.
2. PostgreSQL이라면 네이티브 배열 컬럼인 `@Column({ type: "array" })`를 씁니다.
3. 저장 형태를 직접 정하려면 `to()`가 문자열이나 숫자를 반환하는 `transformer`를 지정하세요(`["a", "b"]` -> `"a,b"`).
4. 외래 키라면 관계 대상 객체 대신 키 값을 넘기세요: `updateMany(Post, { authorId: 7 }, …)`.

raw SQL 쿼리는 컬럼 정보 없이 드라이버로 바로 전달됩니다. 그래서 드라이버가 지원하는 값 형태를 그대로 받습니다. 예외는 SQLite뿐입니다. SQLite에서 `em.query("SELECT ?, ?", [[1, 2]])`는 이제 `SQLite cannot bind an array as one parameter` 에러를 던집니다. better-sqlite3라면 그 배열을 두 플레이스홀더에 펼쳐 넣었을 것이기 때문입니다. 이름 파라미터 묶음(`em.query("SELECT :a", [{ a: 1 }])`)은 그대로 동작합니다. MySQL의 `IN (?)`와 `VALUES ?` 관용구도 MySQL에서 계속 동작합니다.

### falsy 값을 가진 WHERE 절

`0`, `false`, `""`는 유효한 값입니다. where 절에서도 정상적으로 동작합니다.

```typescript
await em.find(User, { where: { age: 0 } });        // age = 0인 사용자 조회
await em.find(User, { where: { active: false } });  // 비활성 사용자 조회
```

예외는 `undefined` 하나입니다. 여기서 `undefined`는 falsy 값으로 취급하지 않습니다. 이 키를 설정하지 않았다는 뜻으로 보고 해당 필드를 쿼리에서 뺍니다. 반면 `null`은 값이므로 `IS NULL`이 됩니다.

```typescript
await em.find(User, { where: { age: undefined } });  // 필터 없음: 전체 사용자
await em.find(User, { where: { age: null } });       // WHERE "age" IS NULL
```

### "Every value in the where ... is undefined"

```
InvalidQueryError: Every value in the "where" passed to findOne() for entity
"User" is undefined (id) — the query would read an arbitrary row.
```

단건 조회(`findOne`, `findOneBy`, `findOneOrFail`, `findOneByOrFail`)나 `exists()`가 받은 `where`에 필드는 있지만 정의된 값이 하나도 없다는 뜻입니다. 조건이 모두 빠졌으므로 이대로라면 쿼리는 필터 없이 실행됩니다. 그러면 데이터베이스가 먼저 반환하는 행이 결과가 됩니다. 원인은 대개 검증하지 않은 선택적 값입니다.

```typescript
const id = req.query.id as string | undefined;   // "?id=" 누락 -> undefined
await em.findOne(User, { where: { id } });
```

필드를 빼지 말고 값이 들어오는 지점에서 검증하거나 타입을 좁히세요.

```typescript
if (id === undefined) throw new BadRequestException("id is required");
await em.findOne(User, { where: { id } });
```

정말로 아무 행이나 원한다면 그렇게 적으세요. `findOne(User, {})`과 `findOne(User, { where: {} })`은 필터 없이 조회하며 허용됩니다. 이 검사는 명시한 필드가 모두 undefined일 때만 동작합니다. 정의된 필드와 undefined 필드가 섞여 있으면 undefined인 필드만 빠집니다. 그러므로 권한을 확인하는 조회라면 입력값을 반드시 검증해야 합니다. 자세한 내용은 [undefined 값](./entity-manager-querying.md#undefined-값)을 참고하세요.

기본 키 조회는 `where`를 만들기 전에 키를 먼저 검사합니다. 그래서 다른 메시지로 보고합니다.

```
InvalidQueryError: findByPK() received undefined as the primary key of "User".
InvalidQueryError: findByPK() received no value for primary key column "userId" of "Member".
InvalidQueryError: findByPKs() received undefined at index 1 as a primary key of "User".
```

원인과 해결 방법은 같습니다. 호출하기 전에 값을 검증하세요. 복합 키라면 키 속성을 모두 넘겨야 합니다. 이때 키는 속성 이름과 컬럼 이름 중 어느 쪽으로 적어도 됩니다. 여기서도 `null`은 값이므로 `IS NULL`로 매칭됩니다.

### "Operator ... received undefined" / "The OR branch ... resolves to no condition"

```
InvalidQueryError: Operator "gt" on "score" received undefined.
InvalidQueryError: The OR branch OR[0] resolves to no condition, so the OR
would match every row.
```

연산자의 피연산자는 명시적인 비교입니다. 이전 버전에서는 여기에 들어간 `undefined`가 다음처럼 처리됐습니다.

- `= NULL`이 되어 아무 행도 매칭하지 않았습니다.
- `in`, `between`, `contains`에서는 raw `TypeError`가 났습니다.
- `isNull: undefined`는 `IS NOT NULL`로 뒤집혀 null이 아닌 모든 행을 매칭했습니다.

연산자는 값이 있을 때만 붙이세요.

```typescript
await em.find(Post, {
  where: { score: { ...(min !== undefined && { gte: min }) } },
});
```

두 번째 메시지는 `OR` 분기나 배열 형태의 원소가 아무 조건도 만들지 못했다는 뜻입니다. 빈 객체이거나 값이 모두 undefined인 분기가 그렇습니다. 빈 분기는 TRUE입니다. 그래서 OR로 묶으면 모든 행이 반환됩니다. 그 분기를 없애거나 정의된 값을 하나 이상 넣으세요.

### "Invalid options passed to find()" / "Invalid where for entity ..."

```
InvalidQueryError: Invalid options passed to find() for entity "Post":
  - 'take' must be a non-negative integer, got "10".
  - Unknown option 'wher'. Did you mean 'where'?
InvalidQueryError: Invalid where for entity "Post": unknown operator "lik" on
"title" (where.title). Did you mean "like"?
```

옵션을 객체 리터럴로 쓰면 이런 모양은 TypeScript가 먼저 막습니다. 그래서 이 에러는 보통 런타임에 만든 옵션에서 납니다. 쿼리 스트링, JSON 본문, 스프레드한 DTO가 그 예입니다. 읽기 옵션은 `find`, `findOne`, `findAndCount`, `findWithPage`, `findWithCursor`, `stream`, `streamBatch`, `explain`을 호출하는 시점에 검사합니다. 그리고 문제를 에러 하나에 모두 나열합니다. where는 쓰이는 곳마다 검사합니다. 읽기, `count`, `exists`, 집계, 관계 필터, 그리고 `delete`, `softDelete`, `restore`, `updateMany`의 criteria가 여기에 해당합니다. ORM은 값을 대신 변환하지 않습니다. 예를 들어 `"10"`은 `10`으로 읽히지 않습니다.

| 메시지 | 이렇게 썼을 때 | 이렇게 고치세요 |
|--------|----------------|-----------------|
| `'take' must be a non-negative integer, got "10"` | `take: req.query.take` | `take: Number(req.query.take)`. `skip`, `limit`, `page`, `pageSize`도 같습니다 |
| `'limit' must be a count or an [offset, count] pair` | `limit: [0]` | `limit: 10` 또는 `limit: [0, 10]` |
| `'orderBy' must be an object keyed by property` | `orderBy: "title"` | `orderBy: { title: "ASC" }` |
| `Unknown option 'wher'` | 옵션 이름 오타 | 메시지에 나온 옵션 이름 |
| `unknown operator "lik" on "title"` | `title: { lik: "%a%" }` | `title: { like: "%a%" }` |
| `"title" (where.title) is an empty object` | `title: {}` | 연산자를 넣거나 필드를 빼세요 |
| `operator "in" on "title" ... needs an array` | `title: { in: "a" }` | `title: { in: ["a"] }` 또는 `title: { eq: "a" }` |
| `operator "between" ... needs [min, max]` | `views: { between: [1] }` | `views: { between: [1, 9] }`, 또는 `gte` / `lte` |
| `operator "contains" ... needs a string` | `title: { contains: 5 }` | `title: { contains: "5" }`. `like`, `startsWith`, `endsWith`, `search`도 같습니다 |
| `operator "isNull" ... needs true or false` | `title: { isNull: "no" }` | `title: { isNull: false }` |
| `operator "eq" ... needs a single value` | `views: { eq: [1, 2] }` | `views: { in: [1, 2] }` |
| `where.OR takes an array of where objects` | `OR: { a: 1 }` | `OR: [{ a: 1 }, { b: 2 }]`. `AND`도 같습니다 |
| `where.NOT takes one where object` | `NOT: [{ a: 1 }, { b: 2 }]` | `NOT: { OR: [{ a: 1 }, { b: 2 }] }` |
| `"author" (where.author) is a relation` | `author: { id: 1 }` | `author: { is: { id: 1 } }` 또는 `authorId: 1` |
| `expected an object or an array of objects` | `delete(Post, 1)`, `count(Post, "1")` | `delete(Post, { id: 1 })` |
| `criteria[0] must be an object` | `delete(Post, [1, 2])` | `deleteMany(Post, [1, 2])` 또는 `delete(Post, { id: { in: [1, 2] } })` |
| `findOneBy() ... takes a where object` | `findOneBy(Post, 1)` | `findOneBy(Post, { id: 1 })` 또는 `findByPK(Post, 1)` |
| `'orderBy' names one property to sort by` | `findWithCursor(Post, { orderBy: { createdAt: "DESC" } })` | `{ orderBy: "createdAt", direction: "DESC" }` |
| `createQueryBuilder(Post) needs an alias` | `createQueryBuilder(Post)` | `createQueryBuilder(Post, "p")` |

값이 `undefined`나 `null`인 옵션은 설정하지 않은 것으로 봅니다. 그래서 `take: null`은 모든 행을 조회합니다. 일부 컬럼에서는 연산자가 아닌 키가 하나라도 있는 객체를 비교할 값으로 취급합니다(`where: { settings: { theme: "dark" } }`). `json`, `jsonb`, `array` 컬럼, 커스텀 타입이나 `transformer`가 붙은 컬럼, `@ComputedColumn`이 여기에 해당합니다. 이런 컬럼에서는 연산자로만 이루어진 객체만 검사합니다.

## 관계 에러

### 관계 데이터가 로드되지 않음

관계는 기본적으로 지연 로딩입니다. 그래서 관계가 필요하면 명시적으로 요청해야 합니다.

```typescript
// 이렇게 하면 posts가 로드되지 않습니다
const user = await em.findOne(User, { where: { id: 1 } });
console.log(user.posts); // undefined

// 이렇게 하면 posts가 로드됩니다
const user = await em.findOne(User, {
  where: { id: 1 },
  relations: ["posts"],
});
console.log(user.posts); // Post[]
```

ManyToOne이나 OneToOne 관계라면 `eager`로 표시하는 방법도 있습니다.

```typescript
@ManyToOne(() => User, (user) => user.posts, { eager: true })
author!: User;
```

OneToMany와 ManyToMany 컬렉션에는 `eager` 옵션이 없습니다. 이런 관계는 `relations`에 이름을 적어서 로드하세요.

### `select`와 함께 쓰면 관계가 `[]`(또는 `null`)로 반환될 때

```typescript
const users = await em.find(User, { select: ["name"], relations: ["posts"] });
// users[0].posts → 게시글이 있는데도 모든 사용자에서 []
```

OneToMany, ManyToMany, OneToOne 역방향 측 관계는 JOIN하지 않고 두 번째 쿼리로 로드합니다. 이 쿼리는 부모의 기본 키로 관련 행을 짝짓습니다. 이전 릴리스는 `select`를 적힌 그대로 보냈습니다. 그래서 기본 키를 뺀 `select`는 키가 없는 부모를 만들었습니다. 그러면 로더가 쿼리를 건너뛰었고 관련 행이 있어도 부모마다 `[]`가 채워졌습니다. OneToOne이면 `null`이 채워졌습니다. 이때 에러도 나지 않았습니다.

지금은 ORM이 기본 키를 함께 조회하고 반환된 객체에도 남겨 둡니다. 그래서 위 쿼리도 게시글을 로드합니다. 이전 릴리스를 쓰고 있다면 키를 직접 적으세요.

```typescript
const users = await em.find(User, { select: ["id", "name"], relations: ["posts"] });
```

자세한 내용은 [select와 relations 함께 쓰기](./entity-manager-querying.md#select와-relations-함께-쓰기)를 참고하세요.

### distinct / groupBy와 함께 쓸 때 "Cannot load ..."

```
InvalidQueryError: Cannot load "posts" for entity "User" in a "distinct" read whose "select"
omits primary key column "id". "posts" is matched to each row by that key, and adding the key
to the SELECT list would change which rows DISTINCT removes.
```

행을 합치는 쿼리에는 위에서 설명한 기본 키를 추가할 수 없습니다. 이유는 다음과 같습니다.

- `distinct: true`라면 키를 추가하는 순간 남는 행이 달라집니다.
- `groupBy`에 키 컬럼이 모두 들어 있지 않으면 그룹마다 관련 행을 짝지을 부모가 하나로 정해지지 않습니다. 그룹으로 묶인 행의 키는 구성원 중 아무 하나의 키입니다. 그래서 그 구성원의 관련 행이 그룹 전체에 붙게 됩니다.

ORM은 경고 없이 다른 행을 반환하는 대신 쿼리를 거부합니다. 다음 중 하나를 고르세요.

- 기본 키를 추가합니다. `distinct`라면 `select`에, `groupBy`라면 `groupBy`에 추가합니다.
- 이 쿼리에서 `distinct`나 `groupBy`를 뺍니다.
- 관계는 별도 `find()`로 로드합니다.

`groupBy`가 있는 쿼리는 그룹 기준만 보고 거부 여부를 판단합니다. `select`에 키를 적어도 거부가 풀리지 않습니다. 그룹으로 묶인 행은 여전히 여러 부모를 대표하기 때문입니다.

```typescript
// 거부됩니다: "name"으로 묶으면 여러 사용자가 임의의 id 하나로 합쳐집니다
await em.find(User, { select: ["id", "name"], groupBy: ["name"], relations: ["posts"] });
```

### "Unknown relation ... in relations"

```
InvalidQueryError: Unknown relation "autor" in "relations" for entity "Post".
Available relations: [author (ManyToOne), tags (ManyToMany)]. Did you mean "author"?
```

`relations`에 적는 이름은 해당 엔티티에 `@ManyToOne`, `@OneToMany`, `@ManyToMany`, `@OneToOne`으로 선언한 관계 속성이어야 합니다. 로더가 매칭에 쓰는 이름과 같습니다. 외래 키 컬럼 이름이 아니라 속성 이름을 적습니다.

중첩 경로는 단계마다 그 단계가 가리키는 엔티티를 기준으로 검사합니다. 에러 메시지에는 요청한 경로도 함께 나옵니다.

```
InvalidQueryError: Unknown relation "profil" in "relations" for entity "User" (requested as "author.profil").
Available relations: [posts (OneToMany), profile (OneToOne)]. Did you mean "profile"?
```

객체 형식에서 관계가 받지 않는 옵션 키를 넣어도 같은 방식으로 보고합니다(`Unknown option "wher" for relation "comments"`). 자세한 내용은 [중첩 관계](./relations.md#중첩-관계)를 참고하세요.

대상 엔티티 썽크가 아무것도 반환하지 않는 관계도 같은 방식으로 걸러 냅니다(`... target thunk returned no entity class`). 원인은 대부분 엔티티 모듈 사이의 순환 임포트입니다. 대상은 데코레이터의 `() => Entity` 썽크 안에 두세요. 그리고 단일 값 관계 속성은 `Relation<Target>`으로 선언하세요.

### register() 시점의 "Invalid relation mapping"

```
OrmError: Invalid relation mapping (connection "default"):
  - User.posts: @OneToMany mappedBy "autor" names no @ManyToOne on Post. Did you mean "author"?
  - Post.tags: @ManyToMany declares neither joinTable nor mappedBy, so the relation has no join table. Tag.posts declares one: add mappedBy: "posts".
```

`register()`는 테이블을 만들기 전에 등록하는 엔티티의 관계를 모두 검사합니다. 그리고 해석되지 않는 관계를 한 번에 나열합니다. 각 줄은 그 관계를 선언한 엔티티 속성으로 시작합니다.

| 줄 | 원인 | 해결 |
|---|---|---|
| `mappedBy "x" names no @ManyToOne on Target` | 대상에 `@OneToMany`의 `mappedBy`와 일치하는 `@ManyToOne` 속성이 없습니다. `t.oneToMany`라면 두 번째 인자가 `mappedBy`입니다. | 대상의 `@ManyToOne` 속성 이름을 적습니다. 외래 키 컬럼 이름도 받습니다. |
| `inverseSide "x" names no owning @OneToOne on Target` | 역방향 `@OneToOne`이 조인 컬럼을 가진 `@OneToOne`을 가리키지 않습니다. | 대상의 소유 측 `@OneToOne` 속성 이름을 적습니다. |
| `... which holds no join column either` | `@OneToOne` 양쪽이 모두 역방향 측입니다. | 한쪽에 `@RelationColumn`으로 조인 컬럼을 지정합니다. 다른 쪽은 `inverseSide`로 그쪽을 가리킵니다. |
| `declares neither joinTable nor mappedBy` | `@ManyToMany`의 조인 테이블을 알 수 없습니다. | 소유 측에 `joinTable`을, 역방향 측에 `mappedBy`를 선언합니다. 대상 쪽에 이미 조인 테이블이 있으면 메시지에 그 속성이 나옵니다. |
| `mappedBy "x" names Target.x, which declares no joinTable either` | `@ManyToMany` 양쪽이 서로를 `mappedBy`로 가리킵니다. | 한쪽의 `mappedBy`를 `joinTable`로 바꿉니다. |
| `declares joinTable "x" with columns ..., but Other.prop already declares it with ...` | 두 `@ManyToMany`가 조인 테이블 하나를 서로 다른 컬럼이나 다른 테이블로 선언했습니다. 스키마에는 이름마다 테이블이 하나만 만들어지므로 두 번째 관계는 첫 번째 관계용 테이블을 쓰게 됩니다. `synchronize`가 스키마를 만들 때와 `migrate:generate`에서 검사합니다. | 관계마다 조인 테이블 이름을 따로 줍니다. 두 선언이 관계 하나의 양쪽이라면 한쪽에만 `joinTable`을 두고 다른 쪽은 `mappedBy`로 가리킵니다. |
| `targets X, which is not in this connection's entities` | 관계 대상이 `entities`에 없어서 테이블이 만들어지지 않습니다. | 대상을 `entities`에 추가합니다. 목록에 있는 클래스의 자식이나 부모는 목록에 있는 것으로 칩니다. |
| `targets X, which is not an entity` | 대상 클래스에 `@Entity()`가 없습니다. | 데코레이터를 붙입니다. |
| `targets undefined: the target class was not defined yet` | 클래스가 정의되기 전에 대상 썽크가 실행됐습니다. 대개 순환 임포트 때문입니다. | 대상을 `() => Target` 안에 둡니다. 그리고 단일 값 속성의 타입은 `Relation<Target>`으로 적습니다. |

`attach()`는 이 검사를 건너뜁니다. attach한 EntityManager는 다른 등록이 소유한 테이블 중 일부만 범위로 잡을 수 있기 때문입니다.

### 저장할 때 "Relation ... holds a new row"

```
[WriteInput] Relation "posts" in the data passed to save() for entity "User" holds a new row (no primary key value), but the @OneToMany has no cascade ["insert"], so the row is not written.
```

기본 키 값이 없는 관계 객체는 새 행입니다. 새 행은 save 캐스케이드로만 저장됩니다. 관계의 `cascade`에 `"insert"`나 `"update"`가 없으면 `save()`는 사용자만 저장하고 게시글은 저장하지 않습니다. `insertMany()`, `upsert()`, `insertIgnore()`, `batchUpsert()`는 캐스케이드를 실행하지 않습니다. 그래서 cascade 설정과 관계없이 새 관계 행을 보고합니다. 캐스케이드를 추가하거나 관계 행을 먼저 따로 저장하세요.

키가 있는 관계 객체는 보고하지 않습니다. 관계와 함께 조회한 엔티티를 다시 저장하는 경우가 그렇습니다. 보고 방식은 `unknownWriteKeys` 정책을 따릅니다.

- 기본값에서는 엔티티와 관계마다 한 번 로그를 남깁니다.
- `"throw"`이면 `InvalidQueryError`로 거부합니다.
- `"ignore"`이면 아무것도 남기지 않습니다.

### 순환 관계 에러

두 엔티티가 서로를 참조할 때는 `() => Entity`처럼 함수로 대상을 참조하세요.

```typescript
// 순환 임포트 문제를 피하려면 () => Entity를 사용합니다
@ManyToOne(() => Author, (author) => author.posts)
author!: Author;

@OneToMany(() => Post, { mappedBy: "author" })
posts!: Post[];
```

## SQLite 관련 이슈

### SQLite에서 지원되지 않는 기능

SQLite는 다음을 지원하지 않습니다.

- `ALTER COLUMN` (타입 변경, 이름 변경)
- `DROP COLUMN` (SQLite 3.35.0 이전)
- `ENUM` 타입 (대신 `varchar` 사용)
- 스키마 네임스페이스
- 여러 쓰기 트랜잭션의 동시 실행

파괴적 작업을 피하려면 `synchronize: "safe"`를 사용하세요.

```typescript
await em.register({
  type: "sqlite",
  database: "./mydb.sqlite",
  synchronize: "safe", // 테이블 생성과 컬럼 추가만 수행
  entities: [User],
});
```

## 마이그레이션 에러

### "Migration table already exists"

이 테이블 자체는 정상입니다. ORM은 적용한 마이그레이션을 추적하려고 `__migrations` 테이블을 생성합니다. 이 테이블이 이미 있다는 에러가 보인다면 여러 프로세스가 동시에 마이그레이션을 실행해서 생긴 경쟁 상태(race condition)일 가능성이 큽니다. 마이그레이션은 프로세스 하나에서만 실행하세요.

### 생성된 마이그레이션에 TODO가 있음

`migrate:generate`가 TODO 주석이 들어간 불완전한 SQL을 생성했다면 스키마 diff가 정확한 DDL을 결정하지 못했다는 뜻입니다. 실행하기 전에 생성된 파일을 직접 수정하세요.

```bash
# 생성
npx stingerloom migrate:generate -n AddUserEmail

# 생성된 파일을 검토하고 수정한 다음 실행
npx stingerloom migrate:run
```

## Synchronize 모드

| 모드 | 테이블 생성 | 컬럼 추가 | 컬럼 변경 | 컬럼 삭제 |
|------|:-:|:-:|:-:|:-:|
| `true` | Yes | Yes | Yes | Yes |
| `"safe"` | Yes | Yes | No | No |
| `"dry-run"` | 로그만 | 로그만 | 로그만 | 로그만 |
| `false` | No | No | No | No |

권장: `synchronize: true`는 개발 환경에서만 사용하세요. 프로덕션에서는 마이그레이션을 사용하세요.

## 디버깅 팁

### SQL 로깅 활성화

```typescript
await em.register({
  logging: {
    queries: true,       // 모든 SQL 쿼리 로그
    slowQueryMs: 1000,   // 1초 이상 걸린 쿼리 경고
    nPlusOne: true,      // N+1 패턴 감지
  },
  ...
});
```

### EXPLAIN으로 쿼리 분석

```typescript
const plan = await em.explain(User, {
  where: { status: "active" },
  relations: ["posts"],
});
console.log(plan);
```

### 엔티티 메타데이터 확인

```typescript
import { ENTITY_TOKEN } from "@stingerloom/orm";

const meta = Reflect.getMetadata(ENTITY_TOKEN, User);
console.log(meta); // { name, columns, relations, ... }
```
