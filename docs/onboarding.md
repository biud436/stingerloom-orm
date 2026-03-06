# 컨트리뷰터 온보딩 가이드

> **이 문서의 목적:** Stingerloom ORM의 **내부 아키텍처**를 이해하고, 코드를 수정하거나 새 기능을 추가할 수 있도록 돕는 것입니다. API 사용법을 찾고 있다면 [시작하기](./getting-started.md)를 먼저 읽어주세요.

> **대상 독자:** 프로젝트에 처음 투입된 개발자 또는 외부 컨트리뷰터

---

## 1. 로컬 개발 환경 설정

### 필수 도구

| 도구 | 최소 버전 | 비고 |
|------|----------|------|
| Node.js | ≥16 | `package.json`의 `engines` 필드 참고 |
| pnpm | ≥8 | 프로젝트 패키지 매니저 |
| TypeScript | ≥5.6 | `devDependencies`에 포함 |
| Docker | 최신 안정 버전 | 통합 테스트용 MySQL/PostgreSQL |

### 클론 및 빌드

```bash
git clone https://github.com/biud436/stingerloom-orm.git
cd stingerloom-orm
pnpm install
pnpm build          # dist/ 생성 — 예제 실행 전 반드시 필요
```

`pnpm build`는 `rimraf dist && tsc`를 실행합니다. ORM이 아직 npm에 배포되지 않았으므로, `examples/` 프로젝트는 로컬 빌드 결과물(`dist/`)을 참조합니다.

### Docker로 데이터베이스 설정

통합 테스트를 실행하려면 MySQL과 PostgreSQL이 필요합니다.

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

# 특정 테스트 파일만 실행
pnpm test -- --testPathPattern="schema-diff"

