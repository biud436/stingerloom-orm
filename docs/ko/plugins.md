# Plugins

## 플러그인이 필요한 이유

ORM은 CRUD, 스키마 동기화, 이벤트 시스템, Unit of Work, 감사 로깅, soft delete 등 많은 관심사를 다뤄요. 이걸 전부 코어에 넣으면 쓰지 않는 기능까지 번들 크기, 메모리, 버그 표면적을 키우게 돼요.

플러그인은 코어를 작고 핵심적으로 유지하면서, 선택적 기능은 별도 모듈로 분리해서 필요할 때만 설치할 수 있게 해줘요.

브라우저 확장 프로그램과 비슷해요. 브라우저는 페이지 렌더링, 탭 관리, 북마크 같은 필수 기능만 제공하고, 광고 차단이나 비밀번호 관리는 확장 프로그램으로 설치하죠. 필요한 것만 설치하고, 하나를 제거해도 나머지는 영향받지 않아요.

## 플러그인 동작 방식 -- Lifecycle

플러그인은 명확한 lifecycle을 거쳐요:

```
1. INSTALL      em.extend(myPlugin)
                  |
                  v
2. RECEIVE      plugin.install(ctx) is called
   CONTEXT        -- ctx gives controlled access to EntityManager internals
                  |
                  v
3. ADD          install() returns an API object
   METHODS        -- those methods are mixed into the EntityManager instance
                  |
                  v
4. (active)     Your code calls em.myNewMethod()
                  -- the plugin is fully operational
                  |
                  v
5. SHUTDOWN     em.propagateShutdown() calls plugin.shutdown()
                  -- clean up timers, connections, caches
```

각 단계를 하나씩 살펴볼게요.

### Step 1: Install

`em.extend()`에 플러그인 객체를 전달해요. Stingerloom은 같은 이름의 플러그인이 이미 설치되어 있는지 확인하고, 이미 있으면 아무 동작도 하지 않아요. 멱등성(idempotent) 설계라서 여러 번 호출해도 안전해요.

```typescript
import { EntityManager } from "@stingerloom/orm";

const em = new EntityManager();
em.extend(myPlugin());
```

`register()`의 `plugins` 배열로도 전달할 수 있어요. DB 연결이 완료된 후 자동으로 설치돼요:

```typescript
await em.register({
  type: "postgres",
  host: "localhost",
  port: 5432,
  username: "postgres",
  password: "password",
  database: "mydb",
  entities: [User, Post, Comment],
  synchronize: true,
  plugins: [myPlugin()],
});
```

### Step 2: Receive Context

`install()`이 호출되면 `PluginContext` 객체를 받아요. EntityManager 내부를 직접 노출하는 게 아니라, 플러그인이 사용할 수 있도록 정제된 API 표면이에요. EntityManager 내부가 변경되어도 플러그인은 안정적으로 동작해요.

### Step 3: Add Methods

`install()` 함수가 객체를 반환하면, 그 객체의 모든 메서드가 EntityManager 인스턴스에 믹스인돼요. 설치 후에는 `em`에서 직접 호출할 수 있어요.

### Step 4: Active Operation

플러그인이 EntityManager의 일부가 됐어요. 이벤트 리스너가 동작하고, 메서드를 호출할 수 있고, 네이티브 기능처럼 동작해요.

### Step 5: Shutdown

`em.propagateShutdown()`이 호출되면 (예: NestJS 앱 종료 시) 플러그인은 역순으로 `shutdown()`을 받아요. 마지막에 설치된 플러그인이 가장 먼저 종료돼요. interval 정리, 소켓 닫기, 버퍼 flush 등을 여기서 해요.

---

## 커스텀 플러그인 작성하기

플러그인은 `StingerloomPlugin` 인터페이스를 구현한 객체예요: `name`, `install()` 함수, 그리고 선택적인 `shutdown()` 함수로 구성돼요.

### 전체 예제: Timestamp Logger

엔티티가 INSERT 또는 DELETE될 때마다 타임스탬프와 함께 로그를 기록하는 플러그인이에요.

```typescript
import { StingerloomPlugin, PluginContext } from "@stingerloom/orm";

const timestampLogger: StingerloomPlugin<{ getLog(): string[] }> = {
  name: "timestamp-logger",

  install(ctx: PluginContext) {
    const log: string[] = [];

    ctx.events.on("afterInsert", ({ entity }) => {
      log.push(`[${new Date().toISOString()}] INSERT ${entity.name}`);
    });

    ctx.events.on("afterDelete", ({ entity }) => {
      log.push(`[${new Date().toISOString()}] DELETE ${entity.name}`);
    });

    return {
      getLog: () => [...log],
    };
  },

  shutdown() {
    // Nothing to clean up in this simple example,
    // but this is where you would clear timers or close connections.
  },
};

em.extend(timestampLogger);
em.getLog(); // typed as string[]
```

