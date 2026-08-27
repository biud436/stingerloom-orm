# NestJS Integration

## NestJS 통합이 필요한 이유

NestJS는 의존성 주입(DI)으로 서비스를 연결해요. `constructor(private readonly userService: UserService)`라고 쓰면, NestJS가 DI 컨테이너에서 `UserService`를 찾아서 자동으로 주입해줘요. 하지만 ORM의 EntityManager나 Repository는 기본적으로 NestJS 서비스가 아니라서, NestJS가 이들을 어떻게 생성하고 언제 DB 연결을 초기화하고 종료해야 하는지 알 수 없어요.

Stingerloom NestJS 통합 모듈은 세 가지 문제를 해결해요:

1. **라이프사이클 관리** -- NestJS 시작 시 EntityManager를 생성하고 DB 연결을 수립하며, 종료 시 깔끔하게 정리해요.
2. **Repository 주입** -- 엔티티별 Repository를 NestJS provider로 등록해서, 데코레이터 하나로 주입할 수 있어요.
3. **멀티 DB 지원** -- 여러 데이터베이스에 연결할 때 각 Repository가 올바른 EntityManager에 연결되도록 scoped DI 토큰을 관리해요.

## Installation

NestJS 통합은 subpath export로 제공돼요. 별도 패키지 설치가 필요 없어요.

```typescript
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
```

---

## Quick Start

### Step 1: forRoot()으로 모듈 등록하기

루트 `AppModule`에서 `forRoot()`을 호출해요. DB 연결이 여기서 수립돼요.

```typescript
// app.module.ts
import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { CatsModule } from "./cats/cats.module";
import { Cat } from "./entities/cat.entity";

@Module({
  imports: [
    StingerloomOrmModule.forRoot({
      type: "mysql",
      host: "localhost",
      port: 3306,
      username: "root",
      password: "password",
      database: "mydb",
      entities: [Cat],
      synchronize: true, // Development only
    }),
    CatsModule,
  ],
})
export class AppModule {}
```

#### forRoot() 내부 동작

`StingerloomOrmModule.forRoot(options)`이 처리될 때 네 가지 일이 일어나요:

1. **EntityManager 생성** -- 새 `EntityManager` 인스턴스를 만들어요.
2. **`em.register(options)` 호출** -- DB에 연결하고, 엔티티를 스캔하고, 옵션에 따라 스키마를 동기화해요. NestJS factory provider 안에서 실행되기 때문에 모듈 초기화 시점에 동작해요.
3. **EntityManager를 global provider로 등록** -- NestJS DI 컨테이너에 특정 토큰으로 등록돼요. `global: true`로 설정되어 있어서, 다른 모듈에서 다시 import하지 않아도 어디서든 사용할 수 있어요.
4. **StingerloomOrmService 생성** -- EntityManager를 감싸고, NestJS 라이프사이클 훅을 구현해요: `OnModuleInit`으로 초기화하고 `OnApplicationShutdown`으로 `propagateShutdown()`을 호출해서 연결을 정리해요.

핵심 포인트: `forRoot()`는 DB 연결당 **한 번만** 루트 모듈에서 호출해야 해요.

### Step 2: forFeature()로 Feature Module에 엔티티 등록하기

```typescript
// cats.module.ts
import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { Cat } from "../entities/cat.entity";
import { CatsService } from "./cats.service";
import { CatsController } from "./cats.controller";

@Module({
  imports: [StingerloomOrmModule.forFeature([Cat])],
  providers: [CatsService],
  controllers: [CatsController],
})
export class CatsModule {}
```

#### forFeature() 내부 동작

`StingerloomOrmModule.forFeature([Cat])`이 처리되면 각 엔티티에 대해 provider를 만들어요:

