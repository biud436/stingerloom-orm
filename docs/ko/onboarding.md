# Contributor Onboarding Guide

> **이 문서의 목적:** Stingerloom ORM의 **내부 아키텍처**를 이해하고, 코드를 수정하거나 새 기능을 추가할 수 있도록 돕는 문서예요. API 사용법이 필요하면 [Getting Started](./getting-started.md)를 먼저 읽어주세요.

> **대상 독자:** 프로젝트에 새로 합류하는 개발자 또는 외부 컨트리뷰터

---

## 1. 로컬 개발 환경 설정

### 필수 도구

| Tool | Minimum Version | Notes |
|------|----------------|-------|
| Node.js | >=22 | LTS; `package.json`의 `engines` 필드 참고 |
| pnpm | >=8 | 프로젝트 패키지 매니저 |
| TypeScript | >=6.0 | `devDependencies`에 포함돼 있어요 |
| Docker | Latest stable | 통합 테스트용 MySQL/PostgreSQL |

### Clone & Build

```bash
git clone https://github.com/biud436/stingerloom-orm.git
cd stingerloom-orm
pnpm install
pnpm build          # Generate dist/ — required before running examples
```

`pnpm build`는 CJS(`dist/`)와 ESM(`dist/esm/`) 번들을 함께 생성해요. 패키지는 npm에 [`@stingerloom/orm`](https://www.npmjs.com/package/@stingerloom/orm)으로 배포돼 있어요. 이 리포 안의 `examples/` 프로젝트는 로컬 빌드 결과물(`dist/`)을 참조하므로, `src/`에서 수정한 내용이 별도 배포 없이 즉시 예제에 반영돼요.

### Docker로 데이터베이스 설정

통합 테스트에는 MySQL과 PostgreSQL이 필요해요.

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

# 특정 테스트 파일만 실행 (jest 플래그는 pnpm이 아니라 jest에 직접 전달해야 해요)
npx jest --testPathPattern "schema-diff"

# 통합 테스트 (MySQL/PostgreSQL 구동 필요)
INTEGRATION_TEST=true npx jest --testPathPattern "integration"

# 스트레스 스위트 (SQLite in-memory, CI에서도 실행됩니다)
pnpm test:stress
```

전체 테스트는 현재 약 5,200개 케이스(unit + SQLite + MySQL + PostgreSQL, 스킵 한 자릿수, 0 failures) 규모예요. MySQL/PostgreSQL 통합 테스트는 `INTEGRATION_TEST=true` 환경변수가 없으면 자동으로 건너뛰고, SQLite 통합 테스트는 in-memory로 동작하므로 항상 같이 실행돼요.

### 예제 실행

```bash
pnpm build                              # 먼저 빌드해야 해요
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

**왜 이렇게 나눠져 있나요?**

- `core/`와 `dialects/`를 분리해서 DB 독립적인 로직과 DB 종속 코드를 격리해요.
- `scanner/`와 `decorators/`를 분리해서 "메타데이터 수집"과 "메타데이터 정의"의 관심사를 구분해요.
- `metadata/`는 독립 모듈이라 멀티테넌시 레이어 시스템이 다른 코드에 영향을 주지 않아요.

### 데이터 흐름

엔티티 클래스 정의부터 DB 저장까지의 전체 흐름이에요.

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

### Layered Metadata System

Docker OverlayFS와 같은 개념으로 동작해요.

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

1. 앱 로드 시, `@Entity`나 `@Column` 같은 데코레이터가 public layer에 메타데이터를 기록해요.
2. 멀티테넌트 환경에서 `MetadataContext.run("tenant_1", callback)`을 호출하면, 해당 콜백 내에서 tenant_1 레이어가 활성화돼요.
3. 메타데이터 조회 시 tenant layer를 먼저 확인하고, 없으면 public layer로 fallback해요 (OverlayFS 방식).
4. 쓰기는 항상 tenant layer에서만 발생해요 (Copy-on-Write).

**주요 파일:**

| File | Role |
|------|------|
| `src/metadata/MetadataContext.ts` | AsyncLocalStorage 기반 request-scoped context |
| `src/metadata/MetadataLayer.ts` | 개별 layer (key-value Map) |
| `src/scanner/MetadataScanner.ts` | Scanner 기반 클래스 + `MetadataLayerRegistry` (데코레이터 시점 canonical store) |

### Driver Abstraction

모든 DB 드라이버는 `ISqlDriver` 인터페이스(`src/dialects/SqlDriver.ts`)를 구현해요.

| Driver | Identifier Wrapping | Auto PK Generation | Schema Support | File Path |
|--------|--------------------|--------------------|---------------|-----------|
| MySQL | Backtick (`` ` ``) | `AUTO_INCREMENT` | Not supported | `src/dialects/mysql/MySqlDriver.ts` |
| PostgreSQL | Double quote (`"`) | `SERIAL` / `RETURNING` | Supported (`schema.table`) | `src/dialects/postgres/PostgresDriver.ts` |
| SQLite | Double quote (`"`) | `INTEGER PRIMARY KEY` | Not supported | `src/dialects/sqlite/SqliteDriver.ts` |

각 드라이버의 연결 레이어 구조는 이래요:

```
DatabaseClient (singleton)
  └-> Connector (IConnector implementation — manages actual DB connections)
       └-> Driver (ISqlDriver implementation — DDL/DML abstraction)
            └-> DataSource (IDataSource implementation — transaction/query execution)
```

---

## 3. 주요 코드 흐름

### Connection Flow

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
- `src/core/EntityManager.ts:121` — `register()` method
- `src/core/EntityManager.ts:146` — `connect()` method
- `src/DatabaseClient.ts:48` — `connect()` method

### Entity Registration Flow

데코레이터는 클래스 정의 시점(모듈 로드)에 실행돼요. 실행 순서가 중요해요.

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

**핵심 포인트:** `@Column()`이 `@Entity()`보다 먼저 실행돼요. `@Entity()`는 그 시점까지 수집된 컬럼 메타데이터의 스냅샷을 찍고 임시 버퍼를 초기화해요.

**관련 파일:**
- `src/decorators/Column.ts:153` — `Column()` decorator
- `src/decorators/Entity.ts:24` — `Entity()` decorator
- `src/scanner/MetadataScanner.ts:179` — Scanner base class

### CRUD Flow (save 예시)

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
- `src/core/EntityManager.ts:2146` — `save()` method
- `src/dialects/TransactionSessionManager.ts` — Transaction management
- `src/core/EntityValidator.ts` — Validation

### Relation Loading

**Eager Loading (기본값):**

```
em.find(Post, { relations: ["author"] })
  -> LEFT JOIN으로 관련 엔티티를 한 번에 조회
  -> ResultTransformer가 flat row를 중첩 객체로 변환
```

**Lazy Loading:**

```
em.find(Post, { relations: [] })  // Relations configured as lazy
  -> Object.defineProperty()로 getter proxy 주입
  -> post.author 접근 시 -> 별도 SELECT 쿼리 실행
  -> 이후 접근 시 캐시된 값 반환
```

**관련 파일:**
- `src/core/LazyLoader.ts` — `injectLazyProxy()`, `createLazyProxy()`

---

## 4. 새 기능 추가 가이드

### 새 데코레이터 추가

예시: `@CreatedAt()` 데코레이터를 추가한다고 가정할게요.

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

save/update 메서드에서 `Reflect.getMetadata(CREATED_AT_TOKEN, entity)`를 조회해서 날짜를 자동으로 설정해요.

**Step 4: 테스트 작성**

`__tests__/unit/created-at.test.ts`를 만들고 데코레이터 동작을 검증해요.

**네이밍 규칙:**
- Token symbol: `STG_` prefix (예: `Symbol.for("STG_CREATED_AT")`)
- 데코레이터 파일: PascalCase (예: `CreatedAt.ts`)
- Token 상수: SCREAMING_SNAKE_CASE + `_TOKEN` suffix (예: `CREATED_AT_TOKEN`)

### 새 드라이버 추가

새 데이터베이스(예: CockroachDB)를 지원하려면:

**Step 1: 디렉토리 생성**

```
src/dialects/cockroach/
  ├── CockroachDriver.ts       <- ISqlDriver implementation
  ├── CockroachConnector.ts    <- IConnector implementation
  └── CockroachDataSource.ts   <- IDataSource implementation
```

**Step 2: ISqlDriver 완전 구현**

`src/dialects/SqlDriver.ts`의 `ISqlDriver` 인터페이스에 정의된 모든 메서드를 구현해요. 주요 메서드:
- `createTable()` / `hasTable()` — DDL
- `addForeignKey()` / `addIndex()` — Constraints
- `castType()` — ColumnType -> DB native type 변환
- `buildUpsertSql()` — UPSERT 구문
- `setQueryTimeout()` — 쿼리 타임아웃

**Step 3: 등록 코드 추가**

세 곳에 분기를 추가해요:
- `src/DatabaseClient.ts:72` — `createConnector()` method
- `src/core/EntityManager.ts:158` — `connect()` method의 switch문
- `src/dialects/TransactionSessionManager.ts:48` — `connect()` method의 if-else문

**Step 4: 테스트**

`__tests__/unit/cockroach-driver.test.ts`를 생성해요.

### EntityManager에 새 메서드 추가

EntityManager에 public API를 추가하는 절차예요:

**Step 1:** `src/core/BaseEntityManager.ts` 인터페이스에 메서드 시그니처 추가

**Step 2:** `src/core/EntityManager.ts`에서 구현

**Step 3:** `src/core/BaseRepository.ts`에 wrapper 메서드 추가 (Repository pattern 지원용)

**Step 4:** 필요하면 `src/index.ts` -> `src/core/index.ts`에서 export 확인

### 새 Error 클래스 추가

**Step 1:** `src/errors/OrmErrorCode.ts`에 새 에러 코드 추가

```typescript
export enum OrmErrorCode {
  // ... existing codes
  MY_NEW_ERROR = "ORM_MY_NEW_ERROR",
}
```

**Step 2:** `src/errors/` 디렉토리에 에러 클래스 생성

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

**Step 3:** `src/errors/index.ts`에서 export

---

## 5. 코딩 컨벤션

### SQL Injection 방지

**절대 규칙:** 사용자 입력을 SQL 문자열에 직접 삽입하면 안 돼요.

```typescript
// Correct approach — use sql-template-tag
import sql from "sql-template-tag";
const query = sql`SELECT * FROM users WHERE id = ${userId}`;

// Wrong approach
const query = `SELECT * FROM users WHERE id = ${userId}`;
```

테이블명, 컬럼명 같은 식별자는 드라이버의 `escapeIdentifier()` 또는 `wrapIdentifier()`로 감싸야 해요.

```typescript
// MySQL: `users`, PostgreSQL: "users"
const tableName = driver.escapeIdentifier("users");
```

### Metadata Isolation

```typescript
// Correct approach — AsyncLocalStorage-based request scope
MetadataContext.run("tenant_1", async () => {
  await em.find(User);  // Executes in tenant_1 context
});

// Wrong approach — modifying instance state (not safe with concurrent requests)
store.setContext("tenant_1");  // deprecated!
```

### TypeScript strict Mode

`tsconfig.json`에 `strict: true`가 설정돼 있어요. `any` 타입 사용을 최소화하되, 프레임워크 메타데이터 처리 때문에 불가피한 경우 `eslint-disable` 코멘트를 사용해요.

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

통합 테스트 파일 상단에는 반드시 다음 가드를 포함해야 해요:

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

### Commit Messages

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

**해결:** 앱 진입점 최상단에 `import "reflect-metadata"`를 추가해요. 이 패키지가 없으면 데코레이터 메타데이터(`design:type` 등)를 읽을 수 없어요.

### tsconfig.json 설정 누락

```
Unable to resolve signature of class decorator...
```

**해결:** `tsconfig.json`에 다음 두 옵션이 있어야 해요:

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

**해결:** `examples/`는 로컬 `dist/`를 참조해요. 예제 실행 전에 프로젝트 루트에서 `pnpm build`를 먼저 실행해야 해요.

### 테스트 간 MetadataLayerRegistry 오염

서로 다른 테스트 파일에서 같은 엔티티를 정의하면, MetadataLayerRegistry가 전역 싱글톤이라 메타데이터가 겹칠 수 있어요.

**해결:** 각 테스트 전에 레지스트리를 초기화해요:

```typescript
beforeEach(() => {
  MetadataLayerRegistry.reset();
  MetadataContext.reset();
});
```

### WHERE 조건의 Falsy 값 처리

`0`, `false`, `""` 같은 falsy 값이 WHERE 조건에서 무시되는 버그가 있었어요 (수정 완료).

**참고:** 조건 검사 시 `if (value)` 대신 `if (value !== undefined && value !== null)`을 사용해요.

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

### MySQL Connection Pool 이중 해제

MySQL 드라이버에서 `commit()` 또는 `rollback()` 후 connection 참조를 `undefined`로 설정하지 않으면, 같은 connection이 두 번 해제될 수 있어요.

**관련 코드:** `src/dialects/mysql/MySqlDataSource.ts` — commit/rollback 후 `this.connection = undefined` 설정이 필요해요.

---

## 7. Contribution Workflow

### Branch 전략

```
main (default branch)
  └── feature/feature-name       <- New features
  └── fix/bug-description        <- Bug fixes
  └── docs/doc-topic             <- Documentation changes
```

main에서 브랜치를 만들고, 작업 완료 후 PR을 생성해요.

### PR Checklist

PR을 열기 전에 다음을 확인해요:

- [ ] `pnpm test` 전체 통과 (0 failures)
- [ ] `pnpm build` 성공 (TypeScript 컴파일 에러 없음)
- [ ] 새 기능에 대한 유닛 테스트 추가
- [ ] SQL 쿼리의 사용자 입력은 parameter binding으로 처리
- [ ] 식별자(테이블명, 컬럼명)는 `escapeIdentifier()`로 래핑
- [ ] 메타데이터 접근은 layer 시스템을 통해서만 (전역 상태 사용 금지)
- [ ] API가 변경됐으면 관련 문서(`docs/`) 업데이트
- [ ] 예제 프로젝트에 영향이 있으면 `examples/` 업데이트

### 예제 프로젝트 타입 체크

ORM API를 변경했다면, 예제가 깨지지 않았는지 확인해요:

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
| [Entity Definition](./entities.md) | 컬럼, 인덱스, 훅, 유효성 검사 | 데코레이터 동작을 이해할 때 |
| [Relations](./relations.md) | ManyToOne, OneToMany, ManyToMany | 관계 로딩 코드를 수정할 때 |
| [EntityManager](./entity-manager.md) | find, save, delete, aggregation | EntityManager API를 확장할 때 |
| [Query Builder](./query-builder.md) | JOIN, GROUP BY, subqueries | QueryBuilder 코드를 수정할 때 |
| [Transactions](./transactions.md) | Isolation levels, Savepoint | TransactionSessionManager를 수정할 때 |
| [Migrations](./migrations.md) | MigrationRunner, CLI | 마이그레이션 시스템을 수정할 때 |
| [Configuration Guide](./configuration.md) | Pooling, timeout, Read Replica | DatabaseClientOptions를 확장할 때 |
| [Advanced Features](./advanced.md) | N+1 감지, 이벤트, 커서 페이지네이션 | QueryTracker, EventEmitter를 수정할 때 |
| [Multi-Tenancy](./multi-tenancy.md) | Layered metadata, 스키마 격리 | 멀티테넌시 기능을 수정할 때 |
| [API Reference](./api-reference.md) | 메서드 시그니처 목록 | public API를 확인할 때 |
| Manual Testing Guide (`internal/manual-testing-guide.md`, 저장소 전용, EN) | 수동 통합 테스트 실행 | 통합 테스트 환경을 설정할 때 |
| Pre-Release Checklist (`internal/pre-release-checklist.md`, 저장소 전용, EN) | 릴리스 전 확인 항목 | 버전 릴리스를 준비할 때 |

### 주요 소스 파일 빠른 참조

| File | One-Line Description |
|------|---------------------|
| `src/core/EntityManager.ts` | CRUD, 관계 로딩, 트랜잭션 -- ORM의 중심 |
| `src/dialects/SqlDriver.ts` | `ISqlDriver` 인터페이스 정의 |
| `src/metadata/MetadataContext.ts` | AsyncLocalStorage 기반 tenant context |
| `src/scanner/MetadataScanner.ts` | `MetadataLayerRegistry` -- 데코레이터 시점의 canonical metadata store |
| `src/decorators/Entity.ts` | `@Entity()` decorator -- 엔티티 메타데이터 스냅샷 |
| `src/decorators/Column.ts` | `@Column()` decorator -- 컬럼 메타데이터 + 타입 추론 |
| `src/DatabaseClient.ts` | DB 연결 싱글톤 (named connections 지원) |
| `src/dialects/TransactionSessionManager.ts` | 트랜잭션 라이프사이클 관리 |
| `src/core/BaseRepository.ts` | Repository pattern 기반 클래스 |
| `src/errors/OrmError.ts` | Error 기반 클래스 (`OrmErrorCode` 기반) |
| `src/index.ts` | 패키지 public API 진입점 |
