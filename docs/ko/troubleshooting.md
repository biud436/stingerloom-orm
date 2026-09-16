# 트러블슈팅

자주 발생하는 문제와 해결 방법.

## 연결 오류

### "Database not connected"

```
OrmError [ORM_NOT_CONNECTED]: Database connection has not been established.
```

**원인:** `em.register()`가 끝나기 전에 쿼리 메서드를 호출했습니다.

```typescript
// 잘못된 사용 -- register는 비동기
const em = new EntityManager();
em.register({ ... }); // await을 잊었습니다
const users = await em.find(User); // 예외 발생

// 올바른 사용
await em.register({ ... });
const users = await em.find(User);
```

### "Connection refused" 또는 "ECONNREFUSED"

데이터베이스 서버가 실행 중이 아니거나 호스트/포트가 잘못되었습니다.

```bash
# 데이터베이스가 실행 중인지 확인
# PostgreSQL
pg_isready -h localhost -p 5432

# MySQL
mysqladmin ping -h localhost -P 3306

# SQLite -- 서버가 필요 없으니 파일 경로 확인
ls ./mydb.sqlite
```

### 잘못된 설정 오류

v0.9.x부터 `register()`는 연결 전에 옵션을 검증합니다. `ORM_INVALID_CONFIG`가 보인다면:

```
OrmError [ORM_INVALID_CONFIG]: Invalid database configuration:
  - 'port' must be an integer between 1 and 65535, got "3306".
```

`port`가 숫자인지(`.env`에서 가져온 문자열이 아닌지) 확인하고 모든 필수 필드가 있는지 확인하세요.

```typescript
// 잘못된 사용
{ port: process.env.DB_PORT } // 문자열 "3306"

// 올바른 사용
{ port: parseInt(process.env.DB_PORT || "5432", 10) }
```

## 엔티티 & 데코레이터 오류

### "Entity metadata not found"

```
OrmError [ORM_ENTITY_METADATA_NOT_FOUND]: Entity metadata for "User" does not exist.
```

**원인:**
1. 클래스에 `@Entity()` 데코레이터가 없음
2. `entities` 배열에 엔티티 클래스가 등록되지 않음
3. 진입점 파일 상단에 `import "reflect-metadata"`가 빠짐
4. 첫 번째 인자로 엔티티 클래스가 아닌 것을 넘김 — 무엇을 받았는지 메시지가 알려줍니다(아래 표 참고)

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