1. **고유 DI 토큰 생성** -- `Symbol("INJECT_REPOSITORIES_TOKEN_Cat")` 같은 Symbol이에요. 엔티티 클래스를 키로 하는 WeakMap에 캐시되기 때문에, 여러 모듈에서 `forFeature([Cat])`을 호출해도 항상 같은 토큰을 사용해요.
2. **factory provider 생성** -- `forRoot()`에서 등록된 EntityManager를 받아서 `em.getRepository(Cat)`으로 `BaseRepository<Cat>`을 가져와요.
3. **provider export** -- 해당 모듈의 서비스와 컨트롤러에서 주입할 수 있도록 export해요.

결과적으로 NestJS가 생성자에서 `@InjectRepository(Cat)`을 만나면, 어떤 토큰을 조회해서 어떤 `BaseRepository<Cat>` 인스턴스를 주입할지 정확히 알 수 있어요.

설정 실수는 Nest의 막연한 `can't resolve dependencies (?)` 대신 모듈 초기화 시점에 실행 가능한 에러로 바로 실패합니다. `forFeature()`의 `connectionName` 오타는 `forRoot()`/`forRootAsync()`가 실제로 등록한 연결 목록과 가장 가까운 이름 제안을 담은 `OrmError`를 던지고, 해당 연결의 `entities` 배열에 없는 엔티티는 연결 이름을 명시한 `EntityMetadataNotFoundError`를 던집니다. `forFeature()`를 임포트하지 않고 리포지토리를 주입하면, 토큰의 Symbol description 자체가 추가해야 할 `forFeature([...])` 호출을 알려줍니다.

### Step 3: 서비스에 주입하기

```typescript
// cats.service.ts
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { BaseRepository } from "@stingerloom/orm";
import { Cat } from "../entities/cat.entity";

@Injectable()
export class CatsService {
  constructor(
    @InjectRepository(Cat)
    private readonly catRepo: BaseRepository<Cat>,
  ) {}

  async findAll() {
    return this.catRepo.find();
  }

  async findOne(id: number) {
    return this.catRepo.findOne({ where: { id } as any });
  }

  async create(data: Partial<Cat>) {
    return this.catRepo.save(data);
  }

  async remove(id: number) {
    return this.catRepo.delete({ id });
  }
}
```

---

## Decorators

### @InjectRepository(Entity, connectionName?)

지정한 엔티티의 `BaseRepository<T>`를 주입해요.

```typescript
@InjectRepository(Cat)
private readonly catRepo: BaseRepository<Cat>;
```

#### 이 데코레이터가 필요한 이유

NestJS에서 생성자 주입은 파라미터 타입을 DI 토큰과 매칭시켜 동작해요. 하지만 `BaseRepository<Cat>`과 `BaseRepository<Dog>`는 런타임에서 같은 타입이에요 -- TypeScript 제네릭은 런타임에 지워지거든요. NestJS가 둘을 구분할 방법이 없어요.

`@InjectRepository(Cat)`은 생성자 파라미터에 고유한 DI 토큰(Symbol)을 부착해서 이 문제를 해결해요. 토큰이 엔티티 클래스에서 파생되기 때문에 `@InjectRepository(Cat)`과 `@InjectRepository(Dog)`는 서로 다른 토큰을 생성하고, NestJS가 올바른 Repository를 주입할 수 있어요.

내부적으로 `@InjectRepository(Cat)`은 `@Inject(Symbol("INJECT_REPOSITORIES_TOKEN_Cat"))`과 동일해요. 토큰을 수동으로 관리하지 않아도 되도록 데코레이터가 존재하는 거예요.

`BaseRepository`가 제공하는 메서드: `find`, `findOne`, `findWithCursor`, `findAndCount`, `save`, `delete`, `softDelete`, `restore`, `insertMany`, `insertManyAndReturn`, `deleteMany`, `count`, `sum`, `avg`, `min`, `max`, `explain`, `upsert`, `stream`, `createQueryBuilder` 등.

### @InjectEntityManager(connectionName?)

`EntityManager`를 직접 주입해요. Repository가 제공하지 않는 기능이 필요할 때 사용해요 -- raw query, 트랜잭션, subscriber 등.

