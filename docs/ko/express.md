# Express에서 사용하기

Stingerloom ORM은 특정 프레임워크에 종속되지 않습니다. NestJS 통합에서 쓰는 `EntityManager`도 결국 어디서든 쓸 수 있는 평범한 클래스이고, NestJS 모듈은 그 위에 의존성 주입을 얹은 얇은 래퍼일 뿐입니다. 이 가이드에서는 그 래퍼가 대신해 주던 일들을 순수 [Express](https://expressjs.com/) 앱에서 어떻게 처리하는지 패턴별로 정리합니다. Fastify, Koa, Hono 같은 다른 Node.js 서버에도 그대로 적용할 수 있습니다.

모듈 시스템은 CommonJS(`require`)와 ESM(`"type": "module"` + `import`) 어느 쪽이든 같은 코드로 동작합니다.

## 설치

```bash
npm install @stingerloom/orm reflect-metadata express
npm install better-sqlite3   # 또는 pg / mysql2
```

## 빌드 도구에 맞는 엔티티 스타일 고르기

NestJS 밖에서 가장 자주 발목을 잡는 문제라 제일 먼저 짚고 갑니다.

데코레이터 스타일(`@Entity`, `@Column`)은 TypeScript의 `design:type` 메타데이터로 컬럼 타입을 추론합니다. 그런데 이 메타데이터는 `emitDecoratorMetadata` 옵션으로 컴파일할 때, 즉 `tsc`나 `ts-node`를 쓸 때만 생성됩니다. Express 프로젝트에서 개발용으로 흔히 쓰는 **tsx, esbuild, swc, Vite는 데코레이터 메타데이터를 만들지 않습니다.** 이런 도구로 실행하면 타입을 명시하지 않은 `@Column()`은 프로퍼티 타입을 알 길이 없어 `"text"` 컬럼이 되어 버리고, 아래와 같은 경고가 출력됩니다.

```
WARN [Column] No design:type metadata for User.name — falling back to "text". ...
```

해결 방법은 세 가지입니다.

1. **코드 우선 빌더를 씁니다(권장).** `defineEntity`는 컬럼 타입을 정의에 직접 들고 있어서 데코레이터 메타데이터도, `experimentalDecorators` 설정도, 특정 컴파일러도 필요 없습니다.

   ```typescript
   import { defineEntity, t, InferEntity } from "@stingerloom/orm";

   export const User = defineEntity("users", {
     id:      t.int().primary().generated(),
     name:    t.varchar(255),
     balance: t.int().default(0),
   });
   export type User = InferEntity<typeof User>;
   ```

2. **데코레이터를 유지하되 모든 컬럼에 타입을 명시합니다.** `@Column({ type: "int" })`처럼 타입을 적어 주면 추론할 것이 없으니 어떤 빌드 도구에서도 결과가 같습니다.

3. **데코레이터를 유지하고 `tsc` / `ts-node`로 빌드·실행합니다.** 추론에 필요한 메타데이터가 온전히 생성됩니다.

자세한 내용은 [엔티티 정의하기](./define-entity.md)와 [트러블슈팅](./troubleshooting.md)을 참고하세요.

## 부트스트랩

`EntityManager`는 프로세스 전체에서 하나만 만들고, 서버가 요청을 받기 시작하기 **전에** 등록을 마친 다음, 모든 모듈이 그 인스턴스를 공유하게 하세요.

```typescript
// db.ts
import "reflect-metadata"; // 프로세스에서 가장 먼저 import
import { EntityManager } from "@stingerloom/orm";

export const em = new EntityManager();

export async function initDb(): Promise<void> {
  await em.register({
    type: "sqlite",
    database: "app.db",
    entities: [User],
    synchronize: true, // 개발 전용 — 프로덕션에서는 마이그레이션을 쓰세요
  });
}
```

```typescript
// main.ts
import express from "express";
import { em, initDb } from "./db";
import { User } from "./user.entity";

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

::: warning 데이터베이스 하나에 EntityManager도 하나
연결 이름 없이 `register()`를 호출하면 프로세스 전역 레지스트리에 `"default"`라는 이름으로 연결이 등록됩니다. 이 상태에서 다른 `EntityManager`가 같은 이름으로 또 등록하면 기존 연결이 새 연결로 교체되는데, 첫 번째 매니저는 아무런 오류 없이 두 번째 데이터베이스로 쿼리를 보내게 됩니다. 이런 상황이 감지되면 ORM이 경고를 남깁니다.

```
WARN [DatabaseClient] Connection 'default' is already registered and will be replaced. ...
```

`EntityManager` 인스턴스는 하나만 만들어 모듈 간에 공유하세요. 한 프로세스에서 여러 데이터베이스를 써야 한다면 `em2.register(options, "analytics")`처럼 연결마다 다른 이름을 붙이면 됩니다.
:::

## 리포지토리

NestJS에서 쓰던 `@InjectRepository(User)`는 의존성 주입을 위한 편의 문법일 뿐입니다. 직접 가져오면 이렇게 됩니다.

```typescript
const userRepository = em.getRepository(User);

const users = await userRepository.find({ where: { name: "alice" } });
```

리포지토리는 `EntityManager`를 얇게 감싼 것이라 만들어 쓰는 비용이 사실상 없습니다. 필요한 곳에서 그때그때 꺼내 써도 되고, `db.ts`에서 `em`과 함께 export해 두어도 됩니다.

## 트랜잭션

`@Transactional()`은 NestJS 없이도 동작합니다. 활성 트랜잭션을 `AsyncLocalStorage`로 추적하기 때문에, Express 앱의 평범한 서비스 클래스에 붙여도 그대로 작동합니다.

```typescript
import { Transactional } from "@stingerloom/orm";

class TransferService {
  @Transactional()
  async transfer(fromId: number, toId: number, amount: number) {
    // 이 메서드 안의 em 호출은 전부 같은 트랜잭션으로 묶이고,
    // 에러가 던져지면 전체가 롤백됩니다
  }
}
```

데코레이터 없이 가고 싶다면 `em.transaction()`으로 같은 효과를 낼 수 있어요.

```typescript
await em.transaction(async (txEm) => {
  // 여기서 실행되는 txEm 호출은 모두 하나의 트랜잭션을 공유합니다
});
```

## 에러 처리

ORM이 던지는 에러는 전부 `OrmError`를 상속한 구체적인 에러 클래스입니다. Express 5는 async 핸들러에서 발생한 에러를 에러 미들웨어까지 알아서 전달해 주지만, Express 4에서는 `express-async-errors` 같은 래퍼가 필요합니다. 에러를 HTTP 응답으로 매핑하는 최소한의 미들웨어는 다음과 같습니다.

```typescript
import { OrmError, OrmErrorCode, EntityNotFoundError } from "@stingerloom/orm";
import { NextFunction, Request, Response } from "express";

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof EntityNotFoundError) {
    return res.status(404).json({ error: err.message });
  }
  if (err instanceof OrmError) {
    // err.code는 OrmErrorCode이고, err.suggestion에 해결 힌트가 담겨 오는 경우가 많습니다
    return res.status(500).json({ error: err.message, code: err.code });
  }
  return res.status(500).json({ error: "internal error" });
});
```

이런 미들웨어가 없으면 Express 기본 핸들러가 스택 트레이스가 그대로 담긴 HTML 페이지를 돌려줍니다. 개발 중에는 편하지만 운영 환경에 내보낼 응답은 아니죠.

## 안전한 종료

NestJS에서는 `app.enableShutdownHooks()`만 켜면 ORM의 종료 훅까지 알아서 호출됩니다. Express에서는 시그널 핸들러를 직접 등록하고 `propagateShutdown()`을 호출하세요. 플러그인 종료 훅을 실행한 뒤 열려 있는 연결을 모두 닫아 줍니다.

```typescript
const server = app.listen(3000);