// 3. reflect-metadata 임포트 (앱 최상단에서 한 번)
import "reflect-metadata";
```

EntityManager의 모든 메서드는 첫 번째 인자로 엔티티 **클래스**를 받습니다(`em.find(User, …)`). 다른 것을 넘기면 `"undefined"`라고만 보고하는 대신, 실제로 무엇을 받았는지 에러가 알려줍니다.

| 메시지 첫 줄 | 무슨 일이 있었나 | 해결 |
|---|---|---|
| `find() received an instance of User where the entity class was expected.` | `em.find(new User())`, 또는 클래스 없이 `em.save(user)`를 호출 | 클래스를 먼저 넘깁니다: `em.save(User, user)` |
| `Entity metadata for "Plain" does not exist. find() received the class Plain, which is not decorated with @Entity() …` | 클래스에 메타데이터가 없음 — `@Entity()`가 없거나, 모듈이 임포트된 적이 없어 데코레이터가 실행되지 않음 | 데코레이터를 붙이거나 `defineEntity()`로 정의하고, 연결 전에 모듈을 임포트합니다 |
| `find() received undefined where an entity class was expected.` | 임포트 결과가 `undefined` — 순환 임포트이거나 `export`가 빠짐 | 순환을 끊거나(엔티티 모듈을 먼저 임포트) export를 고칩니다 |
| `find() received the string "user" where an entity class was expected.` | 테이블 이름이나 엔티티 이름 문자열을 넘김 | 엔티티는 이름이 아니라 클래스로 참조합니다 — 클래스를 임포트해서 넘기세요 |
| `find() received an anonymous function which is not a class.` | 썽크(`() => User`)나 호출하지 않은 팩토리를 넘김 | 썽크가 반환하는 클래스를 넘기고, 팩토리는 호출(`defineEntity(...)`)한 결과를 넘깁니다 |
| `Entity "Log" is not registered on connection "primary": its metadata exists, but …` | 클래스는 정상이지만 이 연결의 `entities` 배열에 없음 | 그 연결에 추가하거나, 등록한 EntityManager로 조회합니다 |

모든 메시지 끝에는 해당 연결에 등록된 엔티티 클래스 목록(`Registered on connection "primary": User, Post.`)이 붙고, 이름이 비슷한 엔티티가 있으면 `Did you mean "User"?` 힌트가 따라옵니다. 에러 클래스와 코드는 모든 경우에 동일하고(`EntityMetadataNotFoundError`, `ORM_ENTITY_METADATA_NOT_FOUND`), `getRepository()` / `createQueryBuilder()`는 첫 쿼리가 아니라 호출 시점에 바로 거부해요.

### 컬럼이 뜻하지 않게 "text"가 됨 / "No design:type metadata" 경고

```
WARN [Column] No design:type metadata for User.name — falling back to "text". ...
```

데코레이터 스타일은 TypeScript의 `design:type` 메타데이터로 컬럼 타입을 추론하는데, 이 메타데이터는 `tsc`와 `ts-node`만 생성합니다(`emitDecoratorMetadata`). **tsx, esbuild, swc, Vite는 이를 생성하지 않아서** 타입을 지정하지 않은 `@Column()`이 전부 `"text"`로 강등되고, 실제 데이터베이스에서는 숫자·날짜 컬럼이 깨집니다.

다음 중 하나로 해결할 수 있습니다.

1. 코드 우선 빌더로 엔티티 정의 — `defineEntity`는 데코레이터 메타데이터가 아예 필요 없습니다
2. 모든 `@Column`에 타입 명시: `@Column({ type: "int" })`
3. `tsc`로 빌드하거나 `ts-node`로 실행해 메타데이터를 생성

관련 경고인 `Unknown design:type "Object"`는 "이 프로퍼티가 객체다"라는 뜻이 **아닙니다**. `Object`는 tsc가 런타임 생성자 하나를 지목하지 못했을 때 남기는 값이에요. `strictNullChecks` 아래에서는 모든 유니온이 여기로 지워지고(`string | null`, `Date | null`, `number | undefined`), 트랜스파일 전용 빌드(`isolatedModules`, swc, esbuild)에서는 다른 모듈에서 import한 enum과 타입 별칭도 `Object`가 됩니다. 이때 컬럼은 `"text"`로 폴백되므로 nullable `VARCHAR`가 슬그머니 `TEXT`가 되고 nullable `int`는 숫자가 아니게 돼요. 타입을 직접 적어서 해결하세요. nullable 문자열이면 `@Column({ type: "varchar", length: 255, nullable: true })`, 정말로 객체를 담는다면 `@Column({ type: "json" })`입니다.

배열 프로퍼티는 여기에 해당하지 않아요. tsc가 배열과 튜플 타입에만 `Array`를 내보내기 때문에 `@Column() tags!: string[]`는 경고 없이 `json` 컬럼으로 추론됩니다. `transformer`에 `to()`가 있는 배열 프로퍼티만 `"text"`를 유지하고(저장 형태는 그 쓰기 트랜스포머가 결정하니까요) 그 사실을 알리는 별도 경고를 남깁니다. 읽기 전용 `transformer.from`이나 더 이상 권장하지 않는 `transform`은 쓰기 쪽이 없으므로 컬럼이 `json` 그대로입니다.

NestJS 없이 사용하는 전체 설정은 [Express에서 사용하기](./express.md)를 참고하세요.

### "Primary key not found"

```
OrmError [ORM_PRIMARY_KEY_NOT_FOUND]: Primary key for entity "User" was not found.
```

모든 엔티티는 최소 하나의 기본 키 컬럼이 필요합니다:

```typescript
@Entity()
class User {
  @PrimaryGeneratedColumn() // 자동 증가
  id!: number;

