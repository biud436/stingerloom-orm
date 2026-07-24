# Express에서 사용하기

Stingerloom ORM은 특정 프레임워크에 묶여 있지 않습니다. NestJS 통합에서 쓰는 `EntityManager`가 다른 어디에서나 그대로 쓰는 클래스이고, NestJS 모듈은 그 위에 얹힌 얇은 의존성 주입 래퍼일 뿐입니다. 이 가이드는 그 래퍼가 해주던 일을 순수 [Express](https://expressjs.com/) 애플리케이션에서 어떻게 대체하는지 패턴별로 보여줍니다. Fastify, Koa, Hono 등 다른 Node.js 서버에도 같은 패턴이 적용됩니다.

CommonJS 프로젝트(`require`)와 ESM 프로젝트(`"type": "module"` + `import`) 모두 같은 코드로 동작합니다.

## 설치

```bash
npm install @stingerloom/orm reflect-metadata express
npm install better-sqlite3   # 또는 pg / mysql2
```

## 빌드 도구에 맞는 엔티티 스타일 선택

NestJS 밖에서 가장 자주 겪는 문제라 제일 먼저 다룹니다.

데코레이터 스타일(`@Entity`, `@Column`)은 TypeScript의 `design:type` 메타데이터로 컬럼 타입을 추론하는데, 이 메타데이터는 `emitDecoratorMetadata`로 컴파일할 때 — 즉 `tsc`나 `ts-node`를 쓸 때만 존재합니다. Express 프로젝트가 개발용으로 흔히 쓰는 **tsx, esbuild, swc, Vite는 데코레이터 메타데이터를 만들어주지 않습니다.** 이런 도구에서는 타입을 지정하지 않은 `@Column()`이 프로퍼티 타입을 알 수 없어 `"text"`로 강등되고, 다음과 같은 경고가 출력됩니다.

```
WARN [Column] No design:type metadata for User.name — falling back to "text". ...
```

확실한 선택지는 세 가지입니다.

1. **코드 우선 빌더를 사용합니다(권장).** `defineEntity`는 컬럼 타입을 스스로 가지고 있어서 데코레이터 메타데이터도, `experimentalDecorators`도, 특정 컴파일러도 필요 없습니다.

   ```typescript
   import { defineEntity, t, InferEntity } from "@stingerloom/orm";

   export const User = defineEntity("users", {
     id:      t.int().primary().generated(),
     name:    t.varchar(255),
     balance: t.int().default(0),
   });
   export type User = InferEntity<typeof User>;
   ```

2. **데코레이터를 유지하되 모든 컬럼에 타입을 명시합니다.** `@Column({ type: "int" })`은 추론이 필요 없으므로 어떤 빌드 도구에서도 동일하게 동작합니다.

3. **데코레이터를 유지하고 `tsc` / `ts-node`로 빌드·실행합니다.** 추론에 필요한 메타데이터가 정상적으로 생성됩니다.

자세한 내용은 [엔티티 정의하기](./define-entity.md)와 [트러블슈팅](./troubleshooting.md)을 참고하세요.

## 부트스트랩

프로세스 전체에서 `EntityManager`를 하나만 만들고, 서버가 트래픽을 받기 **전에** 등록을 끝낸 뒤 모듈 간에 공유합니다.

```typescript
// db.ts
import "reflect-metadata"; // 프로세스의 첫 import
import { EntityManager } from "@stingerloom/orm";

export const em = new EntityManager();

export async function initDb(): Promise<void> {
  await em.register({
    type: "sqlite",
    database: "app.db",
    entities: [User],
    synchronize: true, // 개발 전용 — 프로덕션에서는 마이그레이션 사용
  });
}
```

```typescript
// main.ts
import express from "express";
import { em, initDb } from "./db";
import { User } from "./user.entity";

async function main() {
  await initDb(); // 이보다 먼저 도착한 요청은 DatabaseNotConnectedError로 실패합니다

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

::: warning 데이터베이스당 EntityManager는 하나
연결 이름 없이 `register()`를 호출하면 프로세스 전역 레지스트리에 `"default"` 연결이 등록됩니다. 두 번째 `EntityManager`가 같은 이름으로 등록하면 그 연결이 교체되고, 첫 번째 매니저는 아무 오류 없이 두 번째 데이터베이스를 조회하게 됩니다. 이런 상황이 생기면 ORM이 경고를 남깁니다.

```
WARN [DatabaseClient] Connection 'default' is already registered and will be replaced. ...
```

`EntityManager` 인스턴스 하나를 모듈 간에 공유하세요. 한 프로세스에서 여러 데이터베이스가 정말 필요하다면 각각 다른 이름을 붙이면 됩니다: `em2.register(options, "analytics")`.
:::

## 리포지토리

`@InjectRepository(User)`는 NestJS DI 문법 설탕입니다. 직접 쓰면 이렇게 됩니다.

```typescript
const userRepository = em.getRepository(User);

const users = await userRepository.find({ where: { name: "alice" } });
```

리포지토리는 `EntityManager` 위의 가벼운 뷰라서 필요한 곳에서 그때그때 가져와도 되고, `db.ts`에서 `em`과 함께 export해도 됩니다.

## 트랜잭션

`@Transactional()`은 NestJS에 의존하지 않습니다. 활성 트랜잭션을 `AsyncLocalStorage`로 추적하므로 Express 앱의 평범한 서비스 클래스에서도 그대로 동작합니다.

```typescript
import { Transactional } from "@stingerloom/orm";

class TransferService {
  @Transactional()
  async transfer(fromId: number, toId: number, amount: number) {
    // 이 안의 모든 em 호출은 같은 트랜잭션에 참여하고,
    // 에러가 던져지면 전체가 롤백됩니다
  }
}
```

데코레이터 없이 쓰고 싶다면 `em.transaction()`이 같은 보장을 함수 형태로 제공해요.

```typescript
await em.transaction(async (txEm) => {
  // 여기서의 모든 txEm 호출은 하나의 트랜잭션을 공유합니다
});
```

## 에러 처리

ORM은 타입이 있는 에러(`OrmError` 하위 클래스)를 던집니다. Express 5는 async 핸들러의 rejection을 에러 미들웨어로 자동 전달하지만, Express 4에서는 `express-async-errors` 같은 래퍼가 필요합니다. 최소한의 매핑 미들웨어는 다음과 같습니다.

```typescript
import { OrmError, OrmErrorCode, EntityNotFoundError } from "@stingerloom/orm";
import { NextFunction, Request, Response } from "express";

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof EntityNotFoundError) {
    return res.status(404).json({ error: err.message });
  }
  if (err instanceof OrmError) {
    // err.code는 OrmErrorCode이고, err.suggestion에 해결 힌트가 담기는 경우가 많습니다
    return res.status(500).json({ error: err.message, code: err.code });
  }
  return res.status(500).json({ error: "internal error" });
});
```

이런 미들웨어가 없으면 Express 기본 핸들러가 스택 트레이스가 포함된 HTML 페이지를 반환합니다. 개발 중에는 괜찮지만 그대로 배포할 것은 아닙니다.

## 우아한 종료

NestJS에서는 `app.enableShutdownHooks()`가 ORM의 종료 훅을 불러줍니다. Express에서는 시그널 핸들러를 직접 연결하고 `propagateShutdown()`을 호출하세요. 플러그인 종료 훅을 실행하고 모든 연결을 닫아줍니다.

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

[멀티테넌시](./multi-tenancy.md) 컨텍스트는 순수 `AsyncLocalStorage`라서, Express용 테넌트 미들웨어는 이게 전부입니다.

```typescript
import { MetadataContext } from "@stingerloom/orm";

app.use((req, _res, next) => {
  const tenantId = (req.headers["x-tenant-id"] as string) ?? "public";
  MetadataContext.run(tenantId, () => {
    next();
  });
});
```

이후 요청의 모든 핸들러와 ORM 호출이 해당 테넌트 컨텍스트에서 실행되고, 서로 다른 테넌트의 동시 요청은 격리된 상태를 유지합니다.

## 개발 도구 관련 메모

- **tsx / nodemon 재시작**은 안전합니다. 메타데이터와 연결은 프로세스가 시작될 때마다 새로 구성됩니다.
- **better-sqlite3는 네이티브 모듈입니다.** 업그레이드 직후 `new Database()`에서 프로세스가 죽는다면 설치된 prebuilt 바이너리가 Node.js 버전과 맞지 않는 것입니다. 재설치(`npm rebuild better-sqlite3`)하거나 사용 중인 Node 릴리스를 지원하는 메이저 버전으로 고정하세요.
- 마이그레이션 CLI(`npx stingerloom`)와 Prisma 임포터는 CommonJS 도구로 실행되므로 앱의 모듈 시스템과 무관하게 동작합니다.
