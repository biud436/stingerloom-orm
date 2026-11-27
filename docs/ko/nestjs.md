# NestJS 통합

## NestJS 통합이 필요한 이유

NestJS는 의존성 주입(DI)으로 서비스를 연결합니다. `constructor(private readonly userService: UserService)`라고 쓰면 NestJS가 DI 컨테이너에서 `UserService`를 찾아 자동으로 주입합니다. 하지만 ORM의 EntityManager와 리포지토리는 기본적으로 NestJS 서비스가 아닙니다. 그래서 NestJS는 이 객체들을 어떻게 생성할지 판단하지 못합니다. 데이터베이스 연결을 언제 초기화하고 언제 종료할지도 판단하지 못합니다.

Stingerloom NestJS 통합 모듈은 세 가지 문제를 해결합니다.

1. **생명주기 관리**: NestJS가 시작할 때 EntityManager를 생성하고 데이터베이스에 연결합니다. 그리고 NestJS가 종료할 때 연결을 깔끔하게 정리합니다.
2. **리포지토리 주입**: 엔티티별 리포지토리를 NestJS provider로 등록합니다. 그래서 다른 서비스처럼 데코레이터 하나로 주입할 수 있습니다.
3. **멀티 데이터베이스 지원**: 여러 데이터베이스에 연결할 때 연결별 DI 토큰을 관리합니다. 그래서 각 리포지토리가 올바른 EntityManager에 연결됩니다.

## 설치

NestJS 통합은 subpath export로 제공됩니다. 별도 패키지를 설치할 필요가 없습니다.

```typescript
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
```

---

## 빠른 시작

### 1단계: forRoot()로 모듈 등록하기

루트 `AppModule`에서 `forRoot()`를 호출합니다. 데이터베이스 연결은 여기서 맺어집니다.

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

NestJS가 `StingerloomOrmModule.forRoot(options)`를 처리할 때 네 가지 일이 일어납니다.

1. **EntityManager 생성**: 새 `EntityManager` 인스턴스를 만듭니다.
2. **`em.register(options)` 호출**: 데이터베이스에 연결하고 엔티티를 스캔합니다. 그리고 옵션에 따라 스키마를 동기화합니다. 이 호출은 NestJS factory provider 안에서 실행되므로 모듈을 초기화할 때 동작합니다.
3. **EntityManager를 global provider로 등록**: `EntityManager` 인스턴스가 NestJS DI 컨테이너에 특정 토큰으로 등록됩니다. 모듈에 `global: true`가 설정되어 있으므로 다른 모듈에서 다시 import하지 않아도 어디서든 쓸 수 있습니다.
4. **StingerloomOrmService 생성**: 이 서비스는 EntityManager를 감싸고 NestJS 생명주기 훅을 구현합니다. `OnModuleInit`에서 초기화하고 `OnApplicationShutdown`에서 `propagateShutdown()`을 호출해 연결과 리소스를 정리합니다.

핵심은 `forRoot()`를 데이터베이스 연결마다 한 번만 루트 모듈에서 호출해야 한다는 점입니다.

### 2단계: forFeature()로 기능 모듈에 엔티티 등록하기

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

NestJS가 `StingerloomOrmModule.forFeature([Cat])`를 처리하면 엔티티마다 provider를 만듭니다.

1. **고유 DI 토큰 생성**: `Cat`의 토큰은 `Symbol("INJECT_REPOSITORIES_TOKEN_Cat")` 같은 Symbol입니다. 이 토큰은 엔티티 클래스를 키로 하는 WeakMap에 캐시됩니다. 그래서 여러 모듈에서 `forFeature([Cat])`을 호출해도 항상 같은 토큰을 씁니다.
2. **factory provider 생성**: `forRoot()`에서 등록한 EntityManager를 받아 `em.getRepository(Cat)`로 `BaseRepository<Cat>`을 얻습니다.
3. **provider export**: 해당 모듈의 서비스와 컨트롤러에서 주입할 수 있도록 provider를 export합니다.

그 결과 NestJS는 생성자에서 `@InjectRepository(Cat)`을 만나면 어떤 토큰을 조회해서 어떤 `BaseRepository<Cat>` 인스턴스를 주입할지 정확히 판단합니다.

설정이 잘못되면 모듈을 초기화할 때 바로 실패합니다. 이때 Nest의 막연한 `can't resolve dependencies (?)` 대신 해결 방법을 알려 주는 에러가 납니다.

