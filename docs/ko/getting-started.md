# 시작하기

설치부터 첫 CRUD까지 5분이면 충분합니다.

## ORM 개요

웹 애플리케이션의 데이터는 서로 전혀 다른 두 세계에 있습니다. TypeScript 코드에서 데이터는 속성과 메서드를 가진 객체입니다. 데이터베이스에서 데이터는 행과 컬럼으로 이루어진 테이블입니다.

ORM(Object-Relational Mapper)은 두 세계 사이의 변환 계층입니다. SQL 문자열을 직접 쓰지 않고 TypeScript 클래스를 정의하면 됩니다. 그러면 ORM이 테이블 생성, 행 삽입, 데이터 조회, 타입이 있는 객체 반환을 알아서 처리합니다.

ORM을 통역사라고 생각하면 됩니다. 개발자는 TypeScript로 말하고 데이터베이스는 SQL로 말합니다. ORM은 그 사이의 모든 대화를 통역합니다.

ORM 없이 쓰면 다음과 같습니다.

```typescript
// raw SQL 문자열을 직접 작성하고 결과에는 타입이 없습니다
const result = await pool.query('SELECT * FROM "user" WHERE "id" = $1', [1]);
const user = result.rows[0]; // { id: 1, name: "Alice" }: 타입 안전성 없음
```

ORM을 쓰면 다음과 같습니다.

```typescript
// 타입이 있는 객체로 작업하고 SQL은 ORM이 작성합니다
const user = await em.findOne(User, { where: { id: 1 } });
// user는 User | null: 타입 안전, 속성 자동 완성
```

ORM은 양방향으로 변환합니다. 클래스 정의는 `CREATE TABLE` 문이 됩니다. `save()` 호출은 `INSERT`가 되고 `find()` 호출은 `SELECT`가 됩니다.

## 사전 요구사항

- Node.js 22+
- TypeScript 5.4+: 코드 우선 `defineEntity` API에 필요합니다. 이 API의 타입이 5.4에 추가된 `NoInfer`를 쓰기 때문입니다. 데코레이터 API는 그 이전의 TypeScript 5.x에서도 동작합니다.
- MySQL, PostgreSQL, 또는 SQLite

## 1단계: 설치

코어 패키지와 `reflect-metadata`를 설치한 뒤 DB 드라이버를 추가합니다.

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

그다음 DB 드라이버를 설치합니다.

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

예를 들어 PostgreSQL 프로젝트는 한 줄로 설치합니다.

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

클래스 속성에 `@Column()`을 붙이면 TypeScript는 컴파일 타임에 그 속성의 타입과 이름 같은 정보를 기록합니다. 하지만 기본 설정에서는 이 정보가 JavaScript로 컴파일될 때 사라집니다.

`reflect-metadata`는 이 메타데이터를 런타임에도 쓸 수 있게 하는 폴리필입니다. ORM은 "`email` 속성의 타입은 무엇인가?"라는 질문에 답할 수 있어야 `string`을 `VARCHAR`로, `number`를 `INTEGER`로 자동 매핑할 수 있습니다. 이 폴리필이 없으면 `@Entity()`나 `@Column()` 같은 데코레이터는 클래스 구조를 읽어 낼 방법이 없습니다.

앱 진입점 맨 위에서 한 번만 import하면 됩니다. 그러면 ORM의 모든 데코레이터가 필요한 타입 정보를 읽을 수 있습니다.

### CJS / ESM

Stingerloom ORM은 CJS/ESM 듀얼 패키지입니다. `require()`와 `import` 모두 별도 설정 없이 동작합니다.

```typescript
// ESM (권장)
import { EntityManager } from "@stingerloom/orm";

// CommonJS
const { EntityManager } = require("@stingerloom/orm");
```

Subpath export도 두 형식을 모두 지원합니다.

```typescript
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { EntityManager } from "@stingerloom/orm/core";       // 코어만
import { PostgresDriver } from "@stingerloom/orm/postgres";   // 단일 드라이버
```

::: tip 선택사항: class-transformer
기본값으로 ORM은 의존성이 없는 가벼운 `PlainObjectDeserializer`를 사용합니다. `class-transformer`를 설치하면 ORM이 자동으로 감지해서 역직렬화에 사용합니다. 별도 설정은 필요 없습니다.

```bash
npm install class-transformer   # 선택사항, 고급 역직렬화용
```
:::

## 2단계: TypeScript 설정

3단계에서 다룰 코드 우선 빌더(`defineEntity`)로 엔티티를 정의한다면 특별한 컴파일러 옵션이 필요 없습니다. 이 단계는 건너뛰어도 됩니다.

