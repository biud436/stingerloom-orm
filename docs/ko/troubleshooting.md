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
OrmError [ORM_ENTITY_METADATA_NOT_FOUND]: Entity metadata for "User" was not found.
```

**원인:**
1. 클래스에 `@Entity()` 데코레이터가 없음
2. `entities` 배열에 엔티티 클래스가 등록되지 않음
3. 진입점 파일 상단에 `import "reflect-metadata"`가 빠짐

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

### 컬럼이 조용히 "text"가 됨 / "No design:type metadata" 경고

```
WARN [Column] No design:type metadata for User.name — falling back to "text". ...
```

데코레이터 스타일은 TypeScript의 `design:type` 메타데이터로 컬럼 타입을 추론하는데, 이 메타데이터는 `tsc`와 `ts-node`만 생성합니다(`emitDecoratorMetadata`). **tsx, esbuild, swc, Vite는 이를 생성하지 않아서** 타입을 지정하지 않은 `@Column()`이 전부 `"text"`로 강등되고, 실제 데이터베이스에서는 숫자·날짜 컬럼이 깨집니다.

다음 중 하나로 해결할 수 있습니다.

1. 코드 우선 빌더로 엔티티 정의 — `defineEntity`는 데코레이터 메타데이터가 아예 필요 없습니다
2. 모든 `@Column`에 타입 명시: `@Column({ type: "int" })`
3. `tsc`로 빌드하거나 `ts-node`로 실행해 메타데이터를 생성

관련 경고인 `Unknown design:type "Object"`는 프로퍼티의 TypeScript 타입이 런타임에 `Object`로 지워진다는 뜻입니다(`string | null` 같은 유니언/옵셔널 타입). 이 경우에도 컬럼 타입을 명시하면 됩니다.

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

### "Unknown column in criteria"

```
OrmError [ORM_INVALID_QUERY]: Unknown column "userName" in criteria for entity "User".
```

`where` 절의 키가 어떤 컬럼과도 일치하지 않습니다. 속성명을 확인하세요(DB 컬럼명이 아닙니다):

```typescript
// 엔티티가 다음과 같다면:
@Column({ name: "user_name" })
name!: string;

// DB 컬럼명이 아닌 속성명을 사용하세요
await em.find(User, { where: { name: "Alice" } }); // 정상
await em.find(User, { where: { user_name: "Alice" } }); // 잘못됨
```

### falsy 값을 가진 WHERE 절

`0`, `false`, `""`는 유효한 값입니다. where 절에서 정상적으로 동작합니다:

```typescript
await em.find(User, { where: { age: 0 } });        // age = 0인 사용자 조회
await em.find(User, { where: { active: false } });  // 비활성 사용자 조회
```

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
