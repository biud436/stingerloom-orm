# Plugins

## 플러그인이 필요한 이유

ORM은 CRUD, 스키마 동기화, 이벤트 시스템, Unit of Work, 감사 로깅, 소프트 삭제 등 많은 관심사를 다룹니다. 이 기능을 전부 코어에 넣으면 쓰지 않는 기능 때문에 번들 크기와 메모리 사용량이 커집니다. 버그가 생길 수 있는 범위도 넓어집니다.

플러그인이 이 문제를 해결합니다. 코어는 작게 유지해서 모든 애플리케이션에 필요한 기능에만 집중합니다. 선택 기능은 별도 모듈로 분리해서 필요할 때만 설치합니다.

플러그인은 브라우저 확장 프로그램과 비슷합니다. 브라우저는 페이지 렌더링, 탭 관리, 북마크 같은 필수 기능만 제공합니다. 광고 차단이나 비밀번호 관리는 확장 프로그램으로 설치합니다. 필요한 것만 설치하고 하나를 제거해도 나머지는 영향을 받지 않습니다.

## 플러그인 동작 방식 -- Lifecycle

플러그인은 다음과 같은 생명주기를 거칩니다.

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

### Step 1: Install

`em.extend()`에 플러그인 객체를 전달합니다. Stingerloom은 같은 이름의 플러그인이 이미 설치되어 있는지 확인합니다. 이미 있으면 아무 동작도 하지 않습니다. `extend()`는 멱등(idempotent)하게 설계되었습니다. 그래서 여러 번 호출해도 부수 효과 없이 안전합니다.

```typescript
import { EntityManager } from "@stingerloom/orm";

const em = new EntityManager();
em.extend(myPlugin());
```

`register()`의 `plugins` 배열로도 플러그인을 전달할 수 있습니다. 이 플러그인은 데이터베이스에 연결된 뒤 자동으로 설치됩니다.

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

`install()`은 호출될 때 `PluginContext` 객체를 받습니다. 이 객체는 EntityManager 내부를 그대로 노출하지 않습니다. 플러그인이 쓰도록 골라 둔 기능만 제공하는 API입니다. 그래서 EntityManager 내부가 바뀌어도 플러그인은 안정적으로 동작합니다.

### Step 3: Add Methods

`install()` 함수는 객체를 반환할 수 있습니다. 반환한 객체의 모든 메서드는 EntityManager 인스턴스에 믹스인됩니다. 설치한 뒤에는 이 메서드를 내장 메서드처럼 `em`에서 바로 호출합니다.

### Step 4: Active Operation

이제 플러그인은 EntityManager의 일부입니다. 이벤트 리스너가 동작하고 메서드를 호출할 수 있습니다. 모든 기능이 내장 기능처럼 동작합니다.

### Step 5: Shutdown

NestJS 앱이 종료될 때처럼 `em.propagateShutdown()`이 호출되면 플러그인의 `shutdown()`이 설치의 역순으로 호출됩니다. 마지막에 설치된 플러그인이 가장 먼저 종료됩니다. interval 정리, 소켓 닫기, 버퍼 flush 같은 작업은 여기서 처리합니다.

---

## 커스텀 플러그인 작성하기

플러그인은 `StingerloomPlugin` 인터페이스를 구현한 객체입니다. 이 객체는 `name`, `install()` 함수, 선택 항목인 `shutdown()` 함수로 이루어집니다.

### 전체 예제: Timestamp Logger

이 플러그인은 엔티티가 삽입되거나 삭제될 때마다 타임스탬프가 붙은 로그를 기록합니다.

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