# 통합 테스트 (MySQL/PostgreSQL 실행 중이어야 함)
INTEGRATION_TEST=true pnpm test -- --testPathPattern="integration"
```

유닛 테스트는 72+ 파일, 1400+ 케이스로 구성됩니다. 통합 테스트는 `INTEGRATION_TEST=true` 환경변수가 없으면 자동으로 skip됩니다.

### 예제 실행

```bash
pnpm build                              # 반드시 먼저 빌드
cd examples/nestjs-cats && pnpm install && pnpm start
# 또는
cd examples/nestjs-blog && pnpm install && pnpm start
```

---

## 2. 아키텍처 개요

### 디렉토리 구조

```
src/
├── core/               ← 핵심 로직 (EntityManager, Repository, QueryBuilder 등)
├── decorators/         ← @Entity, @Column 등 데코레이터 정의
├── dialects/           ← DB별 드라이버 구현 (MySQL, PostgreSQL, SQLite)
├── metadata/           ← 레이어드 메타데이터 시스템 (멀티테넌시)
├── scanner/            ← 데코레이터 메타데이터 수집기 (EntityScanner, ColumnScanner 등)
├── migration/          ← 마이그레이션 시스템
├── types/              ← 공통 타입 정의
├── utils/              ← 헬퍼 (Logger, ReflectManager)
└── errors/             ← 에러 클래스 계층
```

**왜 이렇게 나뉘어 있나?**

- `core/`와 `dialects/`를 분리하여 DB 독립적인 로직과 DB 특화 코드를 격리합니다.
- `scanner/`와 `decorators/`를 분리하여 "메타데이터 수집"과 "메타데이터 정의"의 관심사를 나눕니다.
- `metadata/`를 독립 모듈로 두어 멀티테넌시 레이어 시스템이 다른 코드에 영향을 주지 않습니다.

### 데이터 흐름

엔티티 클래스가 정의되어 DB에 저장되기까지의 전체 흐름입니다.

```
┌─────────────────────────────────────────────────────────────────────┐
│                      데코레이터 등록 (앱 로드 시)                      │
│                                                                     │
│  @Column()    →  ColumnScanner.set()   ─┐                           │
│  @ManyToOne() →  ManyToOneScanner.set() ├→ MetadataLayerRegistry    │
│  @Entity()    →  EntityScanner.set()   ─┘   (public 레이어에 기록)    │
└─────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                 EntityManager.register() 호출                       │
│                                                                     │
│  DatabaseClient.connect()  →  Connector 생성  →  Driver 생성        │
│       (싱글톤)                  (MySQL/PG/...)     (ISqlDriver 구현)  │
│                                                                     │
│  registerEntities()                                                  │
│    1패스: createTable() — 테이블 DDL 생성                              │
│    2패스: registerForeignKeys/Index — FK/인덱스 추가                   │
│    3패스: ManyToMany 중간 테이블 생성                                   │
└─────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      CRUD 실행 (런타임)                              │
│                                                                     │
│  em.save(User, data)                                                │
│    → 메타데이터 조회 (MetadataLayerRegistry)                          │
│    → BeforeInsert 훅 실행                                            │
│    → TransactionSessionManager.connect()                             │
│    → START TRANSACTION / BEGIN                                       │
│    → SQL 빌드 (sql-template-tag 파라미터 바인딩)                       │
│    → Driver를 통해 실행                                               │
│    → 역직렬화 (Deserializer)                                         │
│    → COMMIT (또는 에러 시 ROLLBACK)                                   │
│    → AfterInsert 훅 실행                                             │
└─────────────────────────────────────────────────────────────────────┘
```

### 레이어드 메타데이터 시스템

Docker의 OverlayFS와 동일한 개념으로 동작합니다.

```
┌──────────────────────────────┐
│    Tenant Layer (upper)      │  ← 테넌트별 수정 사항 (Copy-on-Write)
│    예: "tenant_1", "tenant_2"│
├──────────────────────────────┤
│    Public Layer (lower)      │  ← 기본 스키마 (모든 엔티티 메타데이터)
│    읽기 전용 (데코레이터 등록 후)│
└──────────────────────────────┘
```

**동작 원리:**

1. 앱 로드 시 `@Entity`, `@Column` 등의 데코레이터가 public 레이어에 메타데이터를 기록합니다.
2. 멀티테넌트 환경에서 `MetadataContext.run("tenant_1", callback)`을 호출하면, 해당 콜백 내에서는 tenant_1 레이어가 활성화됩니다.
3. 메타데이터 조회 시 tenant 레이어를 먼저 확인하고, 없으면 public 레이어로 fallback합니다 (OverlayFS).
4. 쓰기는 항상 tenant 레이어에만 발생합니다 (Copy-on-Write).

**핵심 파일:**

| 파일 | 역할 |
|------|------|
| `src/metadata/MetadataContext.ts` | AsyncLocalStorage 기반 요청 스코프 컨텍스트 |
| `src/metadata/LayeredMetadataStore.ts` | 레이어 기반 메타데이터 저장소 |
| `src/metadata/MetadataLayer.ts` | 개별 레이어 (key-value Map) |
| `src/scanner/MetadataScanner.ts` | MetadataLayerRegistry를 사용하는 스캐너 기반 클래스 |

### 드라이버 추상화

모든 DB 드라이버는 `ISqlDriver` 인터페이스(`src/dialects/SqlDriver.ts`)를 구현합니다.

| 드라이버 | 식별자 래핑 | PK 자동 생성 | 스키마 지원 | 파일 경로 |
|---------|-----------|-------------|-----------|----------|
| MySQL | 백틱 (`` ` ``) | `AUTO_INCREMENT` | 미지원 | `src/dialects/mysql/MySqlDriver.ts` |
| PostgreSQL | 큰따옴표 (`"`) | `SERIAL` / `RETURNING` | 지원 (`schema.table`) | `src/dialects/postgres/PostgresDriver.ts` |
| SQLite | 큰따옴표 (`"`) | `INTEGER PRIMARY KEY` | 미지원 | `src/dialects/sqlite/SqliteDriver.ts` |

각 드라이버의 연결 계층 구조:

```
DatabaseClient (싱글톤)
  └→ Connector (IConnector 구현 — 실제 DB 연결 관리)
       └→ Driver (ISqlDriver 구현 — DDL/DML 추상화)
            └→ DataSource (IDataSource 구현 — 트랜잭션/쿼리 실행)
```

---

## 3. 주요 코드 흐름

### 연결 흐름

```
EntityManager.register(options)
  → EntityManager.connect(options)
      → DatabaseClient.getInstance().connect(options)
          → createConnector(type)   // MySqlConnector | PostgresConnector | ...
          → connector.connect(options)
      → Driver 생성 (MySqlDriver | PostgresDriver | ...)
      → DataSource 생성 (트랜잭션 관리용)
  → EntityManager.registerEntities()
```