데코레이터 스타일(`@Entity`, `@Column`)을 쓰려면 `tsconfig.json`에 다음 설정이 필요합니다.

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

각 옵션의 역할은 다음과 같습니다.

- `experimentalDecorators`: `@Entity()`, `@Column()` 문법을 활성화합니다. 이 옵션이 없으면 TypeScript가 `@`를 문법 에러로 처리합니다.
- `emitDecoratorMetadata`: `reflect-metadata`가 런타임에 읽을 타입 정보를 컴파일러가 출력하게 합니다. ORM이 `name: string`을 `VARCHAR` 컬럼으로 매핑하는 것도 이 옵션 덕분입니다.
- `strictPropertyInitialization`: TypeScript는 보통 생성자에서 할당하지 않은 클래스 속성을 경고합니다. 하지만 엔티티 속성은 생성자가 아니라 ORM이 채웁니다. 그래서 모든 속성에 `!:`를 붙이지 않으려면 이 검사를 꺼야 합니다.

> 코드 우선 빌더에는 이 옵션이 하나도 필요 없습니다. 빌더가 컬럼 타입을 직접 갖고 있고 데코레이터를 쓰지 않기 때문입니다. 그래도 진입점에서 `reflect-metadata`는 한 번 import해야 합니다. ORM 코어가 런타임에 사용하기 때문입니다.

## 3단계: 엔티티 정의

**엔티티**(entity)는 데이터베이스 테이블을 나타냅니다. 테이블의 각 행이 엔티티 인스턴스 하나에 대응합니다. 엔티티를 정의할 때 권장하는 방식은 **코드 우선 빌더 API**입니다. `defineEntity`와 `t` 필드 빌더를 쓰는 방식입니다. 선언을 하나만 작성하면 엔티티의 TypeScript 타입은 그 선언에서 추론됩니다.

```typescript
// user.entity.ts
import { defineEntity, t, InferEntity } from "@stingerloom/orm";

export const User = defineEntity("users", {
  id:    t.int().primary().generated(),
  name:  t.varchar(255),
  email: t.varchar(255),
});

export type User = InferEntity<typeof User>;
// { id: number; name: string; email: string }
```

각 부분의 역할은 다음과 같습니다.

- `defineEntity("users", { … })`: `users`라는 이름의 테이블을 정의합니다. 반환된 `User`는 실제 클래스입니다. `em.findOne(User, …)`처럼 ORM이 엔티티를 받는 모든 곳에 씁니다.
- `t.int().primary().generated()`: 데이터베이스가 값을 자동으로 생성하는 기본 키입니다. MySQL에서는 auto-increment이고 PostgreSQL에서는 `SERIAL`입니다.
- `t.varchar(255)`: `VARCHAR(255)` 컬럼입니다. 빌더 하나로 SQL 타입과 추론되는 TypeScript 타입(`string`)이 함께 정해집니다. 그래서 두 타입은 절대 어긋나지 않습니다.
- `InferEntity<typeof User>`: 스키마에서 행 타입을 꺼냅니다. 별도 인터페이스도 코드 생성도 필요 없습니다.

::: tip 데코레이터를 선호하는 경우
클래스와 데코레이터를 쓰는 스타일이 좋거나 NestJS를 쓰고 있다면 같은 엔티티를 `@Entity` / `@Column`으로도 표현할 수 있습니다. 두 방식은 똑같은 메타데이터를 생성합니다.

```typescript
import { Entity, PrimaryGeneratedColumn, Column } from "@stingerloom/orm";

@Entity()
export class User {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
  @Column() email!: string;
}
```

데코레이터 방식에는 2단계의 `experimentalDecorators`와 `emitDecoratorMetadata` 컴파일러 옵션이 필요합니다. 반면 위의 코드 우선 빌더에는 필요 없습니다. 두 스타일은 같은 프로젝트에서 함께 쓸 수 있습니다. 자세한 내용은 [엔티티 정의하기](./define-entity.md)와 [엔티티 & 컬럼 (데코레이터)](./entities.md)를 참고하세요.
:::

다음 단계에서 `synchronize: true`로 설정하면 ORM이 다음 DDL을 생성해 실행합니다.

```sql
-- PostgreSQL
CREATE TABLE "users" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(255),
  "email" VARCHAR(255)
);

-- MySQL
CREATE TABLE `users` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(255),
  `email` VARCHAR(255)
);
```

