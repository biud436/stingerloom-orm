# 시작하기

이 가이드에서는 Stingerloom ORM을 설치하고, 첫 번째 엔티티를 정의하고, CRUD(생성/조회/수정/삭제) 작업을 단계별로 수행하는 방법을 안내합니다. 약 5분이면 충분합니다.

## ORM이란?

웹 애플리케이션을 작성할 때, 데이터는 두 가지 전혀 다른 세계에 존재합니다. TypeScript 코드에서 데이터는 **객체** — 프로퍼티와 메서드를 가진 클래스 — 로 존재합니다. 데이터베이스에서 데이터는 **테이블** — 행과 열로 이루어진 원시 값 — 로 존재합니다.

ORM(Object-Relational Mapper)은 이 두 세계 사이의 번역 레이어입니다. SQL 문자열을 직접 작성하는 대신, TypeScript 클래스를 정의하면 ORM이 테이블 생성, 행 삽입, 데이터 조회를 알아서 처리하고 타입이 지정된 객체를 반환합니다.

범용 번역기라고 생각하면 됩니다. 여러분은 TypeScript를 말하고, 데이터베이스는 SQL을 말하며, ORM이 그 사이의 모든 대화를 번역합니다.

ORM 없이:

```typescript
// SQL 문자열을 직접 작성하고, 타입 없는 행을 받음
const result = await pool.query('SELECT * FROM "user" WHERE "id" = $1', [1]);
const user = result.rows[0]; // { id: 1, name: "Alice" } -- 타입 안전성 없음
```

ORM 사용:

```typescript
// 타입이 지정된 객체로 작업하고, ORM이 SQL을 작성
const user = await em.findOne(User, { where: { id: 1 } });
// user는 User | null -- 완전한 타입 안전성, 프로퍼티 자동 완성
```

ORM은 양방향 번역을 처리합니다: 클래스 정의는 `CREATE TABLE`문이 되고, `save()` 호출은 `INSERT`가 되며, `find()` 호출은 `SELECT`가 됩니다. 이 가이드에서 각 작업의 정확한 SQL을 확인할 수 있습니다.

## 사전 요구사항

- Node.js 20 이상 (최신 LTS 권장)
- TypeScript 프로젝트
- MySQL, PostgreSQL, 또는 SQLite 데이터베이스

## 1단계: 설치

코어 패키지와 `reflect-metadata`를 설치한 후, 사용할 데이터베이스의 드라이버를 추가합니다.

::: code-group

```bash [npm]
npm install @stingerloom/orm reflect-metadata
```

```bash [pnpm]
pnpm add @stingerloom/orm reflect-metadata
```

```bash [yarn]
yarn add @stingerloom/orm reflect-metadata
```

:::

그런 다음 데이터베이스용 드라이버를 설치합니다:

::: code-group

```bash [PostgreSQL]
npm install pg            # 또는 pnpm add pg / yarn add pg
```

```bash [MySQL / MariaDB]
npm install mysql2        # 또는 pnpm add mysql2 / yarn add mysql2
```

```bash [SQLite]
npm install better-sqlite3  # 또는 pnpm add better-sqlite3 / yarn add better-sqlite3
```

:::

예를 들어, PostgreSQL 프로젝트는 다음이 필요합니다:

::: code-group

```bash [npm]
npm install @stingerloom/orm reflect-metadata pg
```

```bash [pnpm]
pnpm add @stingerloom/orm reflect-metadata pg
```

```bash [yarn]
yarn add @stingerloom/orm reflect-metadata pg
```

:::

### reflect-metadata가 필요한 이유

클래스 프로퍼티에 `@Column()`을 작성하면, TypeScript는 컴파일 시점에 해당 프로퍼티에 대한 정보(타입, 이름)를 기록합니다. 하지만 기본적으로 이 정보는 JavaScript로 컴파일될 때 삭제됩니다.

`reflect-metadata`는 이 메타데이터를 **런타임**에 사용할 수 있게 해주는 폴리필입니다. ORM은 "email 프로퍼티의 타입이 무엇인가?"와 같은 질문에 답하기 위해 이것이 필요하며, 이를 통해 `string`을 `VARCHAR`로, `number`를 `INTEGER`로 자동 매핑합니다. 이것 없이는 `@Entity()`나 `@Column()` 같은 데코레이터가 클래스의 구조를 알 수 없습니다.