- `forFeature()`의 `connectionName`에 오타가 있으면 `OrmError`를 던집니다. 이 에러에는 `forRoot()`/`forRootAsync()`가 실제로 등록한 연결 목록과 가장 가까운 이름 제안이 담깁니다.
- 해당 연결의 `entities` 배열에 없는 엔티티를 쓰면 연결 이름을 밝힌 `EntityMetadataNotFoundError`를 던집니다.
- 맞는 `forFeature()`를 import하지 않고 리포지토리를 주입하면 토큰의 Symbol description이 추가해야 할 `forFeature([...])` 호출을 알려 줍니다.

### 3단계: 서비스에 주입하기

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

## 데코레이터

### @InjectRepository(Entity, connectionName?)

지정한 엔티티의 `BaseRepository<T>`를 주입합니다.

```typescript
@InjectRepository(Cat)
private readonly catRepo: BaseRepository<Cat>;
```

#### 이 데코레이터가 필요한 이유

NestJS에서 생성자 주입은 파라미터 타입을 DI 토큰과 매칭해서 동작합니다. 하지만 `BaseRepository<Cat>`과 `BaseRepository<Dog>`는 런타임에 같은 타입입니다. TypeScript 제네릭은 런타임에 지워지기 때문입니다. 그래서 NestJS는 둘을 구분할 방법이 없습니다.

`@InjectRepository(Cat)`은 생성자 파라미터에 고유한 DI 토큰(Symbol)을 붙여서 이 문제를 해결합니다. 토큰은 엔티티 클래스에서 만들어집니다. 그래서 `@InjectRepository(Cat)`과 `@InjectRepository(Dog)`는 서로 다른 토큰을 생성하고 NestJS는 각각 올바른 리포지토리를 주입할 수 있습니다.

`@InjectRepository(Cat)`은 내부적으로 `@Inject(Symbol("INJECT_REPOSITORIES_TOKEN_Cat"))`과 같습니다. 이 데코레이터 덕분에 토큰을 직접 관리하지 않아도 됩니다.

`BaseRepository`가 제공하는 메서드는 `find`, `findOne`, `findWithCursor`, `findAndCount`, `save`, `delete`, `softDelete`, `restore`, `insertMany`, `insertManyAndReturn`, `deleteMany`, `count`, `sum`, `avg`, `min`, `max`, `explain`, `upsert`, `stream`, `createQueryBuilder` 등입니다.

### @InjectEntityManager(connectionName?)

`EntityManager`를 직접 주입합니다. raw 쿼리, 트랜잭션, 구독자처럼 리포지토리가 제공하지 않는 기능이 필요할 때 쓰세요.

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

## 생명주기 관리

`StingerloomOrmService`는 NestJS 훅으로 EntityManager의 생명주기를 자동으로 관리합니다.

- **OnModuleInit**: EntityManager를 내부 레지스트리에 등록하고 초기화 로그를 남깁니다.
- **OnApplicationShutdown**: `closeConnections: true`로 ORM을 종료합니다. 이 모듈이 등록한 연결 풀을 닫습니다. 그리고 이벤트 리스너를 제거하고 엔티티 구독자를 정리합니다. QueryTracker를 중지하고 플러그인을 설치의 역순으로 종료합니다.

닫히는 풀은 이 모듈의 `connectionName`으로 등록된 풀뿐입니다. 그래서 멀티 데이터베이스 앱에서는 각 `forRoot()`가 자기 연결만 반납하고 다른 연결은 건드리지 않습니다. `tenantStrategy: "database"`에서는 종료가 `MultiTenantEntityManager`를 거칩니다. 그리고 라우터가 프로비저닝한 테넌트 풀이 admin 풀과 함께 모두 닫힙니다. 테넌트 매니저는 `MultiTenantEntityManager`를 거쳐야만 접근할 수 있기 때문입니다. `Stingerloom ORM disconnected (connection "...")` 로그는 실제로 닫힌 뒤에만 남습니다. 종료가 실패하면 에러 로그를 남긴 뒤 에러가 `app.close()`로 전파됩니다.

> 코어 API인 `em.propagateShutdown()`의 기본값은 `closeConnections: false`입니다. 라이브러리를 쓰는 쪽에서 EntityManager만 정리하고 풀은 계속 쓸 수도 있기 때문입니다. NestJS 통합에서는 `true`를 넘깁니다. 모듈이 자기가 등록한 풀을 소유하고 있고 애플리케이션이 종료되는 시점이기 때문입니다.

