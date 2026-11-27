# Express에서 사용하기

Stingerloom ORM은 특정 프레임워크에 종속되지 않습니다. NestJS 통합에서 쓰는 `EntityManager`도 어디서나 쓰는 평범한 클래스입니다. NestJS 모듈은 그 위에 의존성 주입을 얹은 얇은 래퍼일 뿐입니다. 그 래퍼가 대신해 주던 일은 순수 [Express](https://expressjs.com/) 앱에서 아래 패턴으로 처리합니다. 같은 패턴은 Fastify, Koa, Hono 같은 다른 Node.js 서버에도 그대로 적용됩니다.

모듈 시스템은 CommonJS(`require`)와 ESM(`"type": "module"` + `import`) 어느 쪽이든 같은 코드로 동작합니다.

앞에서부터 필요한 만큼만 읽으면 됩니다.

- **[일단 돌아가게 만들기](#setup)**: 설치, 엔티티 스타일, 부트스트랩, CRUD 라우트, 리포지토리
- **[제대로 동작하게 만들기](#error-handling)**: 에러 처리, 종료, 헬스 체크
- **[조회하기](#reading-data)**: 필터, 페이지네이션, 쿼리 빌더, raw SQL, 스트리밍
- **[쓰기와 트랜잭션](#transactions)**: 트랜잭션, 잠금, 배치 쓰기, 소프트 삭제
- **[운영 환경에서 챙길 것](#connection-pooling)**: 풀링, 로깅, 레플리카, 다중 데이터베이스, 마이그레이션
- **[고급 패턴](#multi-tenancy-middleware)**: 멀티테넌시, 구독자, 쓰기 버퍼, 플러그인, 테스트

## 설치 {#setup}

```bash
npm install @stingerloom/orm reflect-metadata express
npm install better-sqlite3   # 또는 pg / mysql2
```

TypeScript 설정은 [시작하기](./getting-started.md)의 「2단계: TypeScript 설정」에 있습니다. `experimentalDecorators`, `emitDecoratorMetadata`, `strict`가 여기에 해당합니다. 데코레이터 관련 두 옵션이 필요한지는 다음 절에서 고르는 엔티티 스타일에 따라 달라집니다.

## 빌드 도구에 맞는 엔티티 스타일 고르기

NestJS 밖에서 가장 자주 부딪히는 문제입니다.

데코레이터 스타일(`@Entity`, `@Column`)은 TypeScript의 `design:type` 메타데이터로 컬럼 타입을 추론합니다. 그런데 이 메타데이터는 `emitDecoratorMetadata` 옵션으로 컴파일할 때만 생성됩니다. `tsc`나 `ts-node`를 쓸 때가 그렇습니다. 반면 Express 프로젝트에서 개발용으로 흔히 쓰는 tsx, esbuild, swc, Vite는 데코레이터 메타데이터를 생성하지 않습니다. 이런 도구로 실행하면 타입을 명시하지 않은 `@Column()`은 속성 타입을 알아내지 못합니다. 그래서 `"text"` 컬럼이 되고 아래와 같은 경고를 출력합니다.

```
WARN [Column] No design:type metadata for User.name — falling back to "text". ...
```

해결 방법은 세 가지입니다.

1. **코드 우선 빌더를 씁니다(권장).** `defineEntity`는 컬럼 타입을 정의 안에 직접 담습니다. 그래서 데코레이터 메타데이터, `experimentalDecorators` 설정, 특정 컴파일러가 모두 필요 없습니다.

   ```typescript
   // entities/user.ts
   import { defineEntity, t, InferEntity } from "@stingerloom/orm";

   export const User = defineEntity("users", {
     id:      t.int().primary().generated(),
     email:   t.varchar(255).unique(),
     name:    t.varchar(255),
     balance: t.int().default(0),
   });
   export type User = InferEntity<typeof User>;
   ```

2. **데코레이터를 유지하되 모든 컬럼에 타입을 명시합니다.** `@Column({ type: "int" })`처럼 타입을 적으면 추론할 것이 없습니다. 그래서 어떤 빌드 도구에서도 결과가 같습니다.

3. **데코레이터를 유지하고 `tsc` / `ts-node`로 빌드·실행합니다.** 추론에 필요한 메타데이터가 온전히 생성됩니다.

자세한 내용은 [엔티티 정의하기](./define-entity.md)와 [트러블슈팅](./troubleshooting.md)에 있습니다. 아래 예제는 코드 우선 스타일로 작성했습니다. 하지만 모든 패턴은 데코레이터 엔티티에서도 똑같이 동작합니다.

---

## 부트스트랩

`EntityManager`는 프로세스 전체에서 하나만 만드세요. 그리고 서버가 요청을 받기 시작하기 전에 등록을 마치고 모든 모듈이 그 인스턴스를 공유하게 하세요.

```typescript
// db.ts
import "reflect-metadata"; // 프로세스에서 가장 먼저 import
import { EntityManager } from "@stingerloom/orm";
import { User } from "./entities/user";
import { Post } from "./entities/post";

export const em = new EntityManager();

export async function initDb(): Promise<void> {
  await em.register({
    type: "sqlite",
    database: "app.db",
    entities: [User, Post],
    synchronize: true, // 개발 전용: 프로덕션에서는 마이그레이션을 쓰세요
  });
}
```

```typescript
// main.ts
import express from "express";
import { em, initDb } from "./db";
import { User } from "./entities/user";

async function main() {
  await initDb(); // 초기화 전에 들어온 요청은 DatabaseNotConnectedError로 실패합니다

  const app = express();
  app.use(express.json());

  app.post("/users", async (req, res) => {
    res.json(await em.save(User, req.body));
  });

  app.get("/users/:id", async (req, res) => {
    const user = await em.findOne(User, { where: { id: Number(req.params.id) } });
    if (!user) return res.status(404).json({ error: "not found" });
    res.json(user);
  });

  app.listen(3000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

#### register()가 내부에서 하는 일

순서가 중요합니다. 어느 단계에서 실패하든 서버가 listen을 시작하기 전에 프로세스를 멈춰야 하기 때문입니다.

1. **옵션을 검증합니다.** 문제가 있으면 발견한 항목을 전부 나열한 `INVALID_CONFIG` 코드의 `OrmError`를 던집니다. 숫자가 아닌 포트, 빠진 비밀번호, `pool.max`보다 큰 `pool.min` 같은 문제가 여기서 걸립니다.
2. **연결을 엽니다.** `retry`를 설정했다면 재시도까지 여기서 처리합니다.
3. **네이밍 전략을 엔티티 메타데이터에 적용합니다.**
4. **엔티티를 등록하고 스키마 동기화를 실행합니다.** `synchronize`는 이 단계에서 DDL을 실행합니다.
5. **플러그인을 설치합니다.** `options.plugins`에 넣은 순서대로 설치합니다.

4단계에서는 DDL을 실행하기도 합니다. 그래서 `register()`는 부팅 과정에서 가장 비싼 호출입니다. 그리고 실패하면 확실히 드러나야 하는 호출이기도 합니다. 위 예제처럼 `main().catch()` 안에 두세요. await 없이 호출만 하고 넘어가면 안 됩니다.

::: warning 데이터베이스 하나에 EntityManager도 하나
연결 이름 없이 `register()`를 호출하면 프로세스 전역 레지스트리에 `"default"`라는 이름으로 연결이 등록됩니다. 이 상태에서 다른 `EntityManager`가 같은 이름으로 또 등록하면 기존 연결이 새 연결로 교체됩니다. 그러면 첫 번째 매니저는 에러 없이 두 번째 데이터베이스로 쿼리를 보냅니다. 이런 상황을 감지하면 ORM이 경고를 남깁니다.

```
WARN [DatabaseClient] Connection 'default' is already registered and will be replaced. ...
```

`EntityManager` 인스턴스는 하나만 만들어서 모듈 사이에 공유하세요. 한 프로세스에서 여러 데이터베이스를 써야 한다면 데이터베이스마다 다른 이름을 붙이면 됩니다. 방법은 [다중 데이터베이스](#multiple-databases)에 있습니다.
:::

## 프로젝트 구조

ORM은 특정 디렉터리 구조를 강제하지 않습니다. 다만 프로젝트가 커져도 버티는 구조는 세 곳을 분리합니다. 연결을 두는 곳, 비즈니스 규칙을 두는 곳, HTTP를 다루는 곳입니다.

```
src/
  db.ts             # EntityManager 인스턴스 + initDb()
  config.ts         # 환경 변수 -> DatabaseClientOptions
  entities/         # 엔티티 정의
  services/         # 비즈니스 로직. em을 import하고 HTTP는 다루지 않습니다
  routes/           # Express 라우터. 입력 검증, 서비스 호출, 응답 형태 결정
  main.ts           # 전체를 조립하고 listen
```

지킬 만한 규칙은 하나입니다. 서비스는 `db.ts`에서 `em`을 직접 import하고 라우트는 `em`을 건드리지 않습니다. 이렇게만 해도 NestJS의 생성자 주입이 주던 테스트 용이성을 그대로 얻습니다. HTTP 요청을 만들지 않고도 스크립트, 큐 워커, 테스트에서 서비스를 바로 호출하기 때문입니다. 그러면서도 DI 컨테이너를 도입하는 수고는 들지 않습니다.

```typescript
// services/user-service.ts
import { em } from "../db";
import { User } from "../entities/user";

export async function registerUser(input: { email: string; name: string }) {
  return em.save(User, input);
}
```

```typescript
// routes/users.ts
import { Router } from "express";
import { registerUser } from "../services/user-service";

export const usersRouter = Router();

usersRouter.post("/", async (req, res) => {
  const user = await registerUser({ email: req.body.email, name: req.body.name });
  res.status(201).json(user);
});
```

## 환경 변수로 설정 구성하기

ORM은 `process.env`를 읽지 않고 `DATABASE_URL` 파싱도 제공하지 않습니다. 옵션 객체는 직접 만들어야 합니다. 대신 `validateDatabaseClientOptions()`를 제공합니다. 이 함수를 쓰면 부팅할 때 읽기 쉬운 메시지로 바로 실패합니다. 그래서 `NaN` 포트가 몇 분 뒤에 소켓 에러로 드러나는 일이 없습니다.

```typescript
// config.ts
import { validateDatabaseClientOptions, type DatabaseClientOptions } from "@stingerloom/orm";
import { User } from "./entities/user";
import { Post } from "./entities/post";

export function loadDbOptions(): DatabaseClientOptions {
  const options: DatabaseClientOptions = {
    type: "postgres",
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USER ?? "postgres",
    password: process.env.DB_PASSWORD ?? "",
    database: process.env.DB_NAME ?? "app",
    entities: [User, Post],
    synchronize: process.env.NODE_ENV !== "production",
    logging: { slowQueryMs: 200, nPlusOne: true },
    pool: { max: 10 },
  };

  validateDatabaseClientOptions(options); // 문제를 전부 모아 OrmError(INVALID_CONFIG)로 던집니다
  return options;
}
```

`entities`에는 클래스 대신 glob 문자열을 넣어도 됩니다(`entities: ["./dist/entities/*.js"]`). 이때는 선택적 peer 의존성인 `fast-glob`이 필요합니다. Express 앱에서는 대체로 명시적 import가 낫습니다. 명시적 import는 컴파일러가 검사하고 번들러를 거쳐도 그대로 남습니다. 반면 glob은 출력 디렉터리가 바뀌면 경고 없이 0개로 해석됩니다.

::: warning 프로덕션에서의 synchronize
`NODE_ENV=production` 환경에서 `synchronize: true`를 쓰면 데이터 유실 경고가 로그에 남습니다. 하지만 DDL 실행은 막지 않습니다. 위 예제처럼 환경에 따라 끄세요. 그리고 첫 배포 전에 [마이그레이션](#migrations)으로 넘어가세요. 배경 설명은 [운영 가이드](./production-guide.md)의 「synchronize: true가 프로덕션에서 위험한 이유」에 있습니다.
:::

## 리포지토리

NestJS에서 쓰던 `@InjectRepository(User)`는 의존성 주입을 위한 편의 문법일 뿐입니다. 리포지토리를 직접 얻으려면 다음과 같이 씁니다.

```typescript
const userRepository = em.getRepository(User);

const users = await userRepository.find({ where: { name: "alice" } });
```

리포지토리는 엔티티 하나에 묶인 `EntityManager`의 얇은 뷰입니다. 엔티티 인자만 빠졌을 뿐 읽기·쓰기 API가 그대로 노출됩니다(`find`, `findOne`, `findOneOrFail`, `findWithPage`, `save`, `softDelete`, `createQueryBuilder` 등). 만드는 비용이 거의 없습니다. 그래서 필요한 곳에서 그때그때 꺼내 써도 됩니다. `db.ts`에서 `em`과 함께 export해 두어도 됩니다.

```typescript
// db.ts
export const users = () => em.getRepository(User);
```

함수로 감싼 이유가 있습니다. 모듈 최상단에서 `em.getRepository(User)`를 호출하면 `initDb()`보다 먼저 실행됩니다. 리포지토리 객체 자체는 문제가 없습니다. 하지만 파일이 커질수록 실행 순서를 착각하기 쉽습니다.

---

## 에러 처리 {#error-handling}

ORM이 던지는 에러는 모두 `OrmError`를 상속합니다. `OrmError`에는 다음 필드가 있습니다.

```typescript
class OrmError extends Error {
  readonly code: OrmErrorCode;        // 안정적인 문자열 코드. 예: "ORM_ENTITY_NOT_FOUND"
  readonly suggestion: string | null; // 개발자를 위한 해결 힌트
}
```

에러는 클래스로 잡아도 되고 `err.code`로 분기해도 됩니다. 둘 다 안정적입니다. 다만 `suggestion`은 절대 클라이언트에 보내지 마세요. `suggestion`은 코드를 작성한 사람을 위한 안내입니다. "`@PrimaryGeneratedColumn()`을 추가하세요" 같은 내용이 들어 있습니다. API 호출자를 위한 메시지가 아니므로 로그로만 남기세요.

Express 5는 async 핸들러에서 발생한 rejection을 에러 미들웨어까지 자동으로 전달합니다. 하지만 Express 4에서는 `express-async-errors` 같은 래퍼가 필요합니다.

```typescript
// middleware/error-handler.ts
import {
  OrmError,
  OrmErrorCode,
  EntityNotFoundError,
  OptimisticLockError,
  ValidationError,
  UniqueConstraintViolationError,
  ForeignKeyViolationError,
} from "@stingerloom/orm";
import type { NextFunction, Request, Response } from "express";

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof EntityNotFoundError) {
    return res.status(404).json({ error: "not found" });
  }
  if (err instanceof ValidationError) {
    // ValidationError는 field / constraint / actual / expected를 담고 있습니다
    return res.status(400).json({ error: err.message, field: err.field });
  }
  if (err instanceof OptimisticLockError) {
    return res.status(409).json({ error: "the record changed, please retry" });
  }
  if (err instanceof UniqueConstraintViolationError) {
    // 어느 키인지는 DB가 보고한 만큼 err.constraint / err.table / err.columns에 담깁니다
    return res.status(409).json({ error: "already exists" });
  }
  if (err instanceof ForeignKeyViolationError) {
    return res.status(409).json({ error: "referenced record is missing or still in use" });
  }
  if (
    err instanceof OrmError &&
    (err.code === OrmErrorCode.NOT_CONNECTED || err.code === OrmErrorCode.CONNECTION_FAILED)
  ) {
    // 아직 register() 전이거나 서버가 내려갔거나 풀이 고갈되어 연결을 얻지 못한 경우
    return res.status(503).json({ error: "database unavailable" });
  }
  if (err instanceof OrmError) {
    // 설정/코드 실수 계열: InvalidQueryError, EntityMetadataNotFoundError 등
    console.error(`[orm] ${err.code}: ${err.message}`, err.suggestion ?? "");
    return res.status(500).json({ error: "internal error" });
  }

  console.error(err);
  return res.status(500).json({ error: "internal error" });
}
```

라우터를 전부 등록한 뒤 마지막에 `app.use(errorHandler)`로 붙이면 됩니다.

중복 키와 외래 키 위반도 데이터베이스와 상관없이 `OrmError`로 전달됩니다. 각각 `UniqueConstraintViolationError`(코드 `ORM_UNIQUE_VIOLATION`)와 `ForeignKeyViolationError`(`ORM_FK_VIOLATION`)입니다. 드라이버 에러는 `cause`에 담깁니다. 데이터베이스마다 제약 조건 정보를 얼마나 보고하는지는 [제약 조건 위반](./api-reference.md#제약-조건-위반)에 있습니다. 이전 버전에서는 `mysql2`, `pg`, `better-sqlite3`의 원본 에러가 그대로 전달됐습니다. 그래서 핸들러가 `23505`, errno `1062`, `SQLITE_CONSTRAINT_UNIQUE` 같은 드라이버 코드를 직접 확인해야 했습니다. 그런 코드는 이제 `err.cause`에서 같은 값을 찾으면 됩니다.

SQL 문이 데이터베이스에서 받는 그 밖의 에러는 지금도 드라이버가 던진 그대로 전달됩니다. NOT NULL이나 CHECK 위반, 문법 에러가 그 예입니다. `timeout`이나 `queryTimeout` 때문에 PostgreSQL이나 MySQL/MariaDB가 읽기를 취소하면 `QueryTimeoutError`를 던집니다. 읽기는 `find()`를 비롯한 읽기 메서드를 말합니다. 이 에러의 `cause`에는 드라이버 에러가 담깁니다. SQLite에는 SQL 문 타임아웃이 없습니다. 그래서 SQLite에서는 이 에러를 던지지 않습니다. export된 `TransactionError` 클래스는 deprecated입니다. 어디에서도 이 클래스를 던지지 않습니다.

연결을 얻지 못한 쿼리는 `DatabaseConnectionFailedError`(코드 `ORM_CONNECTION_FAILED`)를 던집니다. 이 에러의 `cause`에는 드라이버 에러가 담깁니다. 위 미들웨어에서는 503 분기가 이 에러를 처리합니다. 이전 버전에서는 이 에러가 `code` 없는 평범한 `Error`였습니다. `register()` 전에 들어온 쿼리도 `DatabaseNotConnectedError` 대신 이 에러에 감싸여 전달됐습니다. 마지막 `console.error(err)` 분기는 그 밖의 에러를 받습니다. 나머지 드라이버 에러와 애플리케이션 자체의 에러가 여기에 해당합니다.

이 미들웨어까지 오지 않는 데이터베이스 에러가 하나 있습니다. 풀에서 쉬고 있던 연결을 서버가 닫은 경우입니다. 이때는 그 에러를 기다리는 요청이 없습니다. 이 에러는 `register()`에 `onConnectionError`를 넘겨서 받습니다([시작 이후 끊긴 연결](./configuration.md#시작-이후-끊긴-연결)). 옵션이 없으면 경고 로그로 남습니다. 어느 쪽이든 풀이 연결을 교체합니다.

에러 미들웨어가 없으면 Express 기본 핸들러가 스택 트레이스를 그대로 담은 HTML 페이지를 반환합니다. 개발 중에는 편합니다. 하지만 운영 환경에 내보낼 응답은 아닙니다.

## 안전한 종료

NestJS에서는 `app.enableShutdownHooks()`만 켜면 ORM의 종료 훅까지 자동으로 호출됩니다. Express에서는 시그널 핸들러를 직접 등록해야 합니다.

```typescript
const server = app.listen(3000);

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);

  // 1. 새 연결을 받지 않고 처리 중인 요청이 끝나기를 기다립니다
  await new Promise<void>((resolve) => server.close(() => resolve()));

  // 2. 플러그인 종료 훅을 실행하고 연결 풀을 닫습니다
  await em.propagateShutdown({ closeConnections: true });

  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
```

#### propagateShutdown()이 내부에서 하는 일

다음 순서로 진행합니다.

1. 실행 중인 쿼리를 기다립니다(아래 주의 사항 참고).
2. 플러그인 종료 훅을 설치 역순으로 실행합니다.
3. 이벤트 리스너와 구독자를 정리합니다.
4. 쿼리 트래커를 해제합니다.
5. 레플리카 헬스 체크를 멈춥니다.
6. `closeConnections: true`를 넘겼을 때만 연결 풀을 닫습니다.

::: warning 기본값 두 개를 조심하세요
**`closeConnections`의 기본값은 `false`입니다.** 이 옵션 없이 호출하면 내부의 `mysql2`, `pg` 풀이 닫히지 않습니다. 그러면 열린 소켓이 이벤트 루프를 계속 붙잡습니다. 그래서 프로세스가 종료되지 않고 멈춰 있습니다. Express 시그널 핸들러에서는 거의 항상 `{ closeConnections: true }`가 필요합니다.

**`gracefulTimeoutMs`는 쿼리 추적이 켜져 있지 않으면 아무 효과가 없습니다.** 이 대기는 `QueryTracker`가 구현합니다. 그런데 트래커는 `logging`이 `nPlusOne`이나 `slowQueryMs`를 포함한 객체일 때만 생성됩니다. `logging: true`이거나 `logging`이 아예 없으면 `propagateShutdown({ gracefulTimeoutMs: 5000 })`은 즉시 반환합니다. 위 예제처럼 HTTP 서버를 먼저 닫는 편이 설정과 상관없이 확실합니다.
:::

반환값은 모든 작업이 깔끔하게 정리되면 `true`, 대기가 타임아웃되면 `false`입니다. 구분이 필요하면 로그로 남기세요.

## 헬스 체크와 준비 상태 확인

쿠버네티스식 프로브는 서로 다른 두 가지를 묻습니다. *프로세스가 살아 있는가*(liveness)와 *트래픽을 받을 수 있는가*(readiness)입니다. 데이터베이스를 건드려야 하는 쪽은 후자뿐입니다.

```typescript
import { DatabaseClient } from "@stingerloom/orm";

const client = DatabaseClient.getInstance();

// liveness: I/O 없음. 이벤트 루프가 돌고 있으면 살아 있는 것입니다
app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

// readiness: 데이터베이스에 왕복 한 번
app.get("/readyz", async (_req, res) => {
  try {
    if (!client.hasConnection("default")) {
      return res.status(503).json({ db: "not registered" });
    }
    await client.getConnection("default").runTestSql();
    res.json({ db: "up" });
  } catch {
    res.status(503).json({ db: "down" });
  }
});
```

`runTestSql()`은 풀의 자체 쿼리 경로로 `SELECT 1 + 1` 하나만 보냅니다. 트랜잭션도 없고 명시적인 연결 체크아웃도 없습니다. `hasConnection()` 가드는 꼭 필요합니다. 풀이 아예 없으면 `runTestSql()`이 그냥 성공으로 끝나기 때문입니다. 그래서 가드가 없으면 한 번도 연결한 적 없는 프로세스가 스스로를 정상이라고 보고합니다.

::: tip 프로브로 em.query("SELECT 1")을 쓰지 마세요
`em.query()`는 트랜잭션 경로를 전부 거칩니다. 연결 체크아웃, `BEGIN`, 실제 SQL 문, `COMMIT`, 반납까지 왕복이 네 번쯤 됩니다. 반면 `runTestSql()`은 한 번이면 끝납니다. 동작이 틀린 것은 아닙니다. 하지만 몇 초마다 실행하는 프로브로는 과합니다. 커넥터 인터페이스에서 `runTestSql()`의 반환 타입은 `void`로 선언돼 있습니다. 하지만 모든 드라이버가 async로 구현하므로 `await`하는 것이 맞습니다.
:::

---

## 데이터 조회 {#reading-data}

`find`와 `findOne`은 `FindOption` 객체를 받습니다. 거의 모든 라우트에서 쓰는 항목은 다음과 같습니다.

```typescript
const posts = await em.find(Post, {
  where: { published: true, authorId: 7 },
  select: ["id", "title", "createdAt"],
  relations: ["author"],
  orderBy: { createdAt: "DESC" },
  skip: 20,
  take: 10,
});
```

필터는 중첩 객체로 씁니다. `Like()`나 `In()` 같은 헬퍼 함수를 import하지 않습니다.

```typescript
await em.find(Post, {
  where: {
    title:     { contains: "orm" },      // % 와 _ 를 이스케이프한 LIKE %orm%
    views:     { gte: 100, lt: 10_000 },
    status:    { in: ["published", "featured"] },
    deletedAt: { isNull: true },
  },
});

// 그룹 단위 OR
await em.find(Post, {
  where: [{ status: "featured" }, { views: { gte: 10_000 } }],
});

// 명시적으로 쓰면 이렇게도 됩니다
await em.find(Post, {
  where: { OR: [{ status: "featured" }, { views: { gte: 10_000 } }] },
});
```

모든 필드에서 `eq` / `ne` / `in` / `notIn` / `not` / `isNull` 연산자를 씁니다. 숫자, 날짜, bigint에는 `gt` / `gte` / `lt` / `lte` / `between`이 더 있습니다. 문자열에는 `like` / `notLike` / `ilike` / `contains` / `startsWith` / `endsWith` / `search`가 더 있습니다. 배열만 넣으면 `in`의 축약형입니다. `null`은 `IS NULL`을 뜻합니다.

이 밖에 자주 쓰는 메서드로는 `findOneOrFail`, `findByPK`, `findAndCount`, `exists`, `count` / `sum` / `avg` / `min` / `max`, 단일 컬럼만 뽑는 `pluck`이 있습니다. `findOneOrFail`은 `EntityNotFoundError`를 던집니다. 그래서 앞에서 만든 미들웨어가 404로 매핑합니다. 전체 목록은 [EntityManager로 조회하기](./entity-manager-querying.md)에 있습니다.

::: tip limit 튜플보다 skip/take
`FindOption`에는 `limit`도 있습니다. `limit`은 숫자 하나(`LIMIT n`)나 `[offset, count]` 튜플을 받습니다. 튜플 형태는 빌더가 내부에서 쓰는 저수준 표현입니다. 호출하는 쪽에서는 `skip`과 `take`가 더 명확합니다. 페이지네이션 헬퍼도 `skip`과 `take`를 씁니다. 둘을 섞지 마세요. 튜플이 있으면 튜플을 우선하고 `skip`은 무시합니다.
:::

## 페이지네이션

방식은 두 가지입니다. 취향이 아니라 데이터의 성격에 따라 고르세요.

**오프셋 페이지네이션**은 번호가 붙은 페이지를 씁니다. 7페이지로 바로 이동하고 전체 개수를 표시합니다. 관리자 테이블처럼 사용자가 페이지 번호를 기대하는 화면에 맞습니다.

```typescript
app.get("/posts", async (req, res) => {
  const result = await em.findWithPage(Post, {
    page: Number(req.query.page ?? 1),
    pageSize: 20,
    where: { published: true },
    orderBy: { createdAt: "DESC" },
    relations: ["author"],
  });
  // { data, total, page, pageSize, totalPages, hasNextPage, hasPreviousPage }
  res.json(result);
});
```

**커서 페이지네이션**은 무한 스크롤과 피드에 씁니다. 아무리 깊이 들어가도 속도가 유지됩니다. `OFFSET 100000` 같은 스캔이 없기 때문입니다. 사용자가 페이지를 넘기는 중에 새 행이 삽입돼도 행을 건너뛰거나 중복하지 않습니다.

```typescript
app.get("/feed", async (req, res) => {
  const result = await em.findWithCursor(Post, {
    take: 20,
    cursor: req.query.cursor as string | undefined,
    orderBy: "createdAt",
    direction: "DESC",
    where: { published: true },
  });
  // { data, hasNextPage, nextCursor, count }
  res.json({ items: result.data, nextCursor: result.nextCursor });
});
```

커서는 불투명한 Base64 문자열입니다. `nextCursor`를 클라이언트에 그대로 넘기고 다음 요청에서 그대로 받으면 됩니다. 제약이 두 가지 있습니다. 첫째, 정렬 컬럼은 NULL이 아니어야 합니다. NULL 정렬 순서가 PostgreSQL, MySQL, SQLite에서 제각각이기 때문입니다. 둘째, 정렬 컬럼은 고유한 컬럼이거나 기본 키와 함께 쓰는 편이 좋습니다. 그렇지 않으면 타임스탬프가 같은 행이 페이지 경계에 걸칠 수 있습니다.

스트리밍까지 포함한 세 방식의 비교는 [페이지네이션](./pagination.md)에 있습니다.

## 쿼리 빌더

필터링과 관계 로딩은 `find()`로 충분합니다. 쿼리 빌더는 관계 그래프로 표현되지 않는 조인, 집계, 서브쿼리, 조건부 쿼리 조립이 필요할 때 쓰세요.

```typescript
const qb = em
  .createQueryBuilder(Post, "p")
  .leftJoinRelationAndSelect("author", "a")   // 관계 메타데이터에서 ON 절을 자동으로 만듭니다
  .where({ status: "published" })
  .andWhere({ createdAt: { gte: since } })
  .orderBy({ createdAt: "DESC" })
  .take(20);

const posts = await qb.getMany();
```

조건부 조립에서는 `find()` 주변에 `if`를 쌓는 것보다 빌더가 낫습니다.

```typescript
app.get("/search", async (req, res) => {
  const { q, authorId, minViews } = req.query;

  const posts = await em
    .createQueryBuilder(Post, "p")
    .where({ status: "published" })
    .when(!!q, (b) => b.andWhere({ title: { contains: String(q) } }))
    .when(!!authorId, (b) => b.andWhere({ authorId: Number(authorId) }))
    .when(!!minViews, (b) => b.andWhere({ views: { gte: Number(minViews) } }))
    .paginate({ page: Number(req.query.page ?? 1), pageSize: 20 });

  res.json(posts);
});
```

::: warning .where()는 이름 있는 파라미터를 쓴 SQL 문자열을 받지 않습니다
TypeORM을 쓰다 왔다면 `.where("p.title = :title", { title })`이 손에 익어 있을 것입니다. 하지만 여기서는 이 형태가 동작하지 않습니다. 문자열 인자는 SQL이 아니라 컬럼 참조로 해석합니다. 그래서 SQL 조각을 넘기면 빌드할 때 `InvalidQueryError`를 던집니다. 예전에는 깨진 쿼리를 그대로 만들었습니다. 받는 형태는 다음과 같습니다.

```typescript
.where({ title: "hello" })                      // 필터 객체 (가장 흔함)
.where("p.title", "hello")                      // 컬럼, 값
.where("p.views", ">=", 100)                    // 컬럼, 연산자, 값
.where(sql`LOWER(p.title) = ${term}`)           // raw 조각, 파라미터 바인딩됨
.where(qAlias(Post, "p").title.eq("hello"))     // 타입이 붙은 QueryDSL
```
:::

타입 DSL은 별칭을 넘나드는 조건에서 특히 쓸모가 있습니다. 컬럼 이름 오타를 컴파일할 때 잡아내기 때문입니다.

```typescript
import { qAlias } from "@stingerloom/orm";

const p = qAlias(Post, "p");
const a = qAlias(User, "a");

const rows = await em
  .createQueryBuilder(Post, "p")
  .leftJoin(User, "a", (j) => j.on(p.col("authorId"), "=", a.col("id")))
  .where(a.name.eq("alice"))
  .andWhere(p.views.gte(100))
  .getMany();
```

실행 메서드는 어떤 결과가 필요한지에 따라 고릅니다.

| 메서드 | 반환값 | 용도 |
|---|---|---|
| `getMany()` / `getOne()` | 엔티티 인스턴스 | 일반 조회. NOT NULL 컬럼을 빠뜨린 부분 선택은 거부합니다 |
| `getPartialMany()` | 평범한 객체 | 프로젝션. 몇 개 컬럼만 뽑는 목록 화면 |
| `getRawMany()` | 타입 없는 행 | 집계와 직접 작성한 표현식 |
| `paginate()` / `getCursor()` | 페이지 / 커서 결과 | 페이지네이션 엔드포인트 |
| `getCount()` / `getSum()` / `exists()` | 스칼라 | 카운터와 존재 확인 |

자세한 내용은 [쿼리 빌더](./query-builder.md)와 [쿼리 빌더의 실행](./query-builder-execution.md)에 있습니다.

## Raw SQL

SQL로 쓰는 편이 가장 명확한 문제라면 태그드 템플릿을 쓰세요. 파라미터 바인딩과 이식성이 그대로 유지됩니다. 엔티티 클래스를 보간하면 테이블 식별자로 해석합니다. 이때 테넌트 스키마 한정자와 네이밍 전략도 반영합니다. 나머지 값은 전부 파라미터로 바인딩합니다.

```typescript
const rows = await em.query<{ authorId: number; total: number }>`
  SELECT author_id AS "authorId", COUNT(*) AS total
  FROM ${Post}
  WHERE created_at >= ${since}
  GROUP BY author_id
  ORDER BY total DESC
  LIMIT ${limit}
`;
```

문자열 형태는 드라이버 고유의 플레이스홀더를 씁니다. 플레이스홀더는 다이얼렉트마다 다릅니다. PostgreSQL은 `$1, $2`이고 MySQL과 SQLite는 `?`입니다. 이를 변환하는 계층이 없으므로 이렇게 작성한 쿼리는 특정 데이터베이스에 묶입니다.

```typescript
const rows = await em.query<Post>("SELECT * FROM posts WHERE author_id = $1", [authorId]);
```

::: warning Raw SQL은 테넌트 스코프를 우회합니다
멀티테넌트 앱에서 `em.query()`는 테넌트 조건을 주입하지 않습니다. ORM은 이런 호출을 감지하면 경고를 남깁니다. PostgreSQL 스키마 전략에서는 연결 수준의 `search_path`가 격리를 강제하므로 격리가 그대로 유지됩니다. 하지만 테넌트 컬럼 전략에서는 raw SQL이 테넌트 경계를 넘어 조회합니다. 이 경우에는 조건을 직접 넣거나 쿼리 빌더를 쓰세요.
:::

## 대용량 결과 스트리밍

내보내기 엔드포인트에서 결과 전체를 메모리에 올리는 일은 피해야 합니다. `em.stream()`은 내부에서 배치 단위로 조회하면서 엔티티를 하나씩 넘깁니다. 그래서 줄 단위 JSON 응답과 자연스럽게 맞물립니다.

```typescript
app.get("/export/users", async (req, res) => {
  res.setHeader("Content-Type", "application/x-ndjson");

  for await (const user of em.stream(User, { orderBy: { id: "ASC" } }, 500)) {
    // 백프레셔 처리: 이 처리가 없으면 빠른 DB가 느린 클라이언트를 앞지릅니다
    if (!res.write(JSON.stringify(user) + "\n")) {
      await new Promise((resolve) => res.once("drain", resolve));
    }
  }

  res.end();
});
```

`streamBatch()`는 배열 단위로 넘깁니다. 소비하는 쪽이 원래 배치 형태일 때 쓰면 좋습니다. 대량 API, CSV 작성기, 큐 발행이 그 예입니다.

`stream()`과 `streamBatch()`는 데이터베이스 커서가 아니라 `LIMIT`/`OFFSET`으로 페이지를 나눕니다. 그래서 모든 다이얼렉트에서 동작합니다. 대신 안정적인 `orderBy`가 반드시 필요합니다. 정렬이 없으면 배치 사이에서 행이 누락되거나 중복될 수 있습니다.

---

## 트랜잭션 {#transactions}

콜백 형태가 기본입니다. 콜백 안의 모든 작업은 트랜잭션 하나를 공유합니다. 그리고 에러가 나면 전체를 롤백합니다.

```typescript
await em.transaction(async (txEm) => {
  const from = await txEm.findOneOrFail(Account, { where: { id: fromId } });
  if (from.balance < amount) throw new Error("insufficient funds");

  await txEm.update(Account, { id: fromId }, { balance: from.balance - amount });
  await txEm.increment(Account, { id: toId }, "balance", amount);
});
```

옵션으로는 격리 수준, 전파 방식, 데드락 재시도를 지정합니다.

```typescript
await em.transaction(
  async (txEm) => { /* ... */ },
  {
    isolationLevel: "SERIALIZABLE",   // "READ UNCOMMITTED" | "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE"
    retryOnDeadlock: true,
    maxRetries: 3,                    // retryOnDeadlock이 true일 때만 반영됩니다
    retryDelayMs: 100,
  },
);
```

재시도는 콜백 전체를 다시 실행합니다. 그래서 콜백은 멱등해야 합니다. 메모리의 카운터를 증가시키거나 중간에 이메일을 보내는 코드가 들어가면 안 됩니다.

### DI 컨테이너 없이 쓰는 @Transactional()

`@Transactional()`은 NestJS 전용 기능이 아닙니다. 활성 트랜잭션을 `AsyncLocalStorage`로 추적하고 `this`는 전혀 건드리지 않습니다. 주입받은 `em`, 상속할 기반 클래스, 컨테이너가 모두 필요 없습니다. 그래서 평범한 Express 서비스 클래스에서도 그대로 동작합니다.

```typescript
import { Transactional } from "@stingerloom/orm";
import { em } from "../db";

export class TransferService {
  @Transactional()
  async transfer(fromId: number, toId: number, amount: number) {
    // 이 안의 모든 em 호출이 같은 트랜잭션으로 묶입니다.
    // 이 메서드가 호출하는 함수 안의 호출도 깊이와 상관없이 전부 포함됩니다.
    const from = await em.findOneOrFail(Account, { where: { id: fromId } });
    if (from.balance < amount) throw new Error("insufficient funds");

    await em.update(Account, { id: fromId }, { balance: from.balance - amount });
    await em.increment(Account, { id: toId }, "balance", amount);
  }
}
```

데코레이터가 받는 옵션은 `isolationLevel`, `propagation`, `connectionName`이 전부입니다. 데드락 재시도는 `em.transaction()`에만 있습니다. 그래서 재시도가 필요하면 콜백 형태를 쓰세요.

::: warning @Transactional()은 항상 기본 커넥션을 엽니다
데코레이터는 내부에서 호출하는 `em`이 아니라 전역 레지스트리에서 연결을 찾습니다. 다른 연결에 묶인 매니저는 그 트랜잭션에 합류하지 않습니다. 그 매니저의 SQL 문은 자기 연결에서 실행하고 쓰기마다 각자의 트랜잭션으로 커밋합니다. 매니저가 이름 있는 연결에 묶여 있다면 `@Transactional({ connectionName: "analytics" })`처럼 연결을 명시하세요. 아니면 매니저 자신의 연결을 여는 `em.transaction(cb)`를 쓰세요. 자세한 내용은 [여러 연결에 걸친 트랜잭션](./transactions.md#transactions-on-more-than-one-connection)에 있습니다.

그리고 `propagation: NESTED`는 감싸는 트랜잭션이 없으면 평범한 트랜잭션으로 바뀝니다. 중첩할 대상이 없으므로 세이브포인트가 아무것도 보호하지 못합니다.
:::

### 요청 전체를 하나의 트랜잭션으로 묶어도 될까

모든 요청을 `em.transaction()`으로 감싸는 미들웨어를 두면 핸들러가 트랜잭션을 신경 쓰지 않아도 될 것처럼 보입니다. 하지만 일반적인 용도로는 권장하지 않습니다. 요청이 끝날 때까지 풀의 연결을 붙잡고 있기 때문입니다. 여기에는 템플릿 렌더링, 외부 HTTP 호출, 느린 클라이언트를 기다리는 시간이 모두 포함됩니다. 부하가 걸릴 때 풀을 고갈시키는 가장 빠른 방법입니다. 트랜잭션은 요청 전체가 아니라 원자성이 필요한 쓰기 구간에만 여세요.

예외는 요청 자체가 처음부터 끝까지 하나의 작업 단위인 경우입니다. 결제나 임포트가 그 예입니다. 이때는 앱 전체가 아니라 그 라우트만 감싸면 됩니다.

격리 수준, 세이브포인트, 전파 방식의 자세한 동작은 [트랜잭션](./transactions.md)의 「격리 수준 설정」부터 이어지는 절에 있습니다.

## 동시성: 낙관적 잠금과 비관적 잠금

**낙관적 잠금**은 HTTP와 잘 맞습니다. 브라우저 탭 두 개가 같은 행을 수정하는 전형적인 상황을 이 방식이 잡아내기 때문입니다. 버전 컬럼을 추가하면 오래된 데이터로 덮어쓰려는 시도는 성공하지 않고 에러를 던집니다.

```typescript
export const Post = defineEntity("posts", {
  id:      t.int().primary().generated(),
  title:   t.varchar(200),
  version: t.int().version(),
});
```

```typescript
app.patch("/posts/:id", async (req, res, next) => {
  try {
    const post = await em.findOneOrFail(Post, { where: { id: Number(req.params.id) } });
    post.title = req.body.title;
    post.version = req.body.version; // 클라이언트가 마지막으로 읽은 버전
    res.json(await em.save(Post, post));
  } catch (e) {
    next(e); // OptimisticLockError -> 에러 미들웨어에서 409로 매핑됩니다
  }
});
```

현재 행과 함께 `409`를 반환하세요. 그러면 사용자가 편집한 내용을 잃지 않고 클라이언트가 제대로 된 충돌 화면을 보여 줍니다.

**비관적 잠금**은 경합이 심한 짧은 쓰기 경로에 씁니다. 재고 차감, 원장 잔액, 작업 큐가 그 예입니다. 비관적 잠금은 트랜잭션 안에서만 효과가 있습니다.

```typescript
import { LockMode } from "@stingerloom/orm";

await em.transaction(async (txEm) => {
  const item = await txEm.findOne(Inventory, {
    where: { sku },
    lock: LockMode.PESSIMISTIC_WRITE,   // SELECT ... FOR UPDATE
  });
  if (!item || item.stock < 1) throw new Error("out of stock");
  await txEm.update(Inventory, { sku }, { stock: item.stock - 1 });
});
```

`PESSIMISTIC_WRITE_SKIP_LOCKED`를 쓰면 테이블이 작업 큐 역할을 합니다. 각 워커는 다른 워커가 잡고 있지 않은 행만 가져갑니다. 다만 MySQL 8.0+나 PostgreSQL 9.5+가 필요합니다. SQLite는 `NOWAIT`나 `SKIP_LOCKED` 모드에서 에러를 던지고 일반 `FOR UPDATE`는 무시합니다. 로컬 개발은 SQLite로 하고 운영은 PostgreSQL로 한다면 특히 유념하세요.

## 배치 쓰기

대량 처리 엔드포인트에서 가장 흔한 성능 실수는 반복문 안에서 `save()`를 한 행씩 호출하는 것입니다. 배치 메서드는 SQL 문 하나로 처리합니다.

```typescript
await em.insertMany(Post, rows);          // 다중 행 INSERT 한 번, { affected } 반환
const saved = await em.saveMany(Post, rows);          // 하이드레이션된 인스턴스 반환
const created = await em.insertManyAndReturn(Post, rows); // INSERT ... RETURNING

await em.batchUpsert(Post, rows, ["slug"]);           // INSERT ... ON CONFLICT/DUPLICATE KEY
await em.updateMany(Post, { archived: true }, { where: { authorId: 7 } });
```

`insertManyAndReturn`은 `INSERT ... RETURNING`이 필요합니다. PostgreSQL, SQLite 3.35+, MariaDB 10.5+에서 동작합니다. MySQL에서는 SQL을 생성하기 전에 에러를 던집니다. MySQL에서는 `saveMany`를 쓰세요.

정말 큰 임포트라면 배치를 트랜잭션으로 감싸고 청크 단위로 나눠서 처리하세요. 그러면 한 번 실패해도 파일이 절반만 적재된 상태로 남지 않습니다.

```typescript
await em.transaction(async (txEm) => {
  for (let i = 0; i < rows.length; i += 500) {
    await txEm.insertMany(Post, rows.slice(i, i + 500));
  }
});
```

## 소프트 삭제

`@DeletedAt` 컬럼을 추가하고 `softDelete`와 `restore`를 쓰면 됩니다. 코드 우선 스타일에서는 `t.datetime().deletedAt()`을 씁니다.

```typescript
await em.softDelete(Post, { id });   // deleted_at을 채웁니다
await em.restore(Post, { id });      // 다시 비웁니다
```

그러면 모든 조회가 기본적으로 소프트 삭제된 행을 걸러 냅니다. `withDeleted: true`는 그 행도 포함합니다. `onlyDeleted: true`는 소프트 삭제된 행만 반환하고 `withDeleted`보다 우선합니다. 휴지통 화면에 이 옵션을 씁니다.

```typescript
await em.find(Post, { where: { authorId: 7 } });                      // 살아 있는 행
await em.find(Post, { where: { authorId: 7 }, withDeleted: true });   // 살아 있는 행 + 삭제된 행
await em.find(Post, { where: { authorId: 7 }, onlyDeleted: true });   // 삭제된 행만
```

삭제 엔드포인트를 만들기 전에 반드시 알아 둘 동작이 두 가지 있습니다.

- **`em.delete()`는 `@DeletedAt` 컬럼이 있어도 여전히 하드 `DELETE`입니다.** 소프트 삭제는 전역 모드가 아니라 호출마다 고르는 기능입니다. 그래서 HTTP `DELETE`를 `softDelete()`로 처리하려면 라우트에서 직접 연결하세요.
- **집계 메서드는 이 플래그를 옵션 객체가 아니라 위치 인자로 받습니다.** `em.count(Post, where, withDeleted, onlyDeleted)` 형태입니다.

대량 `updateMany`는 기본적으로 소프트 삭제된 행을 건너뜁니다. 일괄 수정이 삭제된 데이터를 의도와 달리 되살리지 않게 하려는 것입니다. 포함하려면 `withDeleted: true`를 넘기면 됩니다.

---

## 커넥션 풀링 {#connection-pooling}

```typescript
pool: {
  max: 10,                  // 기본값 10
  min: 0,                   // PostgreSQL 전용
  acquireTimeoutMs: 30_000, // PostgreSQL 전용
  idleTimeoutMs: 10_000,    // PostgreSQL 전용
  validateOnBorrow: false,  // 연결을 넘기기 전에 ping
}
```

풀 크기를 정하는 기준은 [운영 가이드](./production-guide.md)의 「Connection Pool 크기」에 있습니다. Express 앱이 부하를 받을 때의 동작은 다이얼렉트마다 다음과 같이 다릅니다.

- **SQLite는 `pool.acquireTimeoutMs`만 읽습니다.** 연결이 하나뿐이므로 트랜잭션은 그 연결에서 차례로 실행합니다. 다른 트랜잭션이 열려 있는 동안 트랜잭션을 시작한 요청은 앞의 트랜잭션을 기다립니다. 그 트랜잭션 바깥의 읽기와 쓰기도 마찬가지입니다([SQLite의 트랜잭션](./transactions.md#transactions-on-sqlite)). 이 대기 시간의 상한이 `acquireTimeoutMs`입니다. 요청이 겹쳐도 안전합니다. SQL 문을 병렬로 실행하지 않을 뿐입니다.
- **MySQL에는 `max`만 전달됩니다.** `acquireTimeoutMs`는 전달되지 않습니다. ORM이 `queueLimit`도 설정하지 않습니다. 그래서 풀이 포화되면 `mysql2`가 호출자를 무한정 큐에 쌓습니다. 요청이 빠르게 실패하지 않고 계속 밀립니다. 느린 쿼리가 몰리면 지연이 끝없이 늘어납니다. 쿼리 단위 `timeout`과 HTTP 계층의 요청 타임아웃으로 방어하세요.
- **PostgreSQL은 네 옵션을 모두 반영합니다.** 풀이 포화되면 `acquireTimeoutMs`가 지난 뒤 요청을 거부합니다. 이 거부는 `OrmError`가 아니라 `pg`의 원본 에러로 전달됩니다.

`validateOnBorrow: true`는 연결을 쓰기 전에 ping하고 실패하면 한 번 재시도합니다. 덕분에 데이터베이스가 재시작돼도 앱을 함께 재시작하지 않고 버팁니다. 대신 체크아웃마다 왕복이 한 번 더 듭니다.

::: warning leakDetectionThresholdMs는 현재 아무 동작도 하지 않습니다
`pool.leakDetectionThresholdMs` 옵션은 선언되어 있고 `ConnectionLeakDetector` 클래스도 export되어 있습니다. 하지만 ORM 내부에 이 둘을 잇는 코드가 없습니다. 그래서 지금은 값을 설정해도 효과가 없습니다. 연결 누수를 찾으려면 느린 쿼리 로깅과 데이터베이스 쪽 풀 지표를 사용하세요.
:::

## 로깅, 슬로우 쿼리, N+1 감지

```typescript
logging: {
  queries: true,        // 생성된 SQL을 전부 로깅 (개발용)
  slowQueryMs: 200,     // 이 시간을 넘으면 경고
  nPlusOne: true,       // 같은 엔티티 반복 조회를 경고
  maxLogEntries: 1000,  // 링 버퍼 크기
}
```

출력은 다음과 같습니다.

```
[SLOW QUERY] 342ms: SELECT ... FROM "posts" WHERE ...
[N+1 WARNING] Entity "Post" queried 12+ times in 100ms. Consider using eager loading or relations option.
```

`logging: true`만 켜면 SQL 로깅만 활성화됩니다. 트래커를 생성하지 않으므로 느린 쿼리 경고와 N+1 경고도 없습니다. 종료할 때 `gracefulTimeoutMs`도 동작하지 않습니다. 이런 신호가 필요한 환경에서는 객체 형태를 쓰세요.

운영 환경에서는 보통 콘솔 출력보다 구조화된 이벤트가 필요합니다. 트래커는 이벤트 이미터입니다.

```typescript
const tracker = em.getQueryTracker();

tracker?.on("slowQuery", (entry) => {
  logger.warn({ sql: entry.sql, ms: entry.durationMs, entity: entry.entityName }, "slow query");
});

tracker?.on("nPlusOne", (entityName, samples) => {
  logger.warn({ entity: entityName, count: samples.length }, "n+1 detected");
});
```

N+1 판정 기준은 100ms 안에 같은 엔티티를 10회 조회하는 것으로 고정되어 있습니다. 그리고 트래커가 살아 있는 동안 엔티티마다 한 번만 경고합니다. 이 경고는 문제 지점을 가리키는 신호입니다. 그래프로 그릴 지표는 아닙니다.

해결책은 대개 행마다 조회하지 않고 관계를 미리 함께 로드하는 것입니다.

```typescript
// N+1: 게시글 조회 한 번, 그리고 게시글 수만큼 추가 조회
const posts = await em.find(Post, {});
for (const p of posts) p.author = await em.findOne(User, { where: { id: p.authorId } });

// 조인 한 번으로 해결
const posts = await em.find(Post, { relations: ["author"] });
```

## 읽기 리플리카

```typescript
replication: {
  master: { host: "db-primary", port: 5432, username: "app", password, database: "app" },
  slaves: [
    { host: "db-replica-1", port: 5432, username: "app", password, database: "app" },
    { host: "db-replica-2", port: 5432, username: "app", password, database: "app" },
  ],
  strategy: "round-robin",   // 또는 "random"
}
```

읽기는 레플리카로 분산됩니다. 쓰기와 트랜잭션 안의 작업은 항상 프라이머리로 갑니다. 방금 쓴 데이터를 반드시 읽어야 할 때는 쿼리마다 프라이머리를 지정하세요. `POST` 핸들러가 생성한 행을 그대로 반환하는 read-after-write 상황이 그 예입니다.

```typescript
await em.findOne(User, { where: { id }, useMaster: true });
```

`useMaster`는 `findWithPage`와 `findWithCursor` 옵션에도 있습니다.

::: tip 리플리카마다 풀 하나
레플리카마다 연결 풀이 하나씩 생깁니다. 그 레플리카로 가는 첫 읽기가 풀을 엽니다. 이후 읽기는 모두 그 풀을 함께 씁니다. 그리고 `propagateShutdown()`이 풀을 닫습니다. 이름 있는 연결에서도 리플리케이션이 동작합니다. 이때 레플리카는 그 연결의 옵션을 받습니다. 다운된 레플리카는 [헬스 체크](./configuration.md#replica-health-checks)가 로테이션에서 뺄 때까지 자기에게 온 읽기를 계속 실패시킵니다. 그래서 프로덕션에서는 `healthCheck`를 설정하세요.
:::

## 다중 데이터베이스 {#multiple-databases}

`getRepository(Entity, connectionName)` 같은 오버로드는 없습니다. 연결은 매니저의 속성이기 때문입니다. 데이터베이스마다 `EntityManager`를 하나씩 만드세요.

```typescript
// db.ts
export const em = new EntityManager();          // 주 데이터베이스
export const analyticsEm = new EntityManager(); // 분석용 웨어하우스

export async function initDb() {
  await em.register(primaryOptions);                          // "default"
  await analyticsEm.register(analyticsOptions, "analytics");  // 이름 있는 연결
}
```

`analyticsEm.getRepository(Event)`는 `"analytics"` 연결을 그대로 물려받습니다. 두 번째 매니저를 만들지 않고 다른 연결에서 트랜잭션 하나만 실행하려면 연결 이름을 넘기면 됩니다.

```typescript
await em.transaction(async (txEm) => { /* ... */ }, { connectionName: "analytics" });
```

`em.attach(name, overrides?)`는 이미 등록된 풀에 매니저를 새 연결 없이 붙입니다. `synchronize: false`를 강제하므로 기존 연결 위에 읽기 전용 리포팅 매니저를 올릴 때 적합합니다.

## Express 워크플로에서의 마이그레이션 {#migrations}

실제 데이터가 쌓이기 시작하면 `synchronize`를 마이그레이션으로 교체하세요. CLI는 프로젝트 루트의 설정 파일을 읽습니다. `stingerloom.config.ts`, `.js`, `.mjs`, `.cjs`를 지원하고 `ormconfig.*`도 지원합니다.

```typescript
// stingerloom.config.ts
import { CreateUsersTable } from "./migrations/001-create-users";
import { AddPostsTable } from "./migrations/002-add-posts";
import { User } from "./src/entities/user";
import { Post } from "./src/entities/post";

export default {
  connection: {
    type: "postgres",
    host: process.env.DB_HOST ?? "localhost",
    port: 5432,
    username: "app",
    password: process.env.DB_PASSWORD ?? "",
    database: "app",
    entities: [User, Post],   // migrate:generate에 필요합니다
  },
  migrations: [CreateUsersTable, AddPostsTable],
};
```

```bash
npx stingerloom migrate:status
npx stingerloom migrate:run
npx stingerloom migrate:generate --name add_posts
npx stingerloom migrate:rollback
```

`migrations`는 import한 마이그레이션 클래스의 배열이어야 합니다. glob 패턴은 지원하지 않습니다. 배열이 아닌 값을 넣으면 명확한 설정 에러로 실패합니다. `connection` 래퍼 없는 평면 `DatabaseClientOptions` 객체도 그대로 받습니다.

::: tip 마이그레이션은 부팅이 아니라 배포 단계에서 실행하세요
`MigrationRunner.runAll()`은 애플리케이션 코드에서 호출해도 안전합니다. 데이터베이스 어드바이저리 잠금을 사용하므로 인스턴스 여러 개가 동시에 시작해도 중복 적용되지 않습니다. 다만 프로세스 전역 `DatabaseClient` 싱글턴을 쓰고 끝나면 그 싱글턴을 닫습니다. 그래서 실행 중인 앱 매니저의 연결까지 함께 끊깁니다. 마이그레이션은 별도 명령으로 실행하세요. 쿠버네티스 init 컨테이너, 릴리스 단계, CI의 `npm run migrate`가 그 예입니다. 그리고 앱은 스키마가 최신이라고 가정하게 하세요.
:::

`synchronize`에서 마이그레이션으로 넘어가는 절차와 위험한 컬럼 변경을 무중단으로 적용하는 패턴은 [운영 가이드](./production-guide.md)의 「synchronize에서 Migration으로 전환하기」에 있습니다.

## 시딩

시더는 `SeederRunner`가 실행하는 평범한 클래스입니다. 실행 이력이 `__seeds` 테이블에 기록되므로 다시 실행해도 안전합니다. CLI 명령은 없으므로 스크립트에서 호출하세요.

```typescript
// scripts/seed.ts
import { EntityManager, Seeder, SeederRunner, type SeederContext } from "@stingerloom/orm";
import { loadDbOptions } from "../src/config";
import { User } from "../src/entities/user";

class AdminSeeder extends Seeder {
  async run({ em }: SeederContext) {
    await em.save(User, { email: "admin@example.com", name: "admin" });
  }
  async revert({ em }: SeederContext) {
    await em.delete(User, { email: "admin@example.com" });
  }
}

const em = new EntityManager();
await em.register(loadDbOptions());

const runner = new SeederRunner([new AdminSeeder()], em, { query: (sql) => em.query(sql) });
console.log(await runner.runAll());
await em.propagateShutdown({ closeConnections: true });
```

---

## 멀티테넌시 미들웨어 {#multi-tenancy-middleware}

[멀티테넌시](./multi-tenancy.md) 컨텍스트는 순수 `AsyncLocalStorage` 기반입니다. 그래서 Express 미들웨어 자체는 짧습니다. 차이는 그 아래의 격리 전략에서 생깁니다. 전략마다 빠뜨리면 안 되는 규칙이 하나씩 있습니다.

**스키마 기반(PostgreSQL).** 테넌트 ID는 생성되는 SQL에서 스키마 이름이 됩니다. 그래서 ORM에 전달하기 전에 식별자로 유효한지 검증해야 합니다.

```typescript
import { MetadataContext } from "@stingerloom/orm";

const SCHEMA_RE = /^[A-Za-z_][A-Za-z0-9_$-]*$/;

app.use((req, res, next) => {
  const tenantId = req.headers["x-tenant-id"] as string | undefined;
  if (!tenantId || !SCHEMA_RE.test(tenantId)) {
    return res.status(400).json({ error: "invalid tenant" });
  }
  // await하지 마세요. next()가 AsyncLocalStorage 스코프 안에서 실행돼야 합니다
  MetadataContext.run(tenantId, () => next());
});
```

**테넌트 컬럼(모든 다이얼렉트).** 식별자 제약은 없습니다. 하지만 격리는 ORM이 생성하는 `WHERE` 절로 강제합니다. 그래서 raw SQL은 이 격리를 벗어납니다.

```typescript
await em.register({
  // ...
  tenantStrategy: "tenant_column",
  tenantColumnName: "tenant_id",
  tenantColumnType: "uuid",
});
```

```typescript
app.use((req, res, next) => {
  const tenantId = req.headers["x-tenant-id"] as string | undefined;
  if (!tenantId) return res.status(400).json({ error: "missing tenant" });

  MetadataContext.run(tenantId, () => {
    em.assertTenantContext(); // 요청마다 한 번만 호출합니다. 호출할 때마다 경고를 남깁니다
    next();
  });
});
```

이렇게 해 두면 요청 안에서 실행되는 모든 핸들러와 ORM 호출이 그 테넌트의 컨텍스트에서 실행됩니다. 그리고 테넌트가 다른 동시 요청은 서로 격리됩니다. 의도적으로 테넌트 경계를 넘는 관리자 라우트라면 스코프를 명시적으로 벗어나세요.

```typescript
app.get("/admin/report", requireAdmin, (req, res, next) => {
  Promise.resolve(
    MetadataContext.runUnscoped(async () => {
      res.json(await em.find(Invoice, {}));
    }),
  ).catch(next);
});
```

운영에 올리기 전에 알아 둘 것이 세 가지 있습니다.

- `"public"`은 "테넌트 없음"을 뜻하는 예약값이므로 필터가 붙지 않습니다. 그래서 이름이 말 그대로 `public`인 테넌트는 전체 데이터를 봅니다.
- 테넌트 프로비저닝(`PostgresTenantMigrationRunner`)은 PostgreSQL 전용입니다. MySQL과 SQLite 러너는 에러를 던집니다.
- 요청 단위 컨텍스트 구성을 대규모로 운영하는 방법과 수백 개 테넌트가 연결 풀을 공유하는 전략은 [운영 가이드](./production-guide.md)의 「HTTP 요청별 테넌트 컨텍스트 설정」에 있습니다.

## 라이프사이클 훅과 서브스크라이버

감사 로그, 캐시 무효화, 아웃박스 행처럼 쓰기 전반에 걸치는 관심사는 구독자로 분리하세요. 그러면 모든 서비스에서 그 로직이 빠집니다. 구독자는 DI 컨테이너 없이 평범한 `EntityManager`에 등록하면 됩니다.

```typescript
import type { EntitySubscriber, UpdateEvent } from "@stingerloom/orm";

class UserAuditSubscriber implements EntitySubscriber<User> {
  listenTo() {
    return User;
  }

  async beforeUpdate(event: UpdateEvent<User>) {
    // databaseEntity는 UPDATE 직전에 데이터베이스에서 조회한 스냅숏입니다
    if (!event.databaseEntity) return;
    if (event.databaseEntity.email !== event.entity.email) {
      await event.manager.save(AuditLog, {
        entity: "User",
        field: "email",
        before: event.databaseEntity.email,
        after: event.entity.email,
      });
    }
  }
}

em.addSubscriber(new UserAuditSubscriber());
```

구독자는 `afterLoad`, 삽입·수정·삭제의 전후, 소프트 삭제와 복원, 트랜잭션 경계에서 호출됩니다. 다만 한계가 두 가지 있습니다. 첫째, `databaseEntity`는 `em.save()`에서만 채워집니다. 쿼리 빌더로 직접 실행한 UPDATE에서는 `null`입니다. 둘째, 대량 `updateMany`에서는 구독자의 수정 이벤트가 발생하지 않습니다.

엔티티 자신에게 속하는 로직이라면 `@BeforeInsert` / `@AfterInsert` / `@BeforeUpdate` / `@AfterUpdate` / `@BeforeDelete` / `@AfterDelete` 메서드 데코레이터가 더 간단합니다. 코드 우선 방식에서는 `defineEntity`의 `hooks` 옵션이 같은 역할을 합니다. 이때 훅은 인스턴스에서 실행됩니다. 그래서 객체 리터럴이 아니라 `new Post({ ... })`로 만들어서 저장해야 합니다.

자세한 내용은 [이벤트](./events.md)에 있습니다.

## 쓰기 버퍼 (Unit of Work)

ORM은 기본적으로 쓰기를 즉시 실행합니다. `save()`를 호출하면 그 자리에서 SQL을 보냅니다. 버퍼 플러그인을 켜면 여기에 아이덴티티 맵과 변경 추적이 추가됩니다. 그러면 엔티티를 조회하고 평범한 객체처럼 수정한 뒤 한 번에 flush합니다.

```typescript
import { bufferPlugin } from "@stingerloom/orm";

em.extend(bufferPlugin());
```

```typescript
app.post("/orders/:id/recalculate", async (req, res) => {
  await em.transaction(async () => {
    const buf = em.buffer();

    const order = await buf.findOne(Order, { where: { id: Number(req.params.id) } });
    const lines = await buf.find(OrderLine, { where: { orderId: order!.id } });

    order!.total = lines.reduce((sum, l) => sum + l.price * l.quantity, 0);

    const result = await buf.flush(); // { updates, inserts, deletes }
    res.json(result);
  });
});
```

버퍼는 요청마다 새로 만드세요. 모듈 수준 싱글턴으로 두면 안 됩니다. 버퍼는 변경 추적 범위입니다. 그래서 동시 요청이 버퍼 하나를 공유하면 서로의 엔티티가 뒤섞입니다.

::: warning 중첩 버퍼는 감싸는 트랜잭션이 필요합니다
`buf.beginNested()`는 flush를 `SAVEPOINT`로 감쌉니다. 이 세이브포인트는 `em.transaction()`이 이미 열려 있을 때만 의미가 있습니다. 트랜잭션 밖에서 중첩 버퍼를 flush하면 자체 트랜잭션을 열고 커밋합니다. 그래서 나중에 부모가 롤백해도 그 변경은 되돌리지 못합니다. 이 경우 ORM이 경고를 남깁니다. 위 예제처럼 전체 작업을 `em.transaction()`으로 감싸세요.
:::

flush 모드, 캐스케이드 동작, 컬렉션 추적 등 전체 동작은 [쓰기 버퍼](./write-buffer.md)에 있습니다.

## 플러그인

플러그인은 모든 쿼리를 봅니다. 그래서 서비스 여기저기에 흩어지기 쉬운 메트릭과 트레이싱을 넣기에 알맞은 자리입니다.

```typescript
import type { StingerloomPlugin } from "@stingerloom/orm";

const metricsPlugin: StingerloomPlugin = {
  name: "metrics",
  install() {
    // 최초 1회 설정. API 객체를 반환하면 em.extend()가 합칩니다
  },
  afterQuery(query, _result, durationMs) {
    queryDuration.observe({ operation: query.operation ?? "unknown" }, durationMs);
  },
  beforeTransaction() {
    transactionsStarted.inc();
  },
  afterTransaction(committed) {
    (committed ? transactionsCommitted : transactionsRolledBack).inc();
  },
  async shutdown() {
    await metricsRegistry.flush();
  },
};

em.extend(metricsPlugin);
```

`shutdown()` 훅은 `propagateShutdown()` 중에 설치 역순으로 실행됩니다. 덕분에 플러그인은 프로세스가 끝나기 전에 버퍼에 쌓인 텔레메트리를 내보냅니다. 자세한 내용은 [플러그인](./plugins.md)에 있습니다.

## 테스트

`@stingerloom/orm/testing`은 인메모리 SQLite 매니저를 제공합니다. 테스트 파일마다 새로 만들어도 충분히 빠릅니다. 그리고 실행 중인 데이터베이스가 필요 없습니다.

```typescript
// tests/users.test.ts
import request from "supertest";
import { createTestEntityManager } from "@stingerloom/orm/testing";
import { User } from "../src/entities/user";

let em: Awaited<ReturnType<typeof createTestEntityManager>>;

beforeAll(async () => {
  em = await createTestEntityManager({ entities: [User] });
});

afterAll(async () => {
  await em.propagateShutdown({ closeConnections: true });
});

it("creates a user", async () => {
  const res = await request(app).post("/users").send({ email: "a@b.c", name: "alice" });
  expect(res.status).toBe(201);
  expect(await em.count(User)).toBe(1);
});
```

이 헬퍼의 기본값은 `type: "sqlite"`, `database: ":memory:"`, `synchronize: true`, `connectionName: "test"`입니다. 연결 이름을 따로 두므로 같은 프로세스에서 `"default"`로 등록된 애플리케이션 매니저와 충돌하지 않습니다.

다만 SQLite는 운영 데이터베이스와 다른 점이 있습니다. 그리고 테스트가 그 차이를 가릴 수 있습니다. SQLite에는 `SKIP LOCKED`가 없습니다. 트랜잭션은 동시에 실행되지 않고 차례로 실행됩니다. 타입 처리도 느슨합니다. 이런 동작에 의존하는 부분은 실제 엔진을 대상으로 하는 통합 테스트를 따로 두는 편이 좋습니다.

---

## 개발 도구 참고 사항

- **tsx / nodemon의 재시작**은 걱정하지 않아도 됩니다. 메타데이터와 연결은 프로세스가 새로 뜰 때마다 다시 구성됩니다.
- **better-sqlite3는 네이티브 모듈입니다.** 업그레이드 직후 `new Database()`에서 프로세스가 죽는다면 설치된 prebuilt 바이너리가 현재 Node.js 버전과 맞지 않는 것입니다. `npm rebuild better-sqlite3`로 다시 빌드하세요. 아니면 사용 중인 Node 릴리스를 지원하는 메이저 버전으로 고정하세요.
- 마이그레이션 CLI(`npx stingerloom`)는 CommonJS로 실행되는 도구입니다. 그래서 앱이 어떤 모듈 시스템을 쓰든 동작합니다.
- **`reflect-metadata`는 어떤 엔티티 모듈보다 먼저, 딱 한 번 import해야 합니다.** `db.ts` 최상단에 두고 `main.ts`에서 `db.ts`를 가장 먼저 import하는 순서가 안전합니다. 그러지 않으면 import를 끌어올리는 번들러에서 폴리필보다 엔티티가 먼저 로드될 수 있습니다.

## 운영 체크리스트

| 항목 | 설정 |
|---|---|
| 스키마 변경 | `synchronize: false`, 마이그레이션은 별도 배포 단계에서 실행 |
| 풀 크기 | `pool.max`는 데이터베이스 최대 연결 수를 인스턴스 수로 나눈 값 기준 |
| 쿼리 타임아웃 | `queryTimeout` 설정 + HTTP 계층 타임아웃. 풀 큐가 무한한 MySQL에서는 특히 필수 |
| 느린 쿼리 | `logging: { slowQueryMs: 200 }`을 `getQueryTracker()`로 로거에 연결 |
| 종료 | `SIGTERM` 핸들러에서 `server.close()` 후 `propagateShutdown({ closeConnections: true })` |
| 프로브 | I/O 없는 `/healthz`, `hasConnection()` 가드 뒤에서 `runTestSql()`을 호출하는 `/readyz` |
| 에러 | 제약 조건 위반을 포함한 `OrmError` 서브클래스를 상태 코드로 매핑하는 에러 미들웨어 |
| 끊긴 연결 | `onConnectionError`를 메트릭이나 로거에 연결 |
| 비밀 정보 | `suggestion`과 스택 트레이스는 로그에만, 클라이언트 응답에는 절대 포함하지 않기 |

## Next Steps

- [설정](./configuration.md): 연결 옵션 전체
- [트랜잭션](./transactions.md): 격리 수준, 세이브포인트, 전파 방식
- [EntityManager로 조회하기](./entity-manager-querying.md): 읽기 API 전체
- [운영 가이드](./production-guide.md): 풀 모니터링, 무중단 마이그레이션, 대규모 테넌시
- [트러블슈팅](./troubleshooting.md): 가장 먼저 마주치는 에러