애플리케이션 진입점의 맨 위에서 한 번만 import하면 됩니다. 그 이후로 ORM의 모든 데코레이터가 필요한 타입 정보를 읽을 수 있습니다.

### CJS와 ESM

Stingerloom ORM은 **CJS/ESM 듀얼 패키지**로 제공됩니다. `require()`와 `import` 모두 별도 설정 없이 바로 사용할 수 ��습니다.

```typescript
// ESM (권장)
import { EntityManager } from "@stingerloom/orm";

// CommonJS
const { EntityManager } = require("@stingerloom/orm");
```

서브패스 export도 듀얼로 지원됩니다:

```typescript
import { StinglerloomOrmModule } from "@stingerloom/orm/nestjs";
import { PrismaImporter } from "@stingerloom/orm/prisma-import";
```

## 2단계: TypeScript 설정

`tsconfig.json`에서 데코레이터 관련 옵션을 활성화합니다.

```json
// tsconfig.json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "strictPropertyInitialization": false
  }
}
```

각 옵션의 역할:

- `experimentalDecorators` -- `@Entity()`, `@Column()` 문법을 활성화합니다. 이것 없이는 TypeScript가 `@`를 문법 오류로 처리합니다.
- `emitDecoratorMetadata` -- 컴파일러에게 `reflect-metadata`가 런타임에 읽을 수 있는 타입 정보를 출력하도록 지시합니다. ORM은 이를 통해 `name: string`이 `VARCHAR` 컬럼이 되어야 함을 알 수 있습니다.
- `strictPropertyInitialization` -- 일반적으로 TypeScript는 생성자에서 할당되지 않은 클래스 프로퍼티에 대해 경고합니다. 엔티티 프로퍼티는 생성자가 아닌 ORM에 의해 채워지므로, 모든 프로퍼티에 `!:`를 붙이지 않도록 이 검사를 비활성화합니다.

## 3단계: 엔티티 정의

**엔티티**는 데이터베이스 테이블을 나타내는 TypeScript 클래스입니다. 클래스의 각 인스턴스는 하나의 행을 나타냅니다. 간단한 사용자 엔티티를 만들어 봅시다.

```typescript
// user.entity.ts
import { Entity, PrimaryGeneratedColumn, Column } from "@stingerloom/orm";

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @Column()
  email!: string;
}
```

각 데코레이터의 역할:

- `@Entity()` -- ORM에 "이 클래스는 데이터베이스 테이블에 매핑된다"고 알려줍니다. 테이블 이름은 기본적으로 소문자 클래스 이름(`user`)입니다.
- `@PrimaryGeneratedColumn()` -- 이 컬럼은 기본 키이며, 데이터베이스가 값을 자동 생성합니다 (MySQL은 auto-increment, PostgreSQL은 `SERIAL`).
- `@Column()` -- 일반 컬럼입니다. ORM은 TypeScript 타입으로부터 SQL 타입을 추론합니다: `string`은 `VARCHAR(255)`, `number`는 `INTEGER`, `boolean`은 `BOOLEAN`이 됩니다.

`synchronize: true`가 설정되면 (다음 단계), ORM이 다음 DDL을 생성하고 실행합니다:

```sql
-- PostgreSQL
CREATE TABLE "user" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(255),
  "email" VARCHAR(255)
);

-- MySQL
CREATE TABLE `user` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(255),
  `email` VARCHAR(255)
);
```

식별자 래핑의 차이를 확인하세요: PostgreSQL은 `"큰따옴표"`, MySQL은 `` `백틱` ``을 사용합니다. ORM은 `type` 설정에 따라 자동으로 처리합니다.

> **힌트** 엔티티에 대해 더 알아보려면 [엔티티](./entities.md) 문서를 참고하세요.

## 4단계: 데이터베이스 연결

이제 `EntityManager`를 사용하여 DB에 연결하고 엔티티를 등록합니다. 반드시 `reflect-metadata`를 애플리케이션 진입점의 맨 위에서 import하세요 -- 데코레이터를 사용하는 다른 import보다 먼저 와야 합니다.