1. `em.extend(timestampLogger)`를 호출합니다.
2. Stingerloom은 `"timestamp-logger"`라는 이름의 플러그인이 이미 있는지 확인합니다. 없으므로 다음 단계로 진행합니다.
3. Stingerloom은 PluginContext를 넘기며 `timestampLogger.install(ctx)`를 호출합니다.
4. 플러그인은 `install()` 안에서 클로저 스코프에 빈 `log` 배열을 만듭니다. 이 배열은 플러그인 전용입니다. 그래서 외부에서는 직접 접근하지 못합니다.
5. 플러그인은 `ctx.events`에서 `"afterInsert"`와 `"afterDelete"` 이벤트를 구독합니다. EntityManager가 엔티티를 삽입하거나 삭제할 때마다 이 콜백이 실행되고 `log` 배열에 문자열을 추가합니다.
6. `install()`은 `{ getLog: () => [...log] }`를 반환합니다. spread 연산자 `[...log]`가 복사본을 만들기 때문에 호출하는 쪽에서는 내부 배열을 변경하지 못합니다.
7. Stingerloom은 반환값을 `em`에 믹스인합니다. 이제 `em.getLog()`를 호출할 수 있습니다. 반환 타입도 `string[]`로 추론됩니다.
8. 나중에 `em.save(User, { name: "Alice" })`를 호출하면 EntityManager에서 `"afterInsert"` 이벤트가 발생합니다. 그러면 플러그인 콜백이 실행되어 `"[2026-03-22T10:00:00.000Z] INSERT User"`를 로그에 추가합니다.
9. `em.getLog()`는 `["[2026-03-22T10:00:00.000Z] INSERT User"]`를 반환합니다.
10. 앱이 종료되면서 `em.propagateShutdown()`이 호출되면 `timestampLogger.shutdown()`이 실행됩니다.

---

## PluginContext Reference

`install()` 함수가 받는 `PluginContext`는 EntityManager 내부 기능 중 허용된 부분만 노출합니다.

| Property / Method | 설명 | 사용 시점 |
|-------------------|------|-----------------|
| `ctx.em` | EntityManager 인스턴스 | `find()`, `save()`, `delete()` 등 EntityManager 메서드를 호출할 때. 훅과 이벤트가 정상적으로 발생하려면 raw SQL 대신 항상 `ctx.em`을 사용해야 합니다. |
| `ctx.driver` | 현재 SQL driver (`register()` 전에는 `undefined`) | raw SQL을 실행하거나 데이터베이스별 기능을 확인할 때. `register()` 호출 전에 설치하면 `undefined`입니다. |
| `ctx.events` | Entity event emitter (`on`, `off`, `emit`) | 엔티티 생명주기 이벤트에 반응할 때: `beforeInsert`, `afterInsert`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, `afterDelete`. 가장 흔한 플러그인 패턴입니다. |
| `ctx.connectionName` | 연결 이름 (기본값: `"default"`) | 멀티 데이터베이스 환경에서 연결마다 다르게 동작해야 할 때. 예: 감사 플러그인이 `"primary"` 연결에서만 로그를 남기는 경우. |
| `ctx.addSubscriber(sub)` | EntitySubscriber 등록 | 클래스 기반 EntitySubscriber를 제공할 때. EntitySubscriber는 `listenTo()`로 필터링할 수 있는 이벤트 콜백 대안입니다. |
| `ctx.removeSubscriber(sub)` | EntitySubscriber 제거 | 런타임에 동적으로 구독을 해제해야 할 때. |
| `ctx.getEntities()` | 등록된 모든 엔티티 클래스 | 스키마를 분석해야 할 때. 예: 문서 생성, 엔티티 정의 검증. |
| `ctx.getPlugin(name)` | 다른 플러그인의 API 접근 | 다른 플러그인에 의존해서 그 메서드를 호출해야 할 때. 아래 "Plugin Dependencies" 참고. |
| `ctx.isMySqlFamily()` | MySQL/MariaDB 드라이버인지 확인 | SQL을 생성하면서 백틱과 큰따옴표 인용을 구분해야 할 때. |
| `ctx.isPostgres()` | PostgreSQL 드라이버인지 확인 | 스키마, JSONB 연산자, RETURNING 절 같은 PostgreSQL 전용 기능을 사용할 때. |
| `ctx.isSqlite()` | SQLite 드라이버인지 확인 | ALTER COLUMN, EXPLAIN처럼 SQLite가 지원하지 않는 기능을 건너뛸 때. |
| `ctx.wrap(identifier)` | 드라이버의 인용 방식으로 식별자 감싸기 | SQL 문자열을 만들면서 컬럼 이름이나 테이블 이름을 안전하게 인용해야 할 때. MySQL은 백틱을 쓰고 PostgreSQL과 SQLite는 큰따옴표를 씁니다. |
| `ctx.wrapTable(tableName)` | 테이블 이름 인용 (스키마 접두사 포함) | `wrap()`과 같지만 스키마 한정 이름도 처리합니다. 예: PostgreSQL의 `"public"."user"`. |
| `ctx.tenantPredicate(entity, alias?)` | 엔티티에 `find()`가 붙이는 테넌트 조건, 또는 `null` | `tenantStrategy: "tenant_column"`에서 플러그인이 애플리케이션 엔티티를 대상으로 SELECT·UPDATE·DELETE를 직접 만들 때. 이 조건을 WHERE 절에 AND로 붙이면 SQL 문이 현재 테넌트의 행만 건드립니다. 다른 전략, `@NonTenantEntity()`, `runUnscoped()`, `"public"` 컨텍스트처럼 `find()`가 조건을 붙이지 않는 경우에는 `null`입니다. 테넌트 컨텍스트가 없으면 `tenantOnMissingContext`를 먼저 적용하므로 에러를 던질 수 있습니다. |
| `ctx.executeInTransaction(fn)` | 트랜잭션 안에서 콜백 실행 | 여러 SQL 문을 원자적으로 실행해야 할 때. 성공하면 커밋하고 에러가 나면 롤백합니다. |
| `ctx.executeReadOnly(fn)` | 읽기 전용 트랜잭션에서 콜백 실행 | 데이터를 읽기만 하고 이 사실을 데이터베이스에 알려 최적화하고 싶을 때. 읽기 레플리카 환경에서는 레플리카를 사용합니다. |
| `ctx.getEntityMetadata(cls)` | 엔티티 클래스의 구조적 메타데이터 | 애플리케이션 엔티티의 컬럼, 관계, 기본 키, 인덱스, 테이블 이름을 검사해야 할 때. 예: 엔티티별 감사 테이블을 만들거나 스키마 문서를 생성할 때. 등록되지 않은 클래스에는 `null`을 반환합니다. |
| `ctx.registerPlaceholder(name)` | 플러그인이 추가할 메서드 이름 사전 선언 | 메서드가 실제로 설치되기 *전*에 해석할 수 있어야 할 때. 예: 순환 의존, 타입 있는 플레이스홀더 API. 이름을 예약하면 다른 플러그인이 그 이름을 덮어쓰지 못합니다. |