### 동작 과정 추적

1. `em.extend(timestampLogger)`를 호출해요.
2. Stingerloom이 `"timestamp-logger"` 이름의 플러그인이 이미 있는지 확인해요. 없으니 진행해요.
3. `timestampLogger.install(ctx)`를 호출하면서 PluginContext를 전달해요.
4. `install()` 내부에서 클로저 스코프에 빈 `log` 배열을 만들어요. 이 배열은 플러그인 전용이라 외부에서 직접 접근할 수 없어요.
5. `ctx.events`에 `"afterInsert"`와 `"afterDelete"` 두 이벤트를 구독해요. EntityManager가 INSERT나 DELETE를 완료할 때마다 콜백이 실행되면서 `log` 배열에 문자열을 추가해요.
6. `install()`이 `{ getLog: () => [...log] }`를 반환해요. spread 연산자 `[...log]`로 복사본을 만들기 때문에 호출자가 내부 배열을 변경할 수 없어요.
7. Stingerloom이 반환값을 `em`에 믹스인해요. 이제 `em.getLog()`를 호출할 수 있고, TypeScript도 `string[]` 반환 타입을 알아요.
8. 나중에 `em.save(User, { name: "Alice" })`를 호출하면, EntityManager가 `"afterInsert"` 이벤트를 발생시키고, 플러그인 콜백이 `"[2026-03-22T10:00:00.000Z] INSERT User"`를 로그에 추가해요.
9. `em.getLog()`를 호출하면 `["[2026-03-22T10:00:00.000Z] INSERT User"]`를 받아요.
10. 앱이 종료되고 `em.propagateShutdown()`이 호출되면, `timestampLogger.shutdown()`이 실행돼요.

---

## PluginContext Reference

`install()` 함수가 받는 `PluginContext`는 EntityManager 내부에 대한 제어된 접근을 제공해요. 각 속성과 메서드를 언제 사용하는지 정리했어요.

| Property / Method | 설명 | 언제 사용하나요? |
|-------------------|------|-----------------|
| `ctx.em` | EntityManager 인스턴스 | `find()`, `save()`, `delete()` 등 EntityManager 메서드를 호출할 때. hook과 이벤트가 정상 동작하려면 raw SQL 대신 `ctx.em`을 사용해야 해요. |
| `ctx.driver` | 현재 SQL driver (`register()` 전에는 `undefined`) | raw SQL을 실행하거나 DB별 기능을 확인할 때. `register()` 호출 전에 설치하면 undefined예요. |
| `ctx.events` | Entity event emitter (`on`, `off`, `emit`) | 엔티티 lifecycle 이벤트에 반응할 때: `beforeInsert`, `afterInsert`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, `afterDelete`. 가장 흔한 플러그인 패턴이에요. |
| `ctx.connectionName` | 연결 이름 (기본값: `"default"`) | multi-database 환경에서 연결별로 다르게 동작해야 할 때. 예: audit 플러그인이 `"primary"` 연결에서만 로그를 남기는 경우. |
| `ctx.addSubscriber(sub)` | EntitySubscriber 등록 | 클래스 기반 EntitySubscriber를 제공할 때 (`listenTo()` 필터링이 가능한 이벤트 콜백 대안). |
| `ctx.removeSubscriber(sub)` | EntitySubscriber 제거 | 런타임에 동적으로 구독을 해제해야 할 때. |
| `ctx.getEntities()` | 등록된 모든 엔티티 클래스 | 스키마를 분석해야 할 때. 예: 문서 생성, 엔티티 정의 검증. |
| `ctx.getPlugin(name)` | 다른 플러그인의 API 접근 | 다른 플러그인에 의존해서 그 메서드를 호출해야 할 때. 아래 "Plugin Dependencies" 참고. |
| `ctx.isMySqlFamily()` | MySQL/MariaDB 드라이버인지 확인 | SQL 생성 시 backtick vs double-quote 구분이 필요할 때. |
| `ctx.isPostgres()` | PostgreSQL 드라이버인지 확인 | PostgreSQL 전용 기능(schema, JSONB 연산자, RETURNING 절)을 사용할 때. |
| `ctx.isSqlite()` | SQLite 드라이버인지 확인 | SQLite가 지원하지 않는 기능(ALTER COLUMN, EXPLAIN 등)을 건너뛸 때. |
| `ctx.wrap(identifier)` | 드라이버의 quoting 방식으로 식별자를 감싸기 | SQL 문자열을 만들 때 컬럼명이나 테이블명을 안전하게 quote해야 할 때. MySQL은 backtick, PostgreSQL/SQLite는 double quote를 사용해요. |
| `ctx.wrapTable(tableName)` | 테이블명 quote (schema prefix 포함) | `wrap()`과 같지만 schema 한정 이름을 처리해요 (예: PostgreSQL의 `"public"."user"`). |
| `ctx.executeInTransaction(fn)` | 트랜잭션 안에서 콜백 실행 | 여러 SQL 문을 원자적으로 실행해야 할 때. 성공 시 commit, 에러 시 rollback돼요. |
| `ctx.executeReadOnly(fn)` | 읽기 전용 트랜잭션에서 콜백 실행 | 읽기만 할 때 DB에 최적화 신호를 보내고 싶을 때 (read-replica 환경에서 replica를 사용해요). |
| `ctx.getEntityMetadata(cls)` | 엔티티 클래스의 구조적 메타데이터 | 유저 엔티티의 컬럼, 관계, PK, 인덱스, 테이블명을 검사해야 할 때 — 예를 들어 엔티티별 감사 테이블을 발행하거나 스키마 문서를 생성할 때. 등록되지 않은 클래스는 `null`을 반환해요. |
| `ctx.registerPlaceholder(name)` | 플러그인이 추가할 메서드 이름 사전 선언 | 메서드가 실제 설치되기 *전* 에 해결 가능해야 할 때 (순환 의존, 타입 플레이스홀더 API 등). 이름을 예약하면 다른 플러그인이 덮어쓰는 것도 막아요. |