**관련 파일:**
- `src/core/EntityManager.ts:121` — `register()` 메서드
- `src/core/EntityManager.ts:146` — `connect()` 메서드
- `src/DatabaseClient.ts:48` — `connect()` 메서드

### 엔티티 등록 흐름

데코레이터는 클래스 정의 시점(모듈 로드 시)에 실행됩니다. 실행 순서가 중요합니다.

```
1. @Column() 실행 (프로퍼티 데코레이터 — 클래스 본문 순서대로)
   → inferColumnDefaults()로 design:type 추론
   → ColumnScanner.set()으로 메타데이터 임시 저장

2. @ManyToOne() 실행 (프로퍼티 데코레이터)
   → ManyToOneScanner.set()으로 관계 메타데이터 임시 저장

3. @Entity() 실행 (클래스 데코레이터 — 가장 마지막)
   → ColumnScanner.allMetadata()로 수집된 컬럼 가져오기
   → ManyToOneScanner.allMetadata()로 수집된 관계 가져오기
   → EntityScanner.set()으로 엔티티 메타데이터 스냅샷
   → ColumnScanner.clear()로 임시 버퍼 초기화
```

**핵심 포인트:** `@Column()`이 `@Entity()`보다 먼저 실행됩니다. `@Entity()`는 그때까지 수집된 컬럼 메타데이터를 스냅샷으로 저장하고 임시 버퍼를 비웁니다.

**관련 파일:**
- `src/decorators/Column.ts:153` — `Column()` 데코레이터
- `src/decorators/Entity.ts:24` — `Entity()` 데코레이터
- `src/scanner/MetadataScanner.ts:179` — 스캐너 기반 클래스

### CRUD 흐름 (save 예시)

```
em.save(User, { name: "홍길동", email: "hong@example.com" })
  1. resolveEntityMetadata(User)
     → EntityScanner.scan(User) 또는 Reflect.getMetadata(ENTITY_TOKEN, User)
  2. EntityValidator.validate(entity)
     → @Validation 데코레이터 검증
  3. 훅 실행: BeforeInsert
  4. EntitySubscriber.beforeInsert() 이벤트
  5. TransactionSessionManager 생성 → connect() → startTransaction()
  6. SQL 빌드: INSERT INTO "users" ("name", "email") VALUES ($1, $2)
     → sql-template-tag로 파라미터 바인딩
  7. query 실행 → 결과 행 반환
  8. commit()
  9. Deserializer로 결과 → User 인스턴스 변환
  10. 훅 실행: AfterInsert
  11. EntitySubscriber.afterInsert() 이벤트
```

**관련 파일:**
- `src/core/EntityManager.ts:2146` — `save()` 메서드
- `src/dialects/TransactionSessionManager.ts` — 트랜잭션 관리
- `src/core/EntityValidator.ts` — 유효성 검사

### 관계 로딩

**Eager Loading (기본):**

```
em.find(Post, { relations: ["author"] })
  → LEFT JOIN으로 관계 엔티티를 한 번에 조회
  → ResultTransformer가 flat한 행을 중첩 객체로 변환
```

**Lazy Loading:**

```
em.find(Post, { relations: [] })  // lazy로 설정된 관계
  → Object.defineProperty()로 getter proxy 주입
  → post.author에 접근 시 → 별도 SELECT 쿼리 실행
  → 이후 접근 시 캐시된 값 반환
```

**관련 파일:**
- `src/core/LazyLoader.ts` — `injectLazyProxy()`, `createLazyProxy()`

---

## 4. 새 기능 추가 가이드

### 새 데코레이터 추가

예시: `@CreatedAt()` 데코레이터를 추가한다고 가정합니다.

**1단계: Symbol 토큰 정의 + 데코레이터 함수 작성**

```typescript
// src/decorators/CreatedAt.ts
export const CREATED_AT_TOKEN = Symbol.for("STG_CREATED_AT");

export function CreatedAt(): PropertyDecorator {
  return (target, propertyKey) => {
    Reflect.defineMetadata(CREATED_AT_TOKEN, propertyKey, target.constructor);
  };
}
```

**2단계: 데코레이터 export**

```typescript
// src/decorators/index.ts에 추가
export * from "./CreatedAt";
```

**3단계: EntityManager에서 토큰 사용**

save/update 메서드에서 `Reflect.getMetadata(CREATED_AT_TOKEN, entity)`를 조회하여 자동으로 날짜를 설정합니다.