---

## Plugin Dependencies

플러그인은 다른 플러그인이 먼저 설치되어 있어야 한다고 선언할 수 있습니다. 의존하는 플러그인이 없으면 `extend()`는 명확한 에러 메시지와 함께 즉시 에러를 던집니다.

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

이 기능은 서로 의존하는 플러그인 묶음을 만들 때 유용합니다. 예를 들어 "soft-delete-audit" 플러그인이 "soft-delete" 플러그인과 "audit" 플러그인에 모두 의존하는 경우입니다.

---

## Method Name Conflicts

플러그인이 `find`, `save`처럼 EntityManager에 이미 있는 메서드를 추가하려 하면 `extend()`는 `PLUGIN_CONFLICT` 에러를 던집니다. 코어 메서드를 덮어쓰면 ORM이 예측할 수 없는 방식으로 깨집니다. 이 에러는 그런 일을 막는 안전장치입니다.

플러그인 API 메서드에는 고유하고 뜻이 분명한 이름을 붙이세요. 플러그인 이름을 접두사로 붙이는 것이 좋은 관례입니다. 예를 들어 `getLog()` 대신 `auditGetLog()`로 짓습니다.

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
| `extend` | `<TApi>(plugin): this & TApi` | 플러그인을 설치하고 API를 EntityManager에 믹스인 |
| `hasPlugin` | `(name: string): boolean` | 이름으로 플러그인 설치 여부 확인 |
| `getPluginApi` | `<T>(name: string): T \| undefined` | 이름으로 플러그인의 API 객체 조회 |

---

## 쿼리 훅 -- beforeQuery / afterQuery

플러그인은 EntityManager가 실행하는 모든 SQL 쿼리를 가로챌 수 있습니다. 이 기능은 쿼리 로깅, 성능 모니터링, 쿼리 변환 같은 횡단 관심사를 구현할 때 유용합니다.

### beforeQuery

모든 SQL 쿼리를 실행하기 전에 호출됩니다. 이 훅에서 쿼리를 검사하거나 변환할 수 있습니다.