```typescript
// main.ts
import "reflect-metadata";  // 반드시 첫 번째 import이어야 합니다
import { EntityManager } from "@stingerloom/orm";
import { User } from "./user.entity";

async function main() {
  const em = new EntityManager();

  await em.register({
    type: "postgres",
    host: "localhost",
    port: 5432,
    username: "postgres",
    password: "password",
    database: "mydb",
    entities: [User],
    synchronize: true,
  });

  console.log("DB 연결 성공!");
}

main().catch(console.error);
```

`synchronize: true`가 설정되면, ORM은 엔티티 정의와 실제 데이터베이스를 비교하여 테이블을 생성하거나 변경합니다. `user` 테이블이 아직 없으면 위에 표시된 `CREATE TABLE` DDL을 실행합니다. 테이블은 있지만 추가한 컬럼이 누락된 경우 `ALTER TABLE`을 실행하여 추가합니다.

> **경고** `synchronize: true`는 개발 환경에서만 사용하세요. 프로덕션에서는 엔티티와 더 이상 일치하지 않는 컬럼이나 테이블을 삭제할 수 있습니다. 대신 [마이그레이션](./migrations.md)을 사용하세요 -- 프로덕션 데이터베이스에 어떤 변경이 적용될지 완전히 제어할 수 있습니다.

## 5단계: CRUD 실습

DB가 연결되었으니 데이터를 생성, 조회, 수정, 삭제해 봅시다. `main()` 함수 안에 계속 작성합니다.

### 생성 (Create)

```typescript
// main.ts (main 함수 내부)
const user = await em.save(User, {
  name: "John Doe",
  email: "john@example.com",
});
console.log("저장된 사용자:", user);
// { id: 1, name: "John Doe", email: "john@example.com" }
```

`em.save()`는 `id`가 제공되지 않았으므로 INSERT를 수행합니다. 실제 실행되는 SQL은 다음과 같습니다:

```sql
-- PostgreSQL
INSERT INTO "user" ("name", "email") VALUES ($1, $2) RETURNING *
-- 파라미터: ["John Doe", "john@example.com"]

-- MySQL
INSERT INTO `user` (`name`, `email`) VALUES (?, ?)
-- 파라미터: ["John Doe", "john@example.com"]
-- 이후: SELECT * FROM `user` WHERE `id` = LAST_INSERT_ID()
```

사용자 제공 값이 SQL 문자열에 직접 배치되지 않는 것을 확인하세요. `$1`, `$2` (PostgreSQL) 또는 `?` (MySQL)로 나타납니다 -- 이것이 **파라미터 바인딩**이며, SQL 인젝션을 방지합니다. PostgreSQL은 `RETURNING *`도 지원하여 삽입된 행을 단일 라운드트립으로 반환합니다. MySQL은 자동 생성된 `id`를 가져오기 위해 두 번째 쿼리가 필요합니다.

### 조회 (Read)

```typescript
// main.ts
// 전체 조회
const users = await em.find(User);
console.log("모든 사용자:", users);

// 조건으로 하나 찾기
const found = await em.findOne(User, { where: { id: 1 } });
console.log("단일 사용자:", found); // User | null
```

생성되는 SQL:

```sql
-- find() -- 모든 사용자 조회
SELECT "id", "name", "email" FROM "user"

-- findOne() -- 조건으로 조회
SELECT "id", "name", "email" FROM "user" WHERE "id" = $1 LIMIT 1
-- 파라미터: [1]
```

`find()`는 배열을 반환합니다 (일치하는 행이 없으면 빈 배열). `findOne()`은 타입이 지정된 단일 객체 또는 `null`을 반환합니다. ORM은 하나의 행만 필요하므로 `findOne()`에 `LIMIT 1`을 자동으로 추가합니다.

### 수정 (Update)

```typescript
// main.ts
const updated = await em.save(User, {
  id: 1,               // PK가 있으므로 UPDATE
  name: "John Doe (수정됨)",
  email: "john@example.com",
});
console.log("수정된 사용자:", updated);
```

`save()`가 기본 키(`id: 1`)를 가진 객체를 받으면 INSERT 대신 UPDATE를 수행합니다:

```sql
-- PostgreSQL
UPDATE "user" SET "name" = $1, "email" = $2 WHERE "id" = $3
-- 파라미터: ["John Doe (수정됨)", "john@example.com", 1]

-- MySQL
UPDATE `user` SET `name` = ?, `email` = ? WHERE `id` = ?
-- 파라미터: ["John Doe (수정됨)", "john@example.com", 1]
```

### 삭제 (Delete)

```typescript
// main.ts
const result = await em.delete(User, { id: 1 });
console.log("삭제된 행 수:", result.affected); // 1
```

생성되는 SQL:

```sql
DELETE FROM "user" WHERE "id" = $1
-- 파라미터: [1]
```

축하합니다 -- 첫 번째 CRUD를 완료했습니다. 모든 작업이 단일 메서드 호출이었고, ORM이 SQL 생성, 파라미터 바인딩, 결과 역직렬화를 뒤에서 처리했습니다.

## 다른 데이터베이스 사용

위 예제는 PostgreSQL을 사용했지만, `type` 옵션만 변경하면 다른 데이터베이스를 사용할 수 있습니다. 나머지 코드는 동일합니다.

| DB | `type` | `port` | 참고 |
|----|--------|--------|------|
| PostgreSQL | `"postgres"` | 5432 | `schema` 옵션으로 스키마 지정 가능 |
| MySQL / MariaDB | `"mysql"` | 3306 | `charset: "utf8mb4"` 권장 |
| SQLite | `"sqlite"` | 0 | `database`에 파일 경로 지정 (예: `"./mydb.sqlite"`) |

```typescript
// MySQL 예제
await em.register({
  type: "mysql",
  host: "localhost",
  port: 3306,
  username: "root",
  password: "password",
  database: "mydb",
  entities: [User],
  synchronize: true,
  charset: "utf8mb4",
});
```

```typescript
// SQLite 예제 -- host, port, username, password는 비워둡니다
await em.register({
  type: "sqlite",
  host: "",
  port: 0,
  username: "",
  password: "",
  database: "./mydb.sqlite",
  entities: [User],
  synchronize: true,
});
```

## NestJS와 함께 사용

Stingerloom ORM은 `@stingerloom/orm/nestjs` 서브패스 export를 통해 자체 NestJS 통합 모듈을 제공합니다.

### 별도 모듈이 필요한 이유

NestJS는 **의존성 주입(DI)** 을 사용합니다 -- `new`로 객체를 직접 생성하는 대신, 필요한 것을 선언하면 NestJS가 제공합니다. ORM 모듈은 이 두 세계를 연결합니다: `EntityManager`와 리포지토리를 생성한 후 NestJS의 DI 컨테이너에 등록하여 서비스에서 생성자 파라미터로 선언할 수 있게 합니다.

흐름은 다음과 같습니다:

1. `forRoot()`가 `EntityManager`를 생성하고, 데이터베이스에 연결하고, 전역 NestJS 프로바이더로 등록합니다.
2. `forFeature([User])`가 `BaseRepository<User>`를 생성하고 `User` 클래스에서 파생된 고유 토큰으로 등록합니다.
3. 서비스의 `@InjectRepository(User)`가 NestJS에 "User용으로 등록된 리포지토리를 주세요"라고 알려줍니다.
4. NestJS가 의존성을 해결하고 서비스의 생성자에 리포지토리를 전달합니다.

### 설치

::: code-group

```bash [npm]
npm install @stingerloom/orm reflect-metadata
```

```bash [pnpm]
pnpm add @stingerloom/orm reflect-metadata
```

```bash [yarn]
yarn add @stingerloom/orm reflect-metadata
```

:::

`@nestjs/common`과 `@nestjs/core`는 선택적 peer dependency로 나열되어 있습니다 -- 모든 NestJS 프로젝트에 이미 존재합니다.

### 루트 모듈 등록

`StinglerloomOrmModule.forRoot()`로 데이터베이스 연결을 초기화하고, `StinglerloomOrmModule.forFeature()`로 엔티티 리포지토리를 등록합니다.

```typescript
// app.module.ts
import { Module } from "@nestjs/common";
import { StinglerloomOrmModule } from "@stingerloom/orm/nestjs";
import { User } from "./user.entity";
import { UsersModule } from "./users/users.module";

@Module({
  imports: [
    StinglerloomOrmModule.forRoot({
      type: "postgres",
      host: "localhost",
      port: 5432,
      username: "postgres",
      password: "password",
      database: "mydb",
      entities: [User],
      synchronize: true,
    }),
    UsersModule,
  ],
})
export class AppModule {}
```