식별자를 감싸는 방식이 다르다는 점을 눈여겨보세요. PostgreSQL은 `"큰따옴표"`를 쓰고 MySQL은 `` `백틱` ``을 씁니다. ORM은 `type` 설정에 따라 이 차이를 자동으로 처리합니다.

> 힌트: 엔티티 정의를 더 알아보려면 [엔티티 정의하기](./define-entity.md)(코드 우선)와 [엔티티 & 컬럼](./entities.md)(데코레이터)을 참고하세요.

## 4단계: 데이터베이스 연결

`EntityManager`로 DB에 연결합니다. `reflect-metadata`는 반드시 맨 위에서 import해야 합니다.

```typescript
// main.ts
import "reflect-metadata";  // 반드시 첫 번째 import여야 합니다
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

`synchronize: true`로 설정하면 ORM이 엔티티 정의와 실제 DB를 비교해서 테이블을 맞춥니다. `user` 테이블이 아직 없으면 위의 `CREATE TABLE` DDL을 실행합니다. 테이블은 있지만 새로 추가한 컬럼이 없으면 `ALTER TABLE`로 그 컬럼을 추가합니다.

> 경고: `synchronize: true`는 개발 환경에서만 쓰세요. 프로덕션에서는 엔티티에서 사라진 컬럼을 DROP할 수 있습니다. 대신 [마이그레이션](./migrations.md)을 사용하세요. 마이그레이션을 쓰면 프로덕션 DB에 어떤 변경이 적용되는지 직접 제어할 수 있습니다.

## 5단계: CRUD 실습

DB에 연결했으니 이제 `main()` 함수 안에서 데이터를 생성, 조회, 수정, 삭제해 보겠습니다.

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

`em.save()`는 `id`가 없으므로 INSERT를 실행합니다. 실제로 실행되는 SQL은 다음과 같습니다.

```sql
-- PostgreSQL
INSERT INTO "user" ("name", "email") VALUES ($1, $2) RETURNING *
-- 파라미터: ["John Doe", "john@example.com"]

-- MySQL
INSERT INTO `user` (`name`, `email`) VALUES (?, ?)
-- 파라미터: ["John Doe", "john@example.com"]
-- 이후: SELECT * FROM `user` WHERE `id` = LAST_INSERT_ID()
```

사용자가 넘긴 값은 SQL 문자열에 직접 들어가지 않습니다. 이 값은 PostgreSQL에서는 `$1`, `$2`로, MySQL에서는 `?`로 표시됩니다. 이것이 **파라미터 바인딩**이며 SQL 인젝션을 막습니다. PostgreSQL은 `RETURNING *`를 지원하므로 삽입한 행을 라운드 트립 한 번으로 받습니다. 반면 MySQL은 자동 생성된 `id`를 조회하려면 쿼리를 한 번 더 실행해야 합니다.

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

```sql
-- find(): 전체 조회
SELECT "id", "name", "email" FROM "user"

-- findOne(): 조건으로 하나 찾기
SELECT "id", "name", "email" FROM "user" WHERE "id" = $1 LIMIT 1
-- 파라미터: [1]
```

`find()`는 배열을 반환합니다. 매칭되는 행이 없으면 빈 배열입니다. `findOne()`은 타입이 있는 객체 하나나 `null`을 반환합니다. 한 행만 필요하므로 ORM이 `findOne()`에 `LIMIT 1`을 자동으로 붙입니다.

### 수정 (Update)

```typescript
// main.ts
const updated = await em.save(User, {
  id: 1,               // 기본 키가 있으므로 UPDATE
  name: "John Doe (수정됨)",
  email: "john@example.com",
});
console.log("수정된 사용자:", updated);
```

`save()`에 기본 키(`id: 1`)가 들어 있는 객체를 넘기면 INSERT 대신 UPDATE를 실행합니다.

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

```sql
DELETE FROM "user" WHERE "id" = $1
-- 파라미터: [1]
```

이것으로 첫 CRUD를 마쳤습니다. 모든 작업이 메서드 호출 하나로 끝납니다. SQL 생성, 파라미터 바인딩, 결과 역직렬화는 ORM이 뒤에서 처리합니다.

## 다른 데이터베이스 사용

`type`만 바꾸면 다른 DB를 쓸 수 있습니다. 나머지 코드는 같습니다.

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
// SQLite 예제: host, port, username, password는 비워 둡니다
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

## NestJS 통합

Stingerloom ORM은 `@stingerloom/orm/nestjs` subpath export로 NestJS 통합 모듈을 제공합니다.

### 별도 모듈이 필요한 이유

NestJS는 **의존성 주입**(Dependency Injection, DI)을 사용합니다. `new`로 객체를 직접 만들지 않고 필요한 것을 선언하면 NestJS가 알아서 제공합니다. ORM 모듈은 ORM과 NestJS를 잇는 다리입니다. 이 모듈은 `EntityManager`와 리포지토리를 생성하고 NestJS의 DI 컨테이너에 등록합니다. 그래서 서비스는 생성자 파라미터로 이 객체를 주입받을 수 있습니다.

흐름은 다음과 같습니다.

1. `forRoot()`: `EntityManager`를 생성하고 DB에 연결합니다. 그리고 전역 NestJS 프로바이더로 등록합니다.
2. `forFeature([User])`: `BaseRepository<User>`를 생성하고 `User` 클래스에서 만든 고유 토큰으로 등록합니다.
3. `@InjectRepository(User)`: 서비스에서 NestJS에 "User용으로 등록된 리포지토리를 달라"고 요청합니다.
4. NestJS가 의존성을 해석해서 서비스의 생성자에 리포지토리를 넘깁니다.

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

`@nestjs/common`과 `@nestjs/core`는 선택적 peer dependency입니다. NestJS 프로젝트에는 이미 설치되어 있습니다.

### 루트 모듈 등록

`StingerloomOrmModule.forRoot()`로 데이터베이스 연결을 초기화합니다. 그리고 `StingerloomOrmModule.forFeature()`로 엔티티 리포지토리를 등록합니다.

```typescript
// app.module.ts
import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { User } from "./user.entity";
import { UsersModule } from "./users/users.module";