  // 또는 UUID
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  // 또는 수동 PK
  @PrimaryColumn()
  code!: string;
}
```

### 컬럼이 데이터베이스에 저장되지 않음

클래스에 속성이 있는데 저장되지 않는다면 `@Column()`을 잊었을 가능성이 큽니다:

```typescript
@Entity()
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column() // <-- 영속화되는 모든 필드에 필요
  name!: string;

  bio: string; // 저장되지 않음 -- @Column() 없음
}
```

엔티티가 선언하지 않은 키가 쓰기에 도달하면 보고됩니다. `save()`를 비롯한
삽입 계열 메서드는 엔티티·키당 한 번
`[WriteInput] Unknown key "bio" in the data passed to save() for entity "User"`
를 로그로 남기고, 가까운 이름이 있으면 `Did you mean` 제안을 붙여요. 이런
쓰기를 아예 거절하려면 연결 옵션에 `unknownWriteKeys: "throw"`를 주세요.
아래 `"Unknown column"` 항목과 쓰기 가이드의 *쓰기 페이로드의 미지 키* 절을
참고하세요.

## 쿼리 오류

### N+1 쿼리 문제

다음과 같은 반복 쿼리가 보인다면:

```
SELECT * FROM "post" WHERE "author_id" = 1
SELECT * FROM "post" WHERE "author_id" = 2
SELECT * FROM "post" WHERE "author_id" = 3
```

N+1 감지를 켜고 즉시 로딩을 사용하세요:

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

키가 해당 엔티티의 어떤 컬럼과도 일치하지 않습니다. 읽기(`find`, `findOne`,
`count`, `sum` 등)와 벌크 쓰기(`update`, `delete`) 모두 SQL을 만들기 전에
검사하고, 에러의 `suggestion`에 허용되는 이름이 전부 나열돼요. 따옴표 안의
절 이름은 어느 인자에서 났는지를 가리킵니다. `delete` / `softDelete` /
`restore`는 `"criteria"`, 읽기와 `updateMany`는 `"where"`, `updateMany`의
SET 페이로드와 -- `unknownWriteKeys: "throw"`일 때 -- `save` / `saveMany` /
`insertMany` / `insertManyAndReturn` / `upsert` / `insertIgnore` /
`batchUpsert`의 페이로드는 `"data"`예요(기본값 `"warn"`은 던지는 대신 같은
키를 한 번 로그로 남깁니다). `AND` / `OR` / `NOT`은 안쪽으로 순회할 뿐 컬럼으로
보고되지 않고, `updateMany`의 `data`에 결합자가 들어오면 별도 메시지(`Logical
combinator "OR" is not allowed in the update data`)로 실패합니다. 결합자는
`where`에 두면 됩니다.

읽기와 `updateMany`에서 허용되는 키는 속성명, DB 컬럼명, `@ManyToOne` /
`@OneToOne` FK 섀도우 속성, `@ComputedColumn` 이름, 그리고 단일 테이블
상속에서는 판별자 컬럼과 같은 테이블을 공유하는 형제 클래스의 컬럼입니다.
삽입 계열 쓰기 페이로드는 여기에 관계 속성을 더 받지만 DB 컬럼명은 받지
**않아요**. INSERT는 속성 키만 읽기 때문에 `save(Team, { team_name })`은
`Did you mean "teamName"?`과 함께 보고됩니다.

```typescript
// 엔티티가 다음과 같다면:
@Column({ name: "user_name" })
name!: string;