**4단계: 테스트 작성**

`__tests__/unit/created-at.test.ts` 파일을 생성하고 데코레이터 동작을 검증합니다.

**네이밍 규칙:**
- 토큰 심볼: `STG_` 접두사 (예: `Symbol.for("STG_CREATED_AT")`)
- 데코레이터 파일: PascalCase (예: `CreatedAt.ts`)
- 토큰 상수: SCREAMING_SNAKE_CASE + `_TOKEN` 접미사 (예: `CREATED_AT_TOKEN`)

### 새 드라이버 추가

새 데이터베이스(예: CockroachDB)를 지원하려면:

**1단계: 디렉토리 생성**

```
src/dialects/cockroach/
  ├── CockroachDriver.ts       ← ISqlDriver 구현
  ├── CockroachConnector.ts    ← IConnector 구현
  └── CockroachDataSource.ts   ← IDataSource 구현
```

**2단계: ISqlDriver 완전 구현**

`src/dialects/SqlDriver.ts`의 `ISqlDriver` 인터페이스에 정의된 모든 메서드를 구현합니다. 주요 메서드:
- `createTable()` / `hasTable()` — DDL
- `addForeignKey()` / `addIndex()` — 제약 조건
- `castType()` — ColumnType → DB 네이티브 타입 변환
- `buildUpsertSql()` — UPSERT 구문
- `setQueryTimeout()` — 쿼리 타임아웃

**3단계: 등록 코드 추가**

세 곳에 분기를 추가합니다:
- `src/DatabaseClient.ts:72` — `createConnector()` 메서드
- `src/core/EntityManager.ts:158` — `connect()` 메서드의 switch
- `src/dialects/TransactionSessionManager.ts:48` — `connect()` 메서드의 if-else

**4단계: 테스트**

`__tests__/unit/cockroach-driver.test.ts` 파일을 생성합니다.

### EntityManager에 새 메서드 추가

EntityManager의 공개 API를 추가하는 절차:

**1단계:** `src/core/BaseEntityManager.ts` 인터페이스에 메서드 시그니처 추가

**2단계:** `src/core/EntityManager.ts`에 구현

**3단계:** `src/core/BaseRepository.ts`에 래퍼 메서드 추가 (Repository 패턴 지원)

**4단계:** 필요하면 `src/index.ts` → `src/core/index.ts`에서 export 확인

### 새 에러 클래스 추가

**1단계:** `src/errors/OrmErrorCode.ts`에 새 에러 코드 추가

```typescript
export enum OrmErrorCode {
  // ... 기존 코드
  MY_NEW_ERROR = "ORM_MY_NEW_ERROR",
}
```

**2단계:** `src/errors/` 디렉토리에 에러 클래스 생성

```typescript
// src/errors/MyNewError.ts
import { OrmError } from "./OrmError";
import { OrmErrorCode } from "./OrmErrorCode";

export class MyNewError extends OrmError {
  constructor() {
    super(OrmErrorCode.MY_NEW_ERROR, "설명 메시지");
    this.name = "MyNewError";
  }
}
```

**3단계:** `src/errors/index.ts`에서 export

---

## 5. 코딩 컨벤션

### SQL Injection 방지

**절대 규칙:** 사용자 입력을 SQL 문자열에 직접 삽입하지 않습니다.

```typescript
// 올바른 방법 — sql-template-tag 사용
import sql from "sql-template-tag";
const query = sql`SELECT * FROM users WHERE id = ${userId}`;

// 잘못된 방법
const query = `SELECT * FROM users WHERE id = ${userId}`;
```

테이블명/컬럼명 같은 식별자는 드라이버의 `escapeIdentifier()` 또는 `wrapIdentifier()`로 래핑합니다.

```typescript
// MySQL: `users`, PostgreSQL: "users"
const tableName = driver.escapeIdentifier("users");
```

### 메타데이터 격리

```typescript
// 올바른 방법 — AsyncLocalStorage 기반 요청 스코프
MetadataContext.run("tenant_1", async () => {
  await em.find(User);  // tenant_1 컨텍스트에서 실행
});

// 잘못된 방법 — 인스턴스 상태 변경 (동시 요청 시 안전하지 않음)
store.setContext("tenant_1");  // deprecated!
```

### TypeScript strict 모드

