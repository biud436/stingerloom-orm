# 기여자 온보딩 가이드

> 목적: Stingerloom ORM의 내부 아키텍처를 이해하고 코드를 고치거나 새 기능을 추가하도록 돕습니다. API 사용법이 필요하면 [Getting Started](./getting-started.md)를 먼저 읽으세요.

> 대상 독자: 프로젝트에 새로 합류하는 개발자와 외부 컨트리뷰터

---

## 1. 로컬 개발 환경 설정

### 필수 도구

| Tool | Minimum Version | Notes |
|------|----------------|-------|
| Node.js | >=22 | LTS; `package.json`의 `engines` 필드 참고 |
| pnpm | >=8 | 프로젝트 패키지 매니저 |
| TypeScript | >=6.0 | `devDependencies`에 포함됨 |
| Docker | Latest stable | 통합 테스트용 MySQL/PostgreSQL |

### 클론과 빌드

```bash
git clone https://github.com/biud436/stingerloom-orm.git
cd stingerloom-orm
pnpm install
pnpm build          # Generate dist/ — required before running examples
```

`pnpm build`는 CJS 번들(`dist/`)과 ESM 번들(`dist/esm/`)을 함께 생성합니다. 패키지는 npm에 [`@stingerloom/orm`](https://www.npmjs.com/package/@stingerloom/orm)으로 배포되어 있습니다. `examples/` 아래의 예제 프로젝트는 로컬 빌드 결과물인 `dist/`를 참조합니다. 그래서 `src/`에서 수정한 내용은 다시 배포하지 않아도 예제에 바로 반영됩니다.

### Docker로 데이터베이스 설정

통합 테스트에는 MySQL과 PostgreSQL이 필요합니다.

```bash
# MySQL
docker run -d --name stingerloom-mysql \
  -e MYSQL_ROOT_PASSWORD=test \
  -e MYSQL_DATABASE=test \
  -p 3306:3306 \
  mysql:8

# PostgreSQL
docker run -d --name stingerloom-postgres \
  -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=test \
  -p 5432:5432 \
  postgres:16
```

### 테스트 실행

```bash
# 유닛 테스트 (DB 연결 불필요)
pnpm test

# 특정 테스트 파일만 실행 (jest 플래그는 pnpm이 아니라 jest에 직접 넘겨야 합니다)
npx jest --testPathPattern "schema-diff"

# 통합 테스트 (MySQL/PostgreSQL 구동 필요)
INTEGRATION_TEST=true npx jest --testPathPattern "integration"

# 스트레스 스위트 (SQLite in-memory, CI에서도 실행됩니다)
pnpm test:stress
```

전체 테스트는 현재 약 5,200개 케이스 규모입니다. 유닛, SQLite, MySQL, PostgreSQL 테스트를 합친 수입니다. 건너뛰는 테스트는 한 자릿수이고 실패는 0건입니다. MySQL과 PostgreSQL 통합 테스트는 `INTEGRATION_TEST=true` 환경 변수가 없으면 자동으로 건너뜁니다. 반면 SQLite 통합 테스트는 in-memory로 동작하므로 항상 함께 실행됩니다.

### 예제 실행

```bash
pnpm build                              # 먼저 빌드해야 합니다
cd examples/nestjs-cats && pnpm install && pnpm start          # 최소 CRUD
cd examples/nestjs-blog && pnpm install && pnpm start          # M2M, soft delete, upsert
cd examples/nestjs-multitenant && pnpm install && pnpm start   # PostgreSQL 스키마별 테넌트
cd examples/nestjs-todo && pnpm install && pnpm start          # 최소 NestJS + MySQL
cd examples/nestjs-todo-sqlite && pnpm install && pnpm start   # SQLite (in-memory)
cd examples/nestjs-linear-clone && pnpm install && pnpm start  # 풀 레퍼런스 앱 (재귀 CTE, 분석, 멀티테넌시)
```

---

## 2. 아키텍처 개요

### 디렉토리 구조

```
src/
├── core/               <- Core logic (EntityManager, Repository, QueryBuilder, etc.)
├── decorators/         <- Decorator definitions (@Entity, @Column, etc.)
├── dialects/           <- Per-DB driver implementations (MySQL, PostgreSQL, SQLite)
├── metadata/           <- Layered metadata system (multi-tenancy)
├── scanner/            <- Decorator metadata collectors (EntityScanner, ColumnScanner, etc.)
├── migration/          <- Migration system
├── types/              <- Common type definitions
├── utils/              <- Helpers (Logger, ReflectManager)
└── errors/             <- Error class hierarchy
```

**이렇게 나눈 이유**

- `core/`와 `dialects/`를 나눠서 DB와 무관한 로직을 DB에 종속된 코드와 분리합니다.
- `scanner/`와 `decorators/`를 나눠서 "메타데이터 수집"과 "메타데이터 정의"라는 관심사를 구분합니다.
- `metadata/`는 독립된 모듈입니다. 그래서 멀티테넌시 레이어 시스템이 다른 코드에 영향을 주지 않습니다.

### 데이터 흐름

엔티티 클래스를 정의할 때부터 DB에 저장하기까지의 전체 흐름은 다음과 같습니다.

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Decorator Registration (at app load)              │
│                                                                     │
│  @Column()    ->  ColumnScanner.set()   ─┐                          │
│  @ManyToOne() ->  ManyToOneScanner.set() ├-> MetadataLayerRegistry  │
│  @Entity()    ->  EntityScanner.set()   ─┘   (written to public     │
│                                               layer)                │
└─────────────────────────────────────────────────────────────────────┘
                            │
                            v
┌─────────────────────────────────────────────────────────────────────┐
│                 EntityManager.register() call                       │
│                                                                     │
│  DatabaseClient.connect()  ->  Connector created  ->  Driver created│
│       (singleton)              (MySQL/PG/...)        (ISqlDriver     │
│                                                       impl)         │
│                                                                     │
│  registerEntities()                                                 │
│    Pass 1: createTable() — generate table DDL                       │
│    Pass 2: registerForeignKeys/Index — add FK/indexes               │
│    Pass 3: ManyToMany join table creation                           │
└─────────────────────────────────────────────────────────────────────┘
                            │
                            v
┌─────────────────────────────────────────────────────────────────────┐
│                      CRUD Execution (runtime)                       │
│                                                                     │
│  em.save(User, data)                                                │
│    -> Query metadata (MetadataLayerRegistry)                        │
│    -> Execute BeforeInsert hook                                     │
│    -> TransactionSessionManager.connect()                           │
│    -> START TRANSACTION / BEGIN                                      │
│    -> Build SQL (sql-template-tag parameter binding)                 │
│    -> Execute via Driver                                            │
│    -> Deserialize (Deserializer)                                    │
│    -> COMMIT (or ROLLBACK on error)                                 │
│    -> Execute AfterInsert hook                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### 레이어드 메타데이터 시스템

Docker OverlayFS와 같은 개념으로 동작합니다.

```
┌──────────────────────────────┐
│    Tenant Layer (upper)      │  <- Per-tenant modifications (Copy-on-Write)
│    e.g. "tenant_1", "tenant_2"│
├──────────────────────────────┤
│    Public Layer (lower)      │  <- Base schema (all entity metadata)
│    Read-only (after decorator │
│    registration)              │
└──────────────────────────────┘
```

**동작 방식:**

1. 앱이 로드될 때 `@Entity`나 `@Column` 같은 데코레이터가 public 레이어에 메타데이터를 기록합니다.
2. 멀티테넌트 환경에서 `MetadataContext.run("tenant_1", callback)`을 호출하면 그 콜백 안에서 tenant_1 레이어가 활성화됩니다.
3. 메타데이터를 조회할 때는 테넌트 레이어를 먼저 확인하고 없으면 public 레이어로 넘어갑니다. OverlayFS와 같은 방식입니다.
4. 쓰기는 항상 테넌트 레이어에서만 일어납니다(Copy-on-Write).

**주요 파일:**

| File | Role |
|------|------|
| `src/metadata/MetadataContext.ts` | AsyncLocalStorage 기반의 요청 범위 컨텍스트 |
| `src/metadata/MetadataLayer.ts` | 개별 레이어 (key-value Map) |
| `src/scanner/MetadataScanner.ts` | Scanner 기반 클래스 + `MetadataLayerRegistry` (데코레이터 시점의 기준 저장소) |

### 드라이버 추상화

모든 DB 드라이버는 `src/dialects/SqlDriver.ts`의 `ISqlDriver` 인터페이스를 구현합니다.

| Driver | Identifier Wrapping | Auto PK Generation | Schema Support | File Path |
|--------|--------------------|--------------------|---------------|-----------|
| MySQL | Backtick (`` ` ``) | `AUTO_INCREMENT` | Not supported | `src/dialects/mysql/MySqlDriver.ts` |
| PostgreSQL | Double quote (`"`) | `SERIAL` / `RETURNING` | Supported (`schema.table`) | `src/dialects/postgres/PostgresDriver.ts` |
| SQLite | Double quote (`"`) | `INTEGER PRIMARY KEY` | Not supported | `src/dialects/sqlite/SqliteDriver.ts` |

각 드라이버의 연결 레이어 구조는 다음과 같습니다.

```
DatabaseClient (singleton)
  └-> Connector (IConnector implementation — manages actual DB connections)
       └-> Driver (ISqlDriver implementation — DDL/DML abstraction)
            └-> DataSource (IDataSource implementation — transaction/query execution)
```

---

## 3. 주요 코드 흐름

### 연결 흐름

```
EntityManager.register(options)
  -> EntityManager.connect(options)
      -> DatabaseClient.getInstance().connect(options)
          -> createConnector(type)   // MySqlConnector | PostgresConnector | ...
          -> connector.connect(options)
      -> Driver creation (MySqlDriver | PostgresDriver | ...)
      -> DataSource creation (for transaction management)
  -> EntityManager.registerEntities()
```

**관련 파일:**
- `src/core/EntityManager.ts:121`: `register()` 메서드
- `src/core/EntityManager.ts:146`: `connect()` 메서드
- `src/DatabaseClient.ts:48`: `connect()` 메서드

### 엔티티 등록 흐름

데코레이터는 모듈이 로드되면서 클래스가 정의될 때 실행됩니다. 이때 실행 순서가 중요합니다.

```
1. @Column() executes (property decorator — in class body order)
   -> inferColumnDefaults() infers design:type
   -> ColumnScanner.set() temporarily stores metadata

2. @ManyToOne() executes (property decorator)
   -> ManyToOneScanner.set() temporarily stores relation metadata

3. @Entity() executes (class decorator — last)
   -> ColumnScanner.allMetadata() retrieves collected columns
   -> ManyToOneScanner.allMetadata() retrieves collected relations
   -> EntityScanner.set() snapshots entity metadata
   -> ColumnScanner.clear() resets temporary buffer
```

핵심: `@Column()`이 `@Entity()`보다 먼저 실행됩니다. `@Entity()`는 그 시점까지 수집된 컬럼 메타데이터의 스냅샷을 찍고 임시 버퍼를 비웁니다.

**관련 파일:**
- `src/decorators/Column.ts:153`: `Column()` 데코레이터
- `src/decorators/Entity.ts:24`: `Entity()` 데코레이터
- `src/scanner/MetadataScanner.ts:179`: Scanner 기반 클래스

### CRUD 흐름 (save 예시)

```
em.save(User, { name: "John Doe", email: "john@example.com" })
  1. resolveEntityMetadata(User)
     -> EntityScanner.scan(User) or Reflect.getMetadata(ENTITY_TOKEN, User)
  2. EntityValidator.validate(entity)
     -> @Validation decorator checks
  3. Hook execution: BeforeInsert
  4. EntitySubscriber.beforeInsert() event
  5. TransactionSessionManager creation -> connect() -> startTransaction()
  6. SQL build: INSERT INTO "users" ("name", "email") VALUES ($1, $2)
     -> Parameter binding via sql-template-tag
  7. Execute query -> return result rows
  8. commit()
  9. Deserializer converts result -> User instance
  10. Hook execution: AfterInsert
  11. EntitySubscriber.afterInsert() event
```

**관련 파일:**
- `src/core/EntityManager.ts:2146`: `save()` 메서드
- `src/dialects/TransactionSessionManager.ts`: 트랜잭션 관리
- `src/core/EntityValidator.ts`: 검증

### 관계 로딩

**즉시 로딩 (기본값):**

```
em.find(Post, { relations: ["author"] })
  -> LEFT JOIN으로 관련 엔티티를 한 번에 조회
  -> ResultTransformer가 평면 행을 중첩 객체로 변환
```

**지연 로딩:**

```
em.find(Post, { relations: [] })  // Relations configured as lazy
  -> Object.defineProperty()로 getter 프록시 주입
  -> post.author 접근 시 -> 별도 SELECT 쿼리 실행
  -> 이후 접근 시 캐시된 값 반환
```

**관련 파일:**
- `src/core/LazyLoader.ts`: `injectLazyProxy()`, `createLazyProxy()`

---

## 4. 새 기능 추가 가이드

### 새 데코레이터 추가

`@CreatedAt()` 데코레이터를 추가하는 경우를 예로 들겠습니다.

**Step 1: Symbol token 정의 + 데코레이터 함수 작성**

```typescript
// src/decorators/CreatedAt.ts
export const CREATED_AT_TOKEN = Symbol.for("STG_CREATED_AT");

export function CreatedAt(): PropertyDecorator {
  return (target, propertyKey) => {
    Reflect.defineMetadata(CREATED_AT_TOKEN, propertyKey, target.constructor);
  };
}
```

**Step 2: 데코레이터 export**

```typescript
// Add to src/decorators/index.ts
export * from "./CreatedAt";
```

**Step 3: EntityManager에서 token 사용**

save/update 메서드에서 `Reflect.getMetadata(CREATED_AT_TOKEN, entity)`를 조회해서 날짜를 자동으로 설정합니다.

**Step 4: 테스트 작성**

`__tests__/unit/created-at.test.ts`를 만들고 데코레이터 동작을 검증합니다.

**네이밍 규칙:**
- Token symbol: `STG_` prefix (예: `Symbol.for("STG_CREATED_AT")`)
- 데코레이터 파일: PascalCase (예: `CreatedAt.ts`)
- Token 상수: SCREAMING_SNAKE_CASE + `_TOKEN` suffix (예: `CREATED_AT_TOKEN`)

### 새 드라이버 추가

CockroachDB 같은 새 데이터베이스를 지원하려면 다음 단계를 따릅니다.

**Step 1: 디렉토리 생성**

```
src/dialects/cockroach/
  ├── CockroachDriver.ts       <- ISqlDriver implementation
  ├── CockroachConnector.ts    <- IConnector implementation
  └── CockroachDataSource.ts   <- IDataSource implementation
```

**Step 2: ISqlDriver 완전 구현**

`src/dialects/SqlDriver.ts`의 `ISqlDriver` 인터페이스에 정의된 모든 메서드를 구현합니다. 주요 메서드는 다음과 같습니다.
- `createTable()` / `hasTable()`: DDL
- `addForeignKey()` / `addIndex()`: 제약 조건
- `castType()`: ColumnType을 DB 고유 타입으로 변환
- `buildUpsertSql()`: UPSERT SQL 문 생성
- `setQueryTimeout()`: 쿼리 타임아웃

**Step 3: 등록 코드 추가**

세 곳에 분기를 추가합니다.
- `src/DatabaseClient.ts:72`: `createConnector()` 메서드
- `src/core/EntityManager.ts:158`: `connect()` 메서드의 switch 문
- `src/dialects/TransactionSessionManager.ts:48`: `connect()` 메서드의 if-else 문

**Step 4: 테스트**

`__tests__/unit/cockroach-driver.test.ts`를 생성합니다.

### EntityManager에 새 메서드 추가

EntityManager에 public API를 추가하는 절차는 다음과 같습니다.

Step 1: `src/core/BaseEntityManager.ts` 인터페이스에 메서드 시그니처를 추가합니다.

Step 2: `src/core/EntityManager.ts`에서 구현합니다.

Step 3: Repository 패턴을 지원하도록 `src/core/BaseRepository.ts`에 래퍼 메서드를 추가합니다.

Step 4: 필요하면 `src/index.ts` -> `src/core/index.ts` 경로의 export를 확인합니다.

### 새 에러 클래스 추가

**Step 1: `src/errors/OrmErrorCode.ts`에 새 에러 코드 추가**

<!-- check-docs-api: skip -->
```typescript
export enum OrmErrorCode {
  // ... existing codes
  MY_NEW_ERROR = "ORM_MY_NEW_ERROR",
}
```

**Step 2: `src/errors/` 디렉토리에 에러 클래스 생성**

```typescript
// src/errors/MyNewError.ts
import { OrmError } from "./OrmError";
import { OrmErrorCode } from "./OrmErrorCode";

export class MyNewError extends OrmError {
  constructor() {
    super(OrmErrorCode.MY_NEW_ERROR, "Description message");
    this.name = "MyNewError";
  }
}
```

Step 3: `src/errors/index.ts`에서 export합니다.

---

## 5. 코딩 컨벤션

### SQL 인젝션 방지

절대 규칙: 사용자 입력을 SQL 문자열에 직접 삽입하면 안 됩니다.

```typescript
// Correct approach — use sql-template-tag
import sql from "sql-template-tag";
const query = sql`SELECT * FROM users WHERE id = ${userId}`;

// Wrong approach
const query = `SELECT * FROM users WHERE id = ${userId}`;
```

테이블 이름과 컬럼 이름 같은 식별자는 드라이버의 `escapeIdentifier()`나 `wrapIdentifier()`로 감싸야 합니다.

```typescript
// MySQL: `users`, PostgreSQL: "users"
const tableName = driver.escapeIdentifier("users");
```

### 메타데이터 격리

```typescript
// Correct approach — AsyncLocalStorage-based request scope
MetadataContext.run("tenant_1", async () => {
  await em.find(User);  // Executes in tenant_1 context
});

// Wrong approach — modifying instance state (not safe with concurrent requests)
store.setContext("tenant_1");  // deprecated!
```

### TypeScript strict 모드

`tsconfig.json`에는 `strict: true`가 설정되어 있습니다. `any` 타입은 되도록 쓰지 않습니다. 다만 프레임워크 메타데이터를 처리하느라 피할 수 없을 때는 `eslint-disable` 주석을 씁니다.

### 테스트 패턴

**유닛 테스트:**

```typescript
// Mock DB connections with jest.mock
jest.mock("../../src/DatabaseClient", () => ({
  DatabaseClient: {
    getInstance: jest.fn().mockReturnValue({
      getConnection: jest.fn(),
      type: "mysql",
      getOptions: jest.fn().mockReturnValue({ synchronize: false }),
    }),
  },
}));
```

**통합 테스트:**

```typescript
import { createTestConnection, generateTableName, dropTestTable } from "./helpers";

describe("CRUD basic", () => {
  let em: EntityManager;
  const tableName = generateTableName("crud");

  beforeAll(async () => {
    em = await createTestConnection();
  });

  afterAll(async () => {
    await dropTestTable(em, tableName);
  });
});
```

통합 테스트 파일 맨 위에는 반드시 다음 가드를 넣어야 합니다.

```typescript
const SKIP = !process.env.INTEGRATION_TEST;
(SKIP ? describe.skip : describe)("Integration: ...", () => { ... });
```

### 네이밍 규칙

| Subject | Convention | Example |
|---------|-----------|---------|
| Entity class | PascalCase | `User`, `BlogPost` |
| Table name | snake_case (auto-converted) | `user`, `blog_post` |
| Decorator token | `STG_` prefix + SCREAMING_SNAKE | `Symbol.for("STG_ENTITY")` |
| Driver class | `{DB}Driver` | `MySqlDriver`, `PostgresDriver` |
| Connector class | `{DB}Connector` | `MySqlConnector` |
| DataSource class | `{DB}DataSource` | `MySqlDataSource` |
| Scanner class | `{Name}Scanner` | `ColumnScanner`, `EntityScanner` |
| Error class | `{Desc}Error` | `EntityNotFound`, `InvalidQueryError` |

### 커밋 메시지

```
feat: Add new feature
fix: Fix bug
docs: Documentation changes
test: Add/modify tests
refactor: Refactoring (no functional changes)
chore: Build, configuration changes
```

---

## 6. 자주 하는 실수와 트러블슈팅

### `reflect-metadata` import 누락

```
TypeError: Reflect.getMetadata is not a function
```

해결: 앱 진입점 맨 위에 `import "reflect-metadata"`를 추가합니다. 이 패키지가 없으면 `design:type` 같은 데코레이터 메타데이터를 읽을 수 없습니다.

### tsconfig.json 설정 누락

```
Unable to resolve signature of class decorator...
```

해결: `tsconfig.json`에 다음 옵션이 모두 있어야 합니다.

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

### 빌드 없이 예제 실행

```
Cannot find module '@stingerloom/orm'
```

해결: `examples/`는 로컬 `dist/`를 참조합니다. 예제를 실행하기 전에 프로젝트 루트에서 `pnpm build`를 먼저 실행하세요.

### 테스트 간 MetadataLayerRegistry 오염

MetadataLayerRegistry는 전역 싱글톤입니다. 그래서 서로 다른 테스트 파일에서 같은 엔티티를 정의하면 메타데이터가 겹칠 수 있습니다.

해결: 각 테스트 전에 레지스트리를 초기화합니다.

```typescript
beforeEach(() => {
  MetadataLayerRegistry.reset();
  MetadataContext.reset();
});
```

### WHERE 조건의 Falsy 값 처리

예전에는 `0`, `false`, `""` 같은 falsy 값이 WHERE 조건에서 무시되는 버그가 있었습니다. 이 버그는 수정되었습니다.

참고: 조건을 검사할 때는 `if (value)` 대신 `if (value !== undefined && value !== null)`을 사용합니다.

```typescript
// Correct approach
if (value !== undefined && value !== null) {
  conditions.push(sql`${column} = ${value}`);
}

// Wrong approach — ignores 0, false, ""
if (value) {
  conditions.push(sql`${column} = ${value}`);
}
```

### MySQL 연결 풀 이중 해제

MySQL 드라이버에서 `commit()`이나 `rollback()` 뒤에 연결 참조를 `undefined`로 설정하지 않으면 같은 연결이 두 번 해제될 수 있습니다.

관련 코드: `src/dialects/mysql/MySqlDataSource.ts`에서 commit이나 rollback 뒤에 `this.connection = undefined`로 설정해야 합니다.

---

## 7. 기여 워크플로

### 브랜치 전략

```
main (default branch)
  └── feature/feature-name       <- New features
  └── fix/bug-description        <- Bug fixes
  └── docs/doc-topic             <- Documentation changes
```

main에서 브랜치를 만들고 작업을 마치면 PR을 생성합니다.

### PR 체크리스트

PR을 열기 전에 다음을 확인합니다.

- [ ] `pnpm test` 전체 통과 (0 failures)
- [ ] `pnpm build` 성공 (TypeScript 컴파일 에러 없음)
- [ ] 새 기능의 유닛 테스트 추가
- [ ] SQL 쿼리의 사용자 입력은 파라미터 바인딩으로 처리
- [ ] 테이블 이름과 컬럼 이름 같은 식별자는 `escapeIdentifier()`로 감싸기
- [ ] 메타데이터는 레이어 시스템으로만 접근 (전역 상태 사용 금지)
- [ ] API가 바뀌었다면 관련 문서(`docs/`) 갱신
- [ ] 예제 프로젝트에 영향이 있으면 `examples/` 갱신

### 예제 프로젝트 타입 체크

ORM API를 바꿨다면 예제가 깨지지 않았는지 확인합니다.

```bash
pnpm build
cd examples/nestjs-cats && pnpm install && npx tsc --noEmit
cd ../nestjs-blog && pnpm install && npx tsc --noEmit
cd ../nestjs-multitenant && pnpm install && npx tsc --noEmit
cd ../nestjs-todo && pnpm install && npx tsc --noEmit
cd ../nestjs-todo-sqlite && pnpm install && npx tsc --noEmit
cd ../nestjs-linear-clone && pnpm install && npx tsc --noEmit
```

---

## 8. 참고 자료

### 기존 문서 상호 참조

| Document | Content | When to reference |
|----------|---------|-------------------|
| [Getting Started](./getting-started.md) | 설치, 첫 엔티티, 첫 CRUD | ORM 사용법을 처음 배울 때 |
| [Entity Definition](./entities.md) | 컬럼, 인덱스, 훅, 검증 | 데코레이터 동작을 이해할 때 |
| [Relations](./relations.md) | ManyToOne, OneToMany, ManyToMany | 관계 로딩 코드를 수정할 때 |
| [EntityManager](./entity-manager.md) | find, save, delete, 집계 | EntityManager API를 확장할 때 |
| [Query Builder](./query-builder.md) | JOIN, GROUP BY, 서브쿼리 | QueryBuilder 코드를 수정할 때 |
| [Transactions](./transactions.md) | 격리 수준, 세이브포인트 | TransactionSessionManager를 수정할 때 |
| [Migrations](./migrations.md) | MigrationRunner, CLI | 마이그레이션 시스템을 수정할 때 |
| [Configuration Guide](./configuration.md) | 연결 풀, 타임아웃, 읽기 레플리카 | DatabaseClientOptions를 확장할 때 |
| [Advanced Features](./advanced.md) | N+1 감지, 이벤트, 커서 페이지네이션 | QueryTracker, EventEmitter를 수정할 때 |
| [Multi-Tenancy](./multi-tenancy.md) | 레이어드 메타데이터, 스키마 격리 | 멀티테넌시 기능을 수정할 때 |
| [API Reference](./api-reference.md) | 메서드 시그니처 목록 | public API를 확인할 때 |
| Manual Testing Guide (`internal/manual-testing-guide.md`, Git 저장소 전용, EN) | 수동 통합 테스트 실행 | 통합 테스트 환경을 설정할 때 |
| Pre-Release Checklist (`internal/pre-release-checklist.md`, Git 저장소 전용, EN) | 릴리스 전 확인 항목 | 버전 릴리스를 준비할 때 |

### 주요 소스 파일 빠른 참조

| File | One-Line Description |
|------|---------------------|
| `src/core/EntityManager.ts` | CRUD, 관계 로딩, 트랜잭션: ORM의 중심 |
| `src/dialects/SqlDriver.ts` | `ISqlDriver` 인터페이스 정의 |
| `src/metadata/MetadataContext.ts` | AsyncLocalStorage 기반 테넌트 컨텍스트 |
| `src/scanner/MetadataScanner.ts` | `MetadataLayerRegistry`: 데코레이터 시점의 기준 메타데이터 저장소 |
| `src/decorators/Entity.ts` | `@Entity()` 데코레이터: 엔티티 메타데이터 스냅샷 |
| `src/decorators/Column.ts` | `@Column()` 데코레이터: 컬럼 메타데이터 + 타입 추론 |
| `src/DatabaseClient.ts` | DB 연결 싱글톤, 이름 있는 연결(named connection) 지원 |
| `src/dialects/TransactionSessionManager.ts` | 트랜잭션 생명주기 관리 |
| `src/core/BaseRepository.ts` | Repository 패턴 기반 클래스 |
| `src/errors/OrmError.ts` | Error 기반 클래스 (`OrmErrorCode` 기반) |
| `src/index.ts` | 패키지 public API 진입점 |