await em.find(User, { where: { name: "Alice" } });      // 속성명 (권장)
await em.find(User, { where: { user_name: "Alice" } }); // DB 컬럼명도 허용
await em.find(User, { where: { userName: "Alice" } });  // 둘 다 아님 — 예외
```

관계 프로퍼티는 컬럼이 아닙니다. FK로 거르거나(`where: { authorId: 1 }`),
연관 행에 조건을 걸어야 하면 `SelectQueryBuilder.whereHas()`를 쓰세요.

### "... column but received an array / an object"

```
InvalidQueryError: Post.tags is a "text" column but save() received an array, which cannot be bound as one value:
better-sqlite3 would spread it over 2 values and shift every value after it.
```

어떤 드라이버도 JS 배열이나 일반 객체를 파라미터 하나로 바인딩하지 않고, 어긋나는 방식도 제각각입니다. better-sqlite3는 배열을 위치 플레이스홀더에 펼쳐 넣고 일반 객체는 어떤 자리도 채우지 않는 이름 파라미터 묶음으로 읽어요. mysql2는 배열을 값 목록으로 펼치고 객체는 `'[object Object]'`로 렌더링하며, `pg`는 배열 리터럴이나 JSON 텍스트를 보냅니다. 개수가 우연히 맞아떨어지면 모든 값이 한 컬럼씩 왼쪽으로 밀린 채 저장되고 아무 신호도 남지 않기 때문에, ORM이 바인딩 직전에 값을 먼저 검사합니다. 메시지는 엔티티 프로퍼티, 선언된 컬럼 타입, 그 값을 만든 연산, 지금 쓰는 드라이버가 어떻게 처리했을지를 함께 알려 줘요.

이 검사는 `save`, `saveMany`, `insertMany`, `insertManyAndReturn`, `upsert`, `insertIgnore`, `batchUpsert`, `createInsertBuilder()`, `update`, `updateMany`, `createUpdateBuilder().set()`에서 동일하게 동작합니다. 컬럼의 쓰기 변환을 **거친 뒤의** 값을 보기 때문에, 문자열을 반환하는 `transformer.to`는 그대로 동작하고 스스로 직렬화하는 `json` 컬럼은 애초에 이 검사에 걸리지 않아요.

해결 방법:

1. 컬럼을 `json`으로 선언 — `@Column({ type: "json" }) tags!: string[]`. 타입 없는 배열 프로퍼티는 알아서 `json`으로 추론되므로, 이 오류는 다른 타입이 선언돼 있다는 뜻입니다.
2. PostgreSQL이라면 네이티브 배열 컬럼으로 `@Column({ type: "array" })`.
3. 저장 형태를 직접 정하고 싶다면 `to()`가 문자열이나 숫자를 반환하는 `transformer`를 주세요(`["a", "b"]` -> `"a,b"`).
4. 외래 키라면 연관 객체 대신 키 값을 넘기세요: `updateMany(Post, { authorId: 7 }, …)`.

원시 쿼리는 드라이버로 바로 가고 컬럼 정보를 모르기 때문에 드라이버가 지원하는 형태를 그대로 유지합니다. 예외는 SQLite 하나예요. SQLite에서 `em.query("SELECT ?, ?", [[1, 2]])`는 이제 `SQLite cannot bind an array as one parameter` 오류를 냅니다. better-sqlite3가 그 배열을 두 플레이스홀더에 펼쳐 넣었을 테니까요. 이름 파라미터 묶음(`em.query("SELECT :a", [{ a: 1 }])`)은 그대로 동작하고, MySQL의 `IN (?)` / `VALUES ?` 관용구도 MySQL에서 계속 동작합니다.

### falsy 값을 가진 WHERE 절

`0`, `false`, `""`는 유효한 값입니다. where 절에서 정상적으로 동작합니다:

```typescript
await em.find(User, { where: { age: 0 } });        // age = 0인 사용자 조회
await em.find(User, { where: { active: false } });  // 비활성 사용자 조회
```

`undefined`만 예외이고, 여기서는 falsy 값으로 묶이지도 않습니다. "이 키는 설정되지 않았다"는 뜻이라 해당 필드가 쿼리에서 빠집니다. `null`은 값이라서 `IS NULL`이 돼요.

```typescript
await em.find(User, { where: { age: undefined } });  // 필터 없음: 전체 사용자
await em.find(User, { where: { age: null } });       // WHERE "age" IS NULL
```

### "Every value in the where ... is undefined"

```
InvalidQueryError: Every value in the "where" passed to findOne() for entity
"User" is undefined (id) — the query would read an arbitrary row.
```

단건 조회(`findOne`, `findOneBy`, `findOneOrFail`, `findOneByOrFail`)나 `exists()`가 필드를 쓰긴 했지만 값이 하나도 정의되지 않은 `where`를 받았다는 뜻입니다. 조건이 전부 빠지면 필터 없이 실행돼서 DB가 먼저 돌려주는 행이 결과가 됩니다. 원인은 대개 검증되지 않은 선택적 값이에요.

```typescript
const id = req.query.id as string | undefined;   // "?id=" 누락 -> undefined
await em.findOne(User, { where: { id } });
```

필드를 지우는 대신 값이 들어오는 지점에서 검증하거나 타입을 좁히세요.

```typescript
if (id === undefined) throw new BadRequestException("id is required");
await em.findOne(User, { where: { id } });
```

정말 "아무 행이나" 원한다면 그렇게 적으면 됩니다. `findOne(User, {})`이나 `findOne(User, { where: {} })`은 필터 없이 읽고 그대로 허용해요. 이 검사는 명시한 필드가 *전부* undefined일 때만 동작합니다. 정의된 필드와 undefined 필드가 섞여 있으면 undefined 쪽만 빠지므로, 권한 조회라면 입력값을 반드시 검증해야 합니다. [undefined 값](./entity-manager-querying.md#undefined-값)에서 자세히 다룹니다.

기본 키 조회는 `where`를 만들기 전에 키를 먼저 검사하기 때문에 메시지가 따로 나옵니다.

```
InvalidQueryError: findByPK() received undefined as the primary key of "User".
InvalidQueryError: findByPK() received no value for primary key column "userId" of "Member".
InvalidQueryError: findByPKs() received undefined at index 1 as a primary key of "User".
```

원인과 해결책은 같습니다. 호출 전에 값을 검증하세요. 복합 키라면 키 속성을 전부 넘겨야 하고, 속성 이름과 컬럼 이름 어느 쪽으로 적어도 됩니다. 여기서 `null`은 값이라서 `IS NULL`로 매칭돼요.

### "Operator ... received undefined" / "The OR branch ... resolves to no condition"

```
InvalidQueryError: Operator "gt" on "score" received undefined.
InvalidQueryError: The OR branch OR[0] resolves to no condition, so the OR
would match every row.
```

연산자 피연산자는 명시적인 비교입니다. 예전에는 여기에 들어간 `undefined`가 `= NULL`(아무것도 매칭 안 함)이 되거나, `in` / `between` / `contains`에서는 raw `TypeError`가 났고, `isNull: undefined`는 `IS NOT NULL`로 뒤집혀 null이 아닌 모든 행을 가져왔습니다. 연산자는 조건부로 붙이세요.

```typescript
await em.find(Post, {
  where: { score: { ...(min !== undefined && { gte: min }) } },
});
```

두 번째 메시지는 `OR` 분기나 배열 형태의 원소가 아무 조건도 만들지 못했다는 뜻입니다. 빈 객체이거나 값이 전부 undefined인 분기죠. 빈 분기는 TRUE라서 OR로 묶으면 전체 행이 돌아옵니다. 그 분기를 없애거나, 정의된 값을 최소 하나는 넣어 주세요.

## 관계 오류

### 관계 데이터가 로드되지 않음

관계는 기본적으로 lazy 입니다. 명시적으로 요청해야 합니다:

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

또는 관계를 eager로 표시할 수 있습니다:

```typescript
@OneToMany(() => Post, (post) => post.author, { eager: true })
posts!: Post[];
```

### `select`와 함께 쓰면 관계가 `[]`(또는 `null`)로 돌아올 때

```typescript
const users = await em.find(User, { select: ["name"], relations: ["posts"] });
// users[0].posts → 게시글이 있는데도 모든 사용자에서 []
```

OneToMany, ManyToMany, OneToOne 역방향 관계는 JOIN하지 않고 두 번째 쿼리로 로드하며, 이 쿼리는 부모의 기본 키로 관련 행을 짝짓습니다. 이전 릴리스는 `select`를 적힌 그대로 보냈기 때문에, 기본 키를 뺀 `select`는 키 없는 부모를 만들었고 로더가 쿼리를 건너뛰면서 관련 행이 있어도 부모마다 `[]`(OneToOne이면 `null`)가 채워졌습니다. 오류도 나지 않았고요.

지금은 기본 키를 대신 가져오고 반환된 객체에도 남겨 두므로 위 쿼리도 게시글을 로드합니다. 이전 릴리스를 쓰고 있다면 키를 직접 적어 주세요.

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

위에서 설명한 기본 키는 행을 합치는 쿼리에는 추가할 수 없습니다. `distinct: true`라면 키를 추가하는 순간 살아남는 행이 달라지고, `groupBy`에 키 컬럼이 전부 들어 있지 않으면 그룹마다 관련 행을 짝지을 부모가 하나로 정해지지 않기 때문입니다. 그룹으로 묶인 행이 들고 있는 키는 구성원 중 아무거나 하나의 키여서, 그 구성원의 행이 그룹 전체에 붙어 버립니다. 그래서 아무 말 없이 다른 행을 돌려주는 대신 쿼리를 거부합니다. 다음 중 하나를 고르세요.

- 기본 키를 `select`(`distinct`인 경우)나 `groupBy`에 추가합니다.
- 이 쿼리에서 `distinct` / `groupBy`를 뺍니다.
- 관계는 별도 `find()`로 로드합니다.

`groupBy` 거부는 그룹 기준만 봅니다. `select`에 키를 적어도 풀리지 않아요. 그룹으로 묶인 행은 여전히 여러 부모를 대표하니까요.

```typescript
// 거부됨 -- "name"으로 묶으면 여러 사용자가 임의의 id 하나 아래로 들어갑니다
await em.find(User, { select: ["id", "name"], groupBy: ["name"], relations: ["posts"] });
```

### "Unknown relation ... in relations"

```
InvalidQueryError: Unknown relation "autor" in "relations" for entity "Post".
Available relations: [author (ManyToOne), tags (ManyToMany)]. Did you mean "author"?
```

`relations`에 넣는 이름은 해당 엔티티에 `@ManyToOne`, `@OneToMany`,
`@ManyToMany`, `@OneToOne`으로 선언한 관계 프로퍼티여야 합니다. 로더가 매칭에
쓰는 이름과 같은 이름, 즉 FK 컬럼명이 아니라 프로퍼티명이에요.

중첩 경로는 원래 지원한 적이 없어서 별도 메시지로 알려줍니다.

```typescript
// 지원하지 않음 — 예외 발생
await em.find(Post, { relations: ["author.profile"] });