```typescript
const queryLogger: StingerloomPlugin = {
  name: "query-logger",

  beforeQuery(query) {
    console.log(`[SQL] ${query.operation}: ${query.sql}`);
    // 수정한 QueryInfo를 반환하면 쿼리를 변환할 수 있습니다
  },

  afterQuery(query, result, durationMs) {
    if (durationMs > 1000) {
      console.warn(`[SLOW] ${query.sql} took ${durationMs}ms`);
    }
  },

  install(ctx) {
    // 믹스인할 메서드는 없고 훅은 자동으로 감지됩니다
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

`beforeQuery`에서 수정한 `QueryInfo`를 반환하면 쿼리를 변환할 수 있습니다. `afterQuery`는 결과와 실행 시간(ms)을 받습니다. 그래서 슬로우 쿼리 경고나 메트릭 수집에 쓸 수 있습니다.

### 트랜잭션 훅 -- beforeTransaction / afterTransaction

플러그인은 쿼리마다 호출되는 훅 외에 트랜잭션 경계도 관찰할 수 있습니다. 트랜잭션 훅은 EntityManager가 여는 트랜잭션마다 한 번씩 발생합니다. `em.transaction()`, `ctx.executeInTransaction()`, 쓰기마다 감싸는 암묵적 트랜잭션이 여기에 해당합니다. 트랜잭션 안의 SQL 문마다 발생하지는 않습니다. `@Transactional` 메서드가 여는 트랜잭션은 여기에 포함되지 않습니다. 데코레이터에는 EntityManager가 없으므로 플러그인에 알림이 가지 않습니다.

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
| `beforeTransaction` | `(isolationLevel?: string) => void` | `BEGIN`/`START TRANSACTION` 직전. `isolationLevel`은 트랜잭션 옵션에 전달한 격리 수준(`"READ COMMITTED"` 등)입니다. 지정하지 않았다면 `undefined`입니다. |
| `afterTransaction` | `(committed: boolean) => void` | `COMMIT`(true) 또는 `ROLLBACK`(false)이 반환된 뒤. |

### 훅 에러 처리

- `beforeQuery`는 쿼리 경로에서 동기적으로 await됩니다. `beforeQuery`가 에러를 던지면 쿼리가 중단되고 에러는 호출한 쪽으로 전파됩니다.
- `afterQuery`, `beforeTransaction`, `afterTransaction`은 관찰 전용입니다. 여기서 던진 에러는 내부에서 catch되어 `Logger.warn()`으로 로깅됩니다. 그래서 오작동하는 감사 플러그인이 트랜잭션을 중단시키지 못합니다.
- `shutdown()`은 `propagateShutdown()` 중에 설치의 역순으로 실행됩니다. 여기서 발생한 에러는 수집되어 보고됩니다. 하지만 다른 플러그인의 정리 작업을 막지는 않습니다.

각 훅은 멱등하게 설계하고 부수 효과가 생겨도 문제없게 만드세요. 훅은 데드락 재시도로 다시 실행되는 쿼리에서도 발생할 수 있습니다. 스키마 인트로스펙션이나 테넌트 프로비저닝처럼 ORM이 내부에서 실행하는 쿼리에서도 발생할 수 있습니다.

---

## Built-in Plugins

Stingerloom에는 기본 제공 플러그인이 두 개 있습니다.

| Plugin | Import | 설명 |
|--------|--------|------|
| **Buffer (UoW)** | `bufferPlugin()` | Unit of Work: 엔티티 변경 사항을 메모리에서 추적하고 원자적 트랜잭션 하나로 flush합니다. Identity Map, 변경 추적, cascade, 비관적 잠금 등을 지원합니다. |
| **Raw Pipeline** | `rawPipelinePlugin()` | 대규모 데이터를 처리할 때 엔티티 변환을 우회합니다. 데이터베이스 드라이버에서 raw 행이나 바이너리 버퍼를 직접 스트리밍합니다. 배치 페이지네이션과 변환 체이닝을 지원합니다. 100K 행 기준으로 `em.find()`보다 4.4배 빠릅니다. |

자세한 내용은 전용 가이드를 참고하세요.
- [WriteBuffer (Unit of Work)](./write-buffer.md)
- [Raw Pipeline](./raw-pipeline.md)

## Next Steps

- [WriteBuffer (Unit of Work)](./write-buffer.md): 기본 제공 UoW 플러그인
- [Raw Pipeline](./raw-pipeline.md): 엔티티 오버헤드 없는 대용량 데이터 스트리밍
- [EntityManager](./entity-manager.md): CRUD, 페이지네이션, 이벤트
- [Transactions](./transactions.md): 수동 트랜잭션과 데코레이터 기반 트랜잭션
- [API Reference](./api-reference.md): 전체 메서드 시그니처