`@nestjs/testing`과 대부분의 통합 테스트가 호출하는 `app.close()`는 이 훅을 자동으로 실행합니다. 쿠버네티스의 SIGTERM이나 개발 중의 Ctrl-C처럼 시그널로 종료되는 경우까지 처리하려면 `main.ts`에서 훅을 켜세요.

```typescript
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks(); // SIGTERM/SIGINT가 onApplicationShutdown()까지 도달하게 함
  await app.listen(3000);
}
bootstrap();
```

`enableShutdownHooks()`가 없으면 시그널은 `onApplicationShutdown()`을 실행하지 않고 프로세스를 종료합니다. 그래서 풀이 닫히지 않습니다. 데이터베이스는 버려진 연결이 타임아웃될 때에야 이 사실을 알아차립니다.

---

## 멀티 DB 연결

### 멀티 DB가 필요한 경우

사용자 데이터와 비즈니스 데이터는 MySQL에, 분석 이벤트는 PostgreSQL에 저장한다고 해 봅시다. 감사 로그는 컴플라이언스 때문에 별도 데이터베이스에 저장할 수도 있습니다. 이때 데이터베이스마다 EntityManager, 연결, 리포지토리가 따로 필요합니다.

DI 프레임워크에서는 문제가 하나 생깁니다. 서비스가 `BaseRepository<Event>`를 요청하면 NestJS는 어느 데이터베이스의 리포지토리를 주입해야 할까요? 답은 **token scoping**입니다. 연결마다 고유한 DI 토큰 세트를 둡니다.

### token scoping 동작 원리

`forRoot(options, "analytics")`를 호출하면 EntityManager는 기본 `EntityManager` 클래스 토큰 대신 `"STINGERLOOM_ENTITY_MANAGER_analytics"` 토큰으로 생성됩니다. `forFeature([Event], "analytics")`를 호출하면 Event의 리포지토리는 `Symbol("INJECT_REPOSITORIES_TOKEN_Event")` 대신 `Symbol("INJECT_REPOSITORIES_TOKEN_Event_analytics")`로 등록됩니다.

그래서 연결 이름이 없는 `@InjectRepository(Event)`와 `@InjectRepository(Event, "analytics")`는 같은 엔티티 클래스라도 완전히 다른 provider로 해석됩니다.

### 설정

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

### 기능 모듈

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

### 이름 있는 연결 주입하기

데코레이터의 두 번째 인자로 연결 이름을 전달합니다.

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

연결 이름을 생략하면 항상 `"default"` 연결을 사용합니다. 그래서 기존의 단일 데이터베이스 앱은 코드를 바꾸지 않아도 그대로 동작합니다.

---

## 이벤트 구독자 등록하기

`EntitySubscriber` 인스턴스는 모듈을 초기화할 때 등록합니다.

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

이 서비스를 주입하면 EntityManager에 직접 접근할 수 있습니다.

```typescript
@Inject(StingerloomOrmService)
private readonly ormService: StingerloomOrmService;

// Access EntityManager
const em = ormService.getEntityManager();

// Get any repository
const repo = ormService.getRepository(User);
```

---

## 내보내는 API

모든 항목은 `@stingerloom/orm/nestjs`에서 import합니다.

| Export | Description |
|--------|-------------|
| `StingerloomOrmModule` | `forRoot()`과 `forFeature()`를 제공하는 메인 모듈 |
| `StingerloomOrmService` | EntityManager 생명주기를 관리하는 서비스 |
| `InjectRepository` | 리포지토리 주입 데코레이터 |
| `InjectEntityManager` | EntityManager 주입 데코레이터 |
| `getEntityManagerToken(name?)` | 수동 DI용 토큰 헬퍼 |
| `getOrmServiceToken(name?)` | 서비스 주입용 토큰 헬퍼 |
| `makeInjectRepositoryToken(entity, name?)` | 리포지토리 provider용 토큰 헬퍼 |

## 다음 단계

- [EntityManager](./entity-manager.md): 전체 CRUD API 레퍼런스
- [Events & Subscribers](./events.md): EntitySubscriber 패턴 자세히 보기
- [Configuration](./configuration.md): 연결 풀, 읽기 레플리카 등
- [Multi-Tenancy](./multi-tenancy.md): NestJS에서 테넌트별 스키마 격리