`tsconfig.json`에 `strict: true`가 설정되어 있습니다. `any` 타입은 최소화하되, 프레임워크 특성상 메타데이터 처리에서 불가피한 경우 `eslint-disable` 주석을 사용합니다.

### 테스트 패턴

**유닛 테스트:**

```typescript
// jest.mock으로 DB 연결을 모킹
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

통합 테스트 파일 상단에는 반드시 다음 가드를 넣습니다:

```typescript
const SKIP = !process.env.INTEGRATION_TEST;
(SKIP ? describe.skip : describe)("Integration: ...", () => { ... });
```

### 네이밍 규칙

| 대상 | 규칙 | 예시 |
|------|------|------|
| 엔티티 클래스 | PascalCase | `User`, `BlogPost` |
| 테이블명 | snake_case (자동 변환) | `user`, `blog_post` |
| 데코레이터 토큰 | `STG_` 접두사 + SCREAMING_SNAKE | `Symbol.for("STG_ENTITY")` |
| 드라이버 클래스 | `{DB}Driver` | `MySqlDriver`, `PostgresDriver` |
| 커넥터 클래스 | `{DB}Connector` | `MySqlConnector` |
| 데이터 소스 클래스 | `{DB}DataSource` | `MySqlDataSource` |
| 스캐너 클래스 | `{Name}Scanner` | `ColumnScanner`, `EntityScanner` |
| 에러 클래스 | `{Desc}Error` | `EntityNotFound`, `InvalidQueryError` |

### 커밋 메시지

```
feat: 새 기능 추가
fix: 버그 수정
docs: 문서 변경
test: 테스트 추가/수정
refactor: 리팩토링 (기능 변경 없음)
chore: 빌드, 설정 변경
```

---

## 6. 흔한 실수와 트러블슈팅

### `reflect-metadata` 미임포트

```
TypeError: Reflect.getMetadata is not a function
```

**해결:** 앱 진입점 최상단에 `import "reflect-metadata"` 추가. 이 패키지가 없으면 데코레이터 메타데이터 (`design:type` 등)를 읽을 수 없습니다.

### tsconfig.json 설정 누락

```
Unable to resolve signature of class decorator...
```

**해결:** `tsconfig.json`에 다음 두 옵션이 반드시 있어야 합니다:

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

**해결:** `examples/`는 로컬 `dist/`를 참조합니다. 예제 실행 전 반드시 `pnpm build`를 프로젝트 루트에서 실행하세요.

### 테스트 간 MetadataLayerRegistry 오염

서로 다른 테스트 파일에서 같은 엔티티를 정의하면, MetadataLayerRegistry가 전역 싱글톤이므로 메타데이터가 겹칠 수 있습니다.

**해결:** 테스트 시작 전 레지스트리를 초기화합니다:

```typescript
beforeEach(() => {
  MetadataLayerRegistry.reset();
  MetadataContext.reset();
});
```

### WHERE 조건에서 falsy 값 처리

`0`, `false`, `""` 같은 falsy 값이 WHERE 조건에서 무시되는 버그가 있었습니다 (수정 완료).

**주의:** 조건 검사 시 `if (value)` 대신 `if (value !== undefined && value !== null)`을 사용하세요.

```typescript
// 올바른 방법
if (value !== undefined && value !== null) {
  conditions.push(sql`${column} = ${value}`);
}

// 잘못된 방법 — 0, false, "" 를 무시함
if (value) {
  conditions.push(sql`${column} = ${value}`);
}
```

### MySQL connection pool 이중 해제

MySQL 드라이버에서 `commit()` 또는 `rollback()` 후 connection 참조를 `undefined`로 설정하지 않으면, 같은 connection이 두 번 release될 수 있습니다.

**관련 코드:** `src/dialects/mysql/MySqlDataSource.ts` — commit/rollback 후 `this.connection = undefined` 설정 필수.

---

## 7. 기여 워크플로우

### 브랜치 전략

```
main (기본 브랜치)
  └── feature/새기능명       ← 새 기능
  └── fix/버그설명           ← 버그 수정
  └── docs/문서주제          ← 문서 변경