```typescript
import { InjectEntityManager } from "@stingerloom/orm/nestjs";
import { EntityManager } from "@stingerloom/orm";

@Injectable()
export class CatsService {
  constructor(
    @InjectEntityManager()
    private readonly em: EntityManager,
  ) {}

  async complexQuery() {
    return this.em.query<{ count: number }>(
      "SELECT COUNT(*) as count FROM cat WHERE age > ?",
      [5],
    );
  }

  async transferWithTransaction(fromId: number, toId: number) {
    return this.em.transaction(async (txEm) => {
      // ... transactional operations
    });
  }
}
```

---

## Lifecycle Management

`StingerloomOrmService`가 NestJS 훅을 통해 EntityManager 라이프사이클을 자동으로 관리해요:

- **OnModuleInit** -- EntityManager를 내부 레지스트리에 등록하고 초기화 로그를 남겨요.
- **OnApplicationShutdown** -- `closeConnections: true`로 ORM을 종료합니다. 이 모듈이 등록한 커넥션 풀을 닫고, 이벤트 리스너 제거, 엔티티 subscriber 정리, QueryTracker 중지, 플러그인 역순 종료를 수행해요.

닫히는 것은 이 모듈의 `connectionName`으로 등록된 풀뿐이라, 멀티 DB 앱에서는 각 `forRoot()`가 자기 커넥션만 반납하고 다른 커넥션은 건드리지 않습니다. `tenantStrategy: "database"`에서는 종료가 `MultiTenantEntityManager`를 거칩니다. 라우터가 프로비저닝한 테넌트 풀 전체가 admin 풀과 함께 닫혀요 — 테넌트 매니저는 MTEM 외에는 어디서도 접근할 수 없기 때문입니다. `Stingerloom ORM disconnected (connection "...")` 로그는 실제로 닫힌 뒤에만 남고, 종료가 실패하면 에러 로그를 남긴 뒤 `app.close()`로 전파됩니다.

> 코어 API인 `em.propagateShutdown()`의 기본값은 `closeConnections: false`예요. 라이브러리 사용자가 EntityManager만 정리하고 풀은 계속 쓸 수 있기 때문입니다. NestJS 통합에서는 모듈이 자기가 등록한 풀의 소유자이고 애플리케이션이 내려가는 시점이므로 `true`를 넘깁니다.

`app.close()`(`@nestjs/testing`과 대부분의 통합 테스트가 호출하는 경로)는 이 훅을 알아서 실행합니다. 시그널로 내려가는 종료(쿠버네티스의 SIGTERM, 개발 중 Ctrl-C)까지 처리하려면 `main.ts`에서 훅을 켜세요:

```typescript
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks(); // SIGTERM/SIGINT가 onApplicationShutdown()까지 도달하게 함
  await app.listen(3000);
}
bootstrap();
```

`enableShutdownHooks()`가 없으면 시그널이 `onApplicationShutdown()` 없이 프로세스를 죽이기 때문에 풀을 닫는 주체가 사라집니다. DB 쪽은 버려진 커넥션이 타임아웃될 때에야 알아차려요.

---

## Multi-Database Connections

### 멀티 DB가 필요한 경우

사용자/비즈니스 데이터는 MySQL에, 분석 이벤트는 PostgreSQL에, 감사 로그는 컴플라이언스를 위해 별도 DB에 저장하는 경우가 있어요. 각 DB마다 별도의 EntityManager, 연결, Repository 세트가 필요해요.

DI 프레임워크에서의 문제: 서비스가 `BaseRepository<Event>`를 요청할 때, NestJS는 어떤 DB에서 가져와야 하는지 어떻게 알 수 있을까요? 답은 **token scoping**이에요 -- 연결마다 고유한 DI 토큰 세트를 가져요.

### Token scoping 동작 원리