@Module({
  imports: [
    StingerloomOrmModule.forRoot({
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
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { User } from "./user.entity";
import { UsersService } from "./users.service";

@Module({
  imports: [StingerloomOrmModule.forFeature([User])],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
```

### 서비스에서 사용

`@stingerloom/orm/nestjs`에서 `InjectRepository`를 import해서 타입이 있는 리포지토리를 주입합니다.

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

### 멀티 DB (이름 있는 연결)

`forRoot()`와 `forFeature()`에 `connectionName`을 넘기면 여러 데이터베이스를 동시에 쓸 수 있습니다.

```typescript
// app.module.ts
import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { User } from "./user.entity";
import { Event } from "./event.entity";

@Module({
  imports: [
    // 기본 연결 (MySQL)
    StingerloomOrmModule.forRoot({
      type: "mysql",
      host: "localhost",
      port: 3306,
      username: "root",
      password: "password",
      database: "main",
      entities: [User],
    }),
    // 이름 있는 연결 (PostgreSQL)
    StingerloomOrmModule.forRoot({
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

기능 모듈에서는 connectionName을 지정합니다.

```typescript
// analytics/analytics.module.ts
@Module({
  imports: [StingerloomOrmModule.forFeature([Event], "analytics")],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
```

서비스에서는 `@InjectRepository`와 `@InjectEntityManager`에 connectionName을 넘깁니다.

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

> connectionName을 생략하면 기본값 `"default"`가 쓰입니다. 그래서 기존 단일 DB 코드는 바꾸지 않아도 계속 동작합니다.

> 힌트: 완전한 NestJS 예제는 `examples/` 아래에 있습니다. `nestjs-cats`(기본 CRUD + EntitySubscriber), `nestjs-blog`(ManyToMany, 소프트 삭제, upsert, 59개 e2e 테스트), `nestjs-multitenant`(PostgreSQL 스키마별 테넌트), `nestjs-todo`(최소 CRUD), `nestjs-todo-sqlite`(SQLite), `nestjs-linear-clone`(풀 레퍼런스 앱: 재귀 CTE 이슈 트리, 워크플로 상태 머신, 분석, 워크스페이스별 멀티테넌시)이 있습니다.

## 다음 단계

기본 설정과 CRUD를 익혔습니다. 이제 더 풍부한 엔티티를 정의해 보세요.

- [엔티티](./entities.md): 컬럼 타입, 인덱스, 소프트 삭제, 생명주기 훅
- [관계](./relations.md): `@ManyToOne`, `@OneToMany`로 테이블 간 관계 정의
- [엔티티 매니저](./entity-manager.md): 검색 옵션, 집계, 페이지네이션
- [NestJS 통합](./nestjs.md): forRoot/forFeature, @InjectRepository, 멀티 DB
- [설정](./configuration.md): 연결 풀, 타임아웃, 읽기 레플리카를 비롯한 운영 설정