```

main 브랜치에서 분기하고, 작업 완료 후 PR을 생성합니다.

### PR 체크리스트

PR을 올리기 전에 다음을 확인하세요:

- [ ] `pnpm test` 전체 통과 (0 failures)
- [ ] `pnpm build` 성공 (TypeScript 컴파일 에러 없음)
- [ ] 새 기능에 대한 유닛 테스트 추가
- [ ] SQL 쿼리에 사용자 입력이 파라미터 바인딩으로 처리됨
- [ ] 식별자(테이블명, 컬럼명)가 `escapeIdentifier()`로 래핑됨
- [ ] 메타데이터 접근이 레이어 시스템을 통해 이루어짐 (전역 상태 사용 금지)
- [ ] API가 변경되었다면 관련 문서(`docs/`) 업데이트
- [ ] 예제 프로젝트에 영향이 있다면 `examples/`도 함께 수정

### 예제 프로젝트 타입 체크

ORM API를 변경했다면 예제가 깨지지 않는지 확인합니다:

```bash
pnpm build
cd examples/nestjs-cats && pnpm install && npx tsc --noEmit
cd ../nestjs-blog && pnpm install && npx tsc --noEmit
cd ../nestjs-multitenant && pnpm install && npx tsc --noEmit
```

---

## 8. 참고 자료

### 기존 문서 크로스 레퍼런스

| 문서 | 내용 | 언제 참고하나요? |
|------|------|----------------|
| [시작하기](./getting-started.md) | 설치, 첫 엔티티, 첫 CRUD | ORM 사용법을 처음 배울 때 |
| [엔티티 정의](./entities.md) | 컬럼, 인덱스, 훅, 유효성 검사 | 데코레이터 동작을 이해할 때 |
| [관계 설정](./relations.md) | ManyToOne, OneToMany, ManyToMany | 관계 로딩 코드를 수정할 때 |
| [EntityManager](./entity-manager.md) | find, save, delete, 집계 | EntityManager API를 확장할 때 |
| [쿼리 빌더](./query-builder.md) | JOIN, GROUP BY, 서브쿼리 | QueryBuilder 코드를 수정할 때 |
| [트랜잭션](./transactions.md) | 격리 수준, Savepoint | TransactionSessionManager를 수정할 때 |
| [마이그레이션](./migrations.md) | MigrationRunner, CLI | 마이그레이션 시스템을 수정할 때 |
| [설정 가이드](./configuration.md) | 풀링, 타임아웃, Read Replica | DatabaseClientOptions를 확장할 때 |
| [고급 기능](./advanced.md) | N+1 감지, 이벤트, 커서 페이지네이션 | QueryTracker, EventEmitter를 수정할 때 |
| [멀티테넌시](./multi-tenancy.md) | 레이어드 메타데이터, 스키마 격리 | 멀티테넌시 기능을 수정할 때 |
| [API 레퍼런스](./api-reference.md) | 메서드 시그니처 목록 | 공개 API 확인 시 |
| [수동 테스트 가이드](./manual-testing-guide.md) | 통합 테스트 수동 실행 | 통합 테스트 환경 설정 시 |
| [배포 전 체크리스트](./pre-release-checklist.md) | 릴리즈 전 검증 항목 | 버전 배포 준비 시 |

### 핵심 소스 파일 빠른 참조

| 파일 | 한 줄 설명 |
|------|-----------|
| `src/core/EntityManager.ts` | CRUD, 관계 로딩, 트랜잭션 — ORM의 중심 |
| `src/dialects/SqlDriver.ts` | `ISqlDriver` 인터페이스 정의 |
| `src/metadata/MetadataContext.ts` | AsyncLocalStorage 기반 테넌트 컨텍스트 |
| `src/scanner/MetadataScanner.ts` | MetadataLayerRegistry 기반 스캐너 기반 클래스 |
| `src/metadata/LayeredMetadataStore.ts` | Trie 기반 레이어드 메타데이터 저장소 |
| `src/decorators/Entity.ts` | `@Entity()` 데코레이터 — 엔티티 메타데이터 스냅샷 |
| `src/decorators/Column.ts` | `@Column()` 데코레이터 — 컬럼 메타데이터 + 타입 추론 |
| `src/DatabaseClient.ts` | DB 연결 싱글톤 (named connections 지원) |
| `src/dialects/TransactionSessionManager.ts` | 트랜잭션 라이프사이클 관리 |
| `src/core/BaseRepository.ts` | Repository 패턴 기반 클래스 |
| `src/errors/OrmError.ts` | 에러 기반 클래스 (`OrmErrorCode` 기반) |
| `src/index.ts` | 패키지 공개 API 진입점 |