async function shutdown() {
  server.close();
  await em.propagateShutdown({ closeConnections: true });
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
```

## 멀티테넌시 미들웨어

[멀티테넌시](./multi-tenancy.md) 컨텍스트는 순수 `AsyncLocalStorage` 기반이라, Express용 테넌트 미들웨어는 아래 몇 줄이면 충분합니다.

```typescript
import { MetadataContext } from "@stingerloom/orm";

app.use((req, _res, next) => {
  const tenantId = (req.headers["x-tenant-id"] as string) ?? "public";
  MetadataContext.run(tenantId, () => {
    next();
  });
});
```

이렇게 해 두면 요청 안에서 실행되는 모든 핸들러와 ORM 호출이 해당 테넌트의 컨텍스트에서 돌아가고, 테넌트가 다른 동시 요청끼리는 서로 격리됩니다.

## 개발 도구 참고 사항

- **tsx / nodemon의 재시작**은 걱정하지 않아도 됩니다. 메타데이터와 연결은 프로세스가 새로 뜰 때마다 다시 구성됩니다.
- **better-sqlite3는 네이티브 모듈입니다.** 업그레이드 직후 `new Database()`에서 프로세스가 죽는다면, 설치된 prebuilt 바이너리가 현재 Node.js 버전과 맞지 않는 경우입니다. `npm rebuild better-sqlite3`로 다시 빌드하거나, 사용 중인 Node 릴리스를 지원하는 메이저 버전으로 고정하세요.
- 마이그레이션 CLI(`npx stingerloom`)와 Prisma 임포터는 CommonJS로 실행되는 도구라서, 앱이 어떤 모듈 시스템을 쓰든 상관없이 동작합니다.