---

## Plugin Dependencies

플러그인이 다른 플러그인의 선행 설치를 요구할 수 있어요. 의존성이 누락되면 `extend()`가 명확한 에러 메시지와 함께 즉시 throw해요.

```typescript
const derivedPlugin: StingerloomPlugin = {
  name: "derived",
  dependencies: ["base-plugin"],

  install(ctx) {
    const baseApi = ctx.getPlugin<{ getData(): any[] }>("base-plugin");
    // use baseApi...
  },
};

// This throws -- "base-plugin" is not installed
em.extend(derivedPlugin);

// This works -- install the dependency first
em.extend(basePlugin());
em.extend(derivedPlugin);
```

서로 의존하는 플러그인 패밀리를 만들 때 유용해요. 예를 들어 "soft-delete-audit" 플러그인이 "soft-delete"와 "audit" 플러그인 둘 다에 의존하는 경우요.

---

## Method Name Conflicts

플러그인이 EntityManager에 이미 존재하는 메서드(예: `find`, `save`)를 추가하려 하면 `PLUGIN_CONFLICT` 에러가 발생해요. 코어 메서드를 덮어쓰면 예측할 수 없는 방식으로 ORM이 깨지기 때문에 이런 안전 장치가 있어요.

플러그인 API 메서드 이름은 고유하고 설명적으로 지어야 해요. 플러그인 이름을 접두사로 붙이는 게 좋은 관례예요: `getLog()` 대신 `auditGetLog()` 같은 식이에요.

---

## API Reference

### StingerloomPlugin\<TApi\>

```typescript
interface StingerloomPlugin<TApi = {}> {
  /** Unique plugin name (used for dependency resolution and dedup) */
  readonly name: string;

  /** Names of plugins that must be installed before this one */
  readonly dependencies?: readonly string[];

  /**
   * Called once when the plugin is installed via em.extend(plugin).
   * May return an API object whose methods will be mixed into the EntityManager.
   */
  install(context: PluginContext): TApi | void;

  /**
   * Called during propagateShutdown() in reverse installation order.
   * Used to clean up plugin resources (timers, connections, caches).
   */
  shutdown?(): Promise<void> | void;
}
```

### EntityManager Plugin Methods

| Method | Signature | 설명 |
|--------|-----------|------|
| `extend` | `<TApi>(plugin): this & TApi` | 플러그인을 설치하고 API를 EntityManager에 믹스인해요 |
| `hasPlugin` | `(name: string): boolean` | 이름으로 플러그인 설치 여부를 확인해요 |
| `getPluginApi` | `<T>(name: string): T \| undefined` | 이름으로 플러그인의 API 객체를 가져와요 |

---

## 쿼리 훅 -- beforeQuery / afterQuery

플러그인은 EntityManager가 실행하는 모든 SQL 쿼리를 가로챌 수 있어요. 쿼리 로깅, 성능 모니터링, 쿼리 변환 같은 횡단 관심사를 구현할 때 유용해요.

### beforeQuery

모든 SQL 쿼리 실행 전에 호출돼요. 실행 전에 쿼리를 검사하거나 변환할 수 있어요.