### 기능 모듈 등록

```typescript
// users/users.module.ts
import { Module } from "@nestjs/common";
import { StinglerloomOrmModule } from "@stingerloom/orm/nestjs";
import { User } from "./user.entity";
import { UsersService } from "./users.service";

@Module({
  imports: [StinglerloomOrmModule.forFeature([User])],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
```

### 서비스에서 사용

`@stingerloom/orm/nestjs`에서 `InjectRepository`를 import하여 타입이 지정된 리포지토리를 주입합니다.

```typescript
// users/users.service.ts
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { BaseRepository } from "@stingerloom/orm";
import { User } from "./user.entity";

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly userRepo: BaseRepository<User>,
  ) {}

  async findAll(): Promise<User[]> {
    return (await this.userRepo.find()) as User[];
  }

  async findById(id: number): Promise<User | null> {
    return this.userRepo.findOne({ where: { id } as any });
  }

  async create(name: string, email: string): Promise<User> {
    return (await this.userRepo.save({ name, email })) as User;
  }
}
```

### 멀티 DB (Named Connections)

`forRoot()`와 `forFeature()`에 `connectionName`을 전달하여 여러 데이터베이스를 동시에 사용할 수 있습니다.

```typescript
// app.module.ts
import { Module } from "@nestjs/common";
import { StinglerloomOrmModule } from "@stingerloom/orm/nestjs";
import { User } from "./user.entity";
import { Event } from "./event.entity";

@Module({
  imports: [
    // 기본 연결 (MySQL)
    StinglerloomOrmModule.forRoot({
      type: "mysql",
      host: "localhost",
      port: 3306,
      username: "root",
      password: "password",
      database: "main",
      entities: [User],
    }),
    // Named 연결 (PostgreSQL)
    StinglerloomOrmModule.forRoot({
      type: "postgres",
      host: "localhost",
      port: 5432,
      username: "postgres",
      password: "password",
      database: "analytics",
      entities: [Event],
    }, "analytics"),
    UsersModule,
    AnalyticsModule,
  ],
})
export class AppModule {}
```

기능 모듈에서 connectionName을 지정합니다:

```typescript
// analytics/analytics.module.ts
@Module({
  imports: [StinglerloomOrmModule.forFeature([Event], "analytics")],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
```

서비스에서 `@InjectRepository`와 `@InjectEntityManager`에 connectionName을 전달합니다:

```typescript
// analytics/analytics.service.ts
import { Injectable } from "@nestjs/common";
import {
  InjectRepository,
  InjectEntityManager,
} from "@stingerloom/orm/nestjs";
import { BaseRepository, EntityManager } from "@stingerloom/orm";
import { Event } from "./event.entity";

@Injectable()
export class AnalyticsService {
  constructor(
    @InjectRepository(Event, "analytics")
    private readonly eventRepo: BaseRepository<Event>,
    @InjectEntityManager("analytics")
    private readonly em: EntityManager,
  ) {}
}
```

> connectionName을 생략하면 기본값 `"default"`가 사용되므로, 기존 단일 DB 코드는 변경 없이 계속 작동합니다.

> **힌트** 완전한 NestJS 예제는 `examples/nestjs-cats/`, `examples/nestjs-blog/`, `examples/nestjs-multitenant/` 디렉토리에 포함되어 있습니다.

## 다음 단계

기본 설정과 CRUD를 배웠습니다. 이제 더 풍부한 엔티티를 정의해 보세요.

- [엔티티](./entities.md) -- 컬럼 타입, 인덱스, 소프트 삭제, 생명주기 훅
- [관계](./relations.md) -- `@ManyToOne`, `@OneToMany`로 테이블 간 관계 정의
- [엔티티 매니저](./entity-manager.md) -- 검색 옵션, 집계, 페이지네이션
- [NestJS 통합](./nestjs.md) -- forRoot/forFeature, @InjectRepository, 멀티 DB
- [설정](./configuration.md) -- 풀링, 타임아웃, Read Replica 및 기타 운영 설정