`forRoot(options, "analytics")`를 호출하면, EntityManager가 기본 `EntityManager` 클래스 토큰 대신 `"STINGERLOOM_ENTITY_MANAGER_analytics"` 토큰으로 생성돼요. `forFeature([Event], "analytics")`를 호출하면, Event의 Repository가 `Symbol("INJECT_REPOSITORIES_TOKEN_Event")` 대신 `Symbol("INJECT_REPOSITORIES_TOKEN_Event_analytics")`로 등록돼요.

따라서 `@InjectRepository(Event)`(connection name 없음)과 `@InjectRepository(Event, "analytics")`는 같은 엔티티 클래스라도 완전히 다른 provider로 resolve돼요.

### Setup

```typescript
// app.module.ts
@Module({
  imports: [
    // Default connection (MySQL)
    StingerloomOrmModule.forRoot({
      type: "mysql",
      host: "localhost",
      database: "main_db",
      entities: [User, Post],
      // ...
    }),

    // Named connection (PostgreSQL)
    StingerloomOrmModule.forRoot(
      {
        type: "postgres",
        host: "analytics-db.example.com",
        database: "analytics",
        entities: [Event, Metric],
        // ...
      },
      "analytics",  // connection name
    ),

    UsersModule,
    AnalyticsModule,
  ],
})
export class AppModule {}
```

### Feature Modules

```typescript
// analytics.module.ts
@Module({
  imports: [
    StingerloomOrmModule.forFeature([Event, Metric], "analytics"),
  ],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
```

### Named Connection 주입하기

데코레이터의 두 번째 인자로 connection name을 전달해요:

```typescript
// analytics.service.ts
@Injectable()
export class AnalyticsService {
  constructor(
    @InjectRepository(Event, "analytics")
    private readonly eventRepo: BaseRepository<Event>,

    @InjectEntityManager("analytics")
    private readonly analyticsEm: EntityManager,
  ) {}
}
```

connection name을 생략하면 항상 `"default"` 연결을 사용해요. 기존 단일 DB 앱은 코드 변경 없이 그대로 동작해요.

---

## Event Subscriber 등록하기

모듈 초기화 시점에 `EntitySubscriber` 인스턴스를 등록해요:

```typescript
import { Injectable, OnModuleInit, Inject } from "@nestjs/common";
import { StingerloomOrmService } from "@stingerloom/orm/nestjs";

@Injectable()
export class CatsSubscriberService implements OnModuleInit {
  constructor(
    @Inject(StingerloomOrmService)
    private readonly ormService: StingerloomOrmService,
  ) {}

  onModuleInit() {
    const em = this.ormService.getEntityManager();
    em.addSubscriber(new CatAuditSubscriber());
  }
}
```

---

## StingerloomOrmService

이 서비스를 주입해서 EntityManager에 직접 접근할 수 있어요:

```typescript
@Inject(StingerloomOrmService)
private readonly ormService: StingerloomOrmService;

// Access EntityManager
const em = ormService.getEntityManager();

// Get any repository
const repo = ormService.getRepository(User);
```

---

## Exported API

모든 항목은 `@stingerloom/orm/nestjs`에서 import해요:

| Export | Description |
|--------|-------------|
| `StingerloomOrmModule` | `forRoot()`과 `forFeature()`를 제공하는 메인 모듈 |
| `StingerloomOrmService` | EntityManager 라이프사이클을 관리하는 서비스 |
| `InjectRepository` | Repository 주입 데코레이터 |
| `InjectEntityManager` | EntityManager 주입 데코레이터 |
| `getEntityManagerToken(name?)` | 수동 DI용 토큰 헬퍼 |
| `getOrmServiceToken(name?)` | 서비스 주입용 토큰 헬퍼 |
| `makeInjectRepositoryToken(entity, name?)` | Repository provider용 토큰 헬퍼 |

## Next Steps

- [EntityManager](./entity-manager.md) -- Full CRUD API reference
- [Events & Subscribers](./events.md) -- EntitySubscriber pattern in detail
- [Configuration](./configuration.md) -- Connection pooling, read replicas, and more
- [Multi-Tenancy](./multi-tenancy.md) -- Per-tenant schema isolation with NestJS