// 루트 관계를 먼저 로드하고, 중첩 관계는 후속 쿼리로
const posts = await em.find(Post, { relations: ["author"] });
const profiles = await em.find(Profile, {
  where: { authorId: In(posts.map((p) => p.author.id)) },
});
```

대상 엔티티 thunk가 아무것도 돌려주지 않는 관계도 같은 방식으로 걸러냅니다
(`... target thunk returned no entity class`). 대부분 엔티티 모듈 간 순환
임포트가 원인이니, 대상은 데코레이터의 `() => Entity` thunk 안에 두고 단일 값
관계 프로퍼티는 `Relation<Target>`으로 선언하세요.

### 순환 관계 오류

두 엔티티가 서로를 참조할 때는 지연 함수 참조를 사용하세요:

```typescript
// 순환 임포트 문제를 피하려면 () => Entity 사용
@ManyToOne(() => Author)
author!: Author;

@OneToMany(() => Post, (post) => post.author)
posts!: Post[];
```

## SQLite 관련 이슈

### SQLite에서 지원되지 않는 기능

SQLite는 다음을 지원하지 않습니다:
- `ALTER COLUMN` (타입 변경, 이름 변경)
- `DROP COLUMN` (SQLite 3.35.0 이전)
- `ENUM` 타입 (대신 `varchar` 사용)
- 스키마 네임스페이스
- 동시 쓰기 트랜잭션 다중 실행

파괴적 작업을 피하려면 `synchronize: "safe"`를 사용하세요:

```typescript
await em.register({
  type: "sqlite",
  database: "./mydb.sqlite",
  synchronize: "safe", // 테이블 생성과 컬럼 추가만 수행
  entities: [User],
});
```

## 마이그레이션 오류

### "Migration table already exists"

정상입니다. ORM이 적용된 마이그레이션을 추적하기 위해 `__migrations` 테이블을 만듭니다. 이 테이블이 이미 존재한다는 오류가 보인다면, 여러 프로세스에서 동시에 실행되어 발생한 경합 조건일 가능성이 큽니다. 마이그레이션은 단일 프로세스에서 실행하세요.

### 생성된 마이그레이션에 TODO가 있음

`migrate:generate`가 TODO 주석이 들어간 불완전한 SQL을 만들었다면, 스키마 diff가 정확한 DDL을 결정할 수 없었다는 의미입니다. 실행하기 전에 생성된 파일을 직접 수정하세요.

```bash
# 생성
npx stingerloom migrate:generate -n AddUserEmail

# 생성된 파일을 검토 후 수정한 다음 실행
npx stingerloom migrate:run
```

## Synchronize 모드

| 모드 | 테이블 생성 | 컬럼 추가 | 컬럼 변경 | 컬럼 삭제 |
|------|:-:|:-:|:-:|:-:|
| `true` | Yes | Yes | Yes | Yes |
| `"safe"` | Yes | Yes | No | No |
| `"dry-run"` | 로그만 | 로그만 | 로그만 | 로그만 |
| `false` | No | No | No | No |

**권장:** `synchronize: true`는 개발에서만 사용하세요. 프로덕션에서는 마이그레이션을 사용하세요.

## 디버깅 팁

### SQL 로깅 활성화

```typescript
await em.register({
  logging: {
    queries: true,       // 모든 SQL 쿼리 로그
    slowQueryMs: 1000,   // 1초 이상 쿼리 경고
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