```typescript
const queryLogger: StingerloomPlugin = {
  name: "query-logger",

  beforeQuery(query) {
    console.log(`[SQL] ${query.operation}: ${query.sql}`);
    // 선택적으로 수정된 QueryInfo를 반환해서 쿼리를 변환할 수 있어요
  },

  afterQuery(query, result, durationMs) {
    if (durationMs > 1000) {
      console.warn(`[SLOW] ${query.sql} took ${durationMs}ms`);
    }
  },

  install(ctx) {
    // 믹스인할 메서드 없음 -- 훅은 자동으로 감지돼요
  },
};
```

### QueryInfo 구조

```typescript
interface QueryInfo {
  sql: string;         // SQL 쿼리 텍스트
  params?: any[];      // 파라미터화된 값
  operation?: string;  // "select" | "insert" | "update" | "delete" | "raw"
}
```

`beforeQuery`에서 수정된 `QueryInfo`를 반환하면 쿼리를 변환할 수 있어요. `afterQuery`는 결과와 실행 시간(ms)을 받아서 슬로우 쿼리 경고나 메트릭 수집에 활용할 수 있어요.

### 트랜잭션 훅 -- beforeTransaction / afterTransaction

per-query 훅 외에도 플러그인은 트랜잭션 경계를 관찰할 수 있어요. 이 훅들은 `executeInTransaction()` / `@Transactional` 스코프당 한 번씩 발생해요 — 내부 statement마다가 **아니에요**.

```typescript
const txAudit: StingerloomPlugin = {
  name: "tx-audit",
  beforeTransaction(isolationLevel) {
    console.log(`[TX] BEGIN (isolation=${isolationLevel ?? "default"})`);
  },
  afterTransaction(committed) {
    console.log(`[TX] ${committed ? "COMMIT" : "ROLLBACK"}`);
  },
  install() { /* 추가 API 없음 */ },
};
```

| 훅 | 시그니처 | 발생 시점 |
|---|---|---|
| `beforeTransaction` | `(isolationLevel?: string) => void` | `BEGIN`/`START TRANSACTION` 직전. `isolationLevel`은 트랜잭션 옵션에 전달된 문자열(`"READ COMMITTED"` 등) 또는 DB 기본값인 경우 `undefined`. |
| `afterTransaction` | `(committed: boolean) => void` | `COMMIT`(true) 또는 `ROLLBACK`(false) 반환 후. |

### 훅 에러 처리

- `beforeQuery`는 쿼리 경로에서 **동기적으로 await** 돼요. throw하면 쿼리가 중단되고 에러가 호출자로 전파돼요.
- `afterQuery`, `beforeTransaction`, `afterTransaction`은 **관찰 전용** 이에요. 여기서 발생한 예외는 내부적으로 catch되어 `Logger.warn()`으로 로깅돼요. 오작동하는 감사 플러그인이 트랜잭션을 죽일 수 없어요.
- `shutdown()`은 `propagateShutdown()` 중 **역순 설치 순서** 로 실행돼요. 여기서 발생한 에러는 캡처되어 리포트되지만 다른 플러그인의 정리를 막지는 않아요.

각 훅은 idempotent하게, side-effect에 관대하게 설계하세요 — 재시도 쿼리(데드락 재시도)나 ORM 내부 쿼리(스키마 introspection, 테넌트 프로비저닝)에서도 발생할 수 있어요.

---

## Built-in Plugins

Stingerloom에는 두 개의 기본 제공 플러그인이 있습니다:

| Plugin | Import | 설명 |
|--------|--------|------|
| **Buffer (UoW)** | `bufferPlugin()` | Unit of Work -- 엔티티 변경사항을 메모리에 추적하고 단일 원자적 트랜잭션으로 flush합니다. Identity Map, dirty checking, cascade, pessimistic locking 등을 지원합니다. |
| **Raw Pipeline** | `rawPipelinePlugin()` | 대규모 데이터 처리 시 Entity 변환을 우회합니다. 데이터베이스 드라이버에서 raw 행이나 바이너리 버퍼를 배치 페이지네이션과 변환 체이닝으로 직접 스트리밍합니다. 100K 행 기준 `em.find()`보다 4.4배 빠릅니다. |

자세한 내용은 전용 가이드를 참고하세요:
- **[WriteBuffer (Unit of Work)](./write-buffer.md)**
- **[Raw Pipeline](./raw-pipeline.md)**

## Next Steps

- [WriteBuffer (Unit of Work)](./write-buffer.md) -- 기본 제공 UoW 플러그인
- [Raw Pipeline](./raw-pipeline.md) -- Entity 오버헤드 없는 대용량 데이터 스트리밍
- [EntityManager](./entity-manager.md) -- CRUD, pagination, events
- [Transactions](./transactions.md) -- 수동 및 데코레이터 기반 트랜잭션
- [API Reference](./api-reference.md) -- 전체 메서드 시그니처
