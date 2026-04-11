# 시작하기

설치부터 첫 CRUD까지, 5분이면 돼요.

## ORM이란?

웹 애플리케이션을 만들 때, 데이터는 서로 전혀 다른 두 세계에 존재해요. TypeScript 코드 안에서 데이터는 **객체**로 존재해요 — 프로퍼티와 메서드를 가진 클래스. 데이터베이스 안에서 데이터는 **테이블**로 존재해요 — 행과 열로 이루어진 원시 값.

ORM(Object-Relational Mapper)은 이 두 세계 사이의 변환 계층이에요. SQL 문자열을 직접 작성하는 대신, TypeScript 클래스를 정의하면 ORM이 테이블 생성, 행 삽입, 데이터 조회, 타입이 지정된 객체 반환까지 알아서 처리해요.

일종의 통역사라고 생각하면 돼요. 여러분은 TypeScript를 쓰고, 데이터베이스는 SQL을 쓰고, ORM이 그 사이의 모든 대화를 번역해 줘요.

ORM 없이:

```typescript
// raw SQL 문자열을 직접 작성, 결과는 타입 없음
const result = await pool.query('SELECT * FROM "user" WHERE "id" = $1', [1]);
const user = result.rows[0]; // { id: 1, name: "Alice" } — 타입 안전성 없음
```

ORM을 쓰면:

```typescript
// 타입이 지정된 객체로 작업, SQL은 ORM이 작성
const user = await em.findOne(User, { where: { id: 1 } });
// user는 User | null — 타입 안전, 프로퍼티 자동완성
```

ORM은 양방향으로 변환을 처리해요. 클래스 정의 → `CREATE TABLE`, `save()` 호출 → `INSERT`, `find()` 호출 → `SELECT`. 이 가이드에서 각 연산의 실제 SQL도 함께 보여줄게요.

## 사전 요구사항

- Node.js 22+
- TypeScript 프로젝트
- MySQL, PostgreSQL, 또는 SQLite

## 1단계: 설치

코어 패키지와 `reflect-metadata`를 설치하고, DB 드라이버를 추가해요.

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

DB 드라이버 설치:

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

PostgreSQL 예시 (한 줄로):

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

### reflect-metadata가 왜 필요할까?

`@Column()`을 클래스 프로퍼티에 붙이면, TypeScript는 컴파일 타임에 해당 프로퍼티의 타입이나 이름 같은 정보를 기록해요. 하지만 기본적으로 이 정보는 JavaScript로 컴파일될 때 사라져요.

`reflect-metadata`는 이 메타데이터를 **런타임**에도 사용할 수 있게 해주는 폴리필이에요. ORM이 "`email` 프로퍼티의 타입이 뭐지?"라는 질문에 답할 수 있어야 `string` → `VARCHAR`, `number` → `INTEGER`로 자동 매핑할 수 있거든요. 이 폴리필이 없으면 `@Entity()`나 `@Column()` 같은 데코레이터가 클래스 구조를 전혀 알 수 없어요.

앱 진입점 최상단에서 한 번만 import하면 돼요. 그 이후로 ORM의 모든 데코레이터가 필요한 타입 정보를 읽을 수 있어요.

### CJS / ESM

CJS/ESM 듀얼 패키지예요. 별도 설정 없이 둘 다 동작해요.

```typescript
// ESM (권장)
import { EntityManager } from "@stingerloom/orm";

// CommonJS
const { EntityManager } = require("@stingerloom/orm");
```

Subpath export도 동일:

```typescript
import { StinglerloomOrmModule } from "@stingerloom/orm/nestjs";
import { PrismaImporter } from "@stingerloom/orm/prisma-import";
import { EntityManager } from "@stingerloom/orm/core";       // 코어만
import { PostgresDriver } from "@stingerloom/orm/postgres";   // 단일 드라이버
```

::: tip 선택사항: class-transformer
기본적으로 ORM은 의존성 없는 경량 `PlainObjectDeserializer`를 사용해요. `class-transformer`를 설치하면 자동으로 감지되어 역직렬화에 사용돼요. 별도 설정은 필요 없어요.

```bash
npm install class-transformer   # 선택사항, 고급 역직렬화용
```
:::

## 2단계: TypeScript 설정

`tsconfig.json`에 데코레이터 옵션을 켜요.

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

각 옵션이 하는 일:

- `experimentalDecorators` -- `@Entity()`, `@Column()` 문법을 활성화해요. 이 옵션 없이는 TypeScript가 `@`를 문법 오류로 처리해요.
- `emitDecoratorMetadata` -- 컴파일러에게 `reflect-metadata`가 런타임에 읽을 수 있는 타입 정보를 출력하라고 지시해요. ORM이 `name: string`을 `VARCHAR` 컬럼으로 매핑할 수 있는 게 이 옵션 덕분이에요.
- `strictPropertyInitialization` -- 보통 TypeScript는 클래스 프로퍼티가 생성자에서 할당되지 않으면 경고해요. 엔티티 프로퍼티는 생성자가 아니라 ORM이 채워주기 때문에, 모든 프로퍼티에 `!:`를 붙이지 않으려면 이 체크를 꺼야 해요.

## 3단계: 엔티티 정의

**엔티티**(Entity)는 데이터베이스 테이블에 대응하는 TypeScript 클래스예요. 클래스의 인스턴스 하나가 테이블의 행 하나를 나타내요. 간단한 User 엔티티를 만들어 볼게요.

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

각 데코레이터가 하는 일:

- `@Entity()` -- ORM에게 "이 클래스는 DB 테이블이야"라고 알려줘요. 테이블명은 기본적으로 소문자 클래스명(`user`)이에요.
- `@PrimaryGeneratedColumn()` -- 이 컬럼이 PK이고, 값은 DB가 자동 생성해요 (MySQL: auto-increment, PostgreSQL: `SERIAL`).
- `@Column()` -- 일반 컬럼. ORM이 TypeScript 타입에서 SQL 타입을 자동 추론해요: `string` → `VARCHAR(255)`, `number` → `INTEGER`, `boolean` → `BOOLEAN`.

`synchronize: true` 시 ORM이 생성하는 DDL:

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

PostgreSQL은 `"큰따옴표"`, MySQL은 `` `백틱` ``으로 식별자를 래핑해요. ORM이 `type`에 따라 자동 처리해요.

> **참고** [엔티티](./entities.md) 문서에서 더 자세한 내용을 볼 수 있어요.

## 4단계: 데이터베이스 연결

`EntityManager`로 DB에 연결해요. `reflect-metadata`는 반드시 **최상단**에서 import해야 해요.

```typescript
// main.ts
import "reflect-metadata";  // 반드시 첫 번째 import이어야 해요
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

`synchronize: true`로 설정하면, ORM이 엔티티 정의와 실제 DB를 비교해서 테이블을 맞춰줘요. `user` 테이블이 아직 없으면 위의 `CREATE TABLE` DDL을 실행하고, 테이블은 있지만 새로 추가한 컬럼이 빠져 있으면 `ALTER TABLE`로 추가해요.

> **경고** `synchronize: true`는 개발 전용이에요. 프로덕션에서는 엔티티에서 사라진 컬럼이나 테이블을 DROP할 수 있어요. [마이그레이션](./migrations.md)을 사용하면 어떤 변경이 프로덕션 DB에 적용되는지 직접 제어할 수 있어요.

## 5단계: CRUD 실습

DB 연결이 됐으니 `main()` 안에서 CRUD를 해볼게요.

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

`em.save()`는 `id`가 없는 것을 보고 INSERT를 실행해요. 실제 생성되는 SQL:

```sql
-- PostgreSQL
INSERT INTO "user" ("name", "email") VALUES ($1, $2) RETURNING *
-- 파라미터: ["John Doe", "john@example.com"]

-- MySQL
INSERT INTO `user` (`name`, `email`) VALUES (?, ?)
-- 파라미터: ["John Doe", "john@example.com"]
-- 이후: SELECT * FROM `user` WHERE `id` = LAST_INSERT_ID()
```

사용자가 제공한 값은 SQL 문자열에 직접 들어가지 않아요. `$1`, `$2` (PostgreSQL) / `?` (MySQL)로 표시되는데, 이게 **파라미터 바인딩**이고 SQL injection을 방지해요. PostgreSQL은 `RETURNING *`를 지원해서 INSERT 결과를 한 번의 왕복으로 받을 수 있고, MySQL은 자동 생성된 `id`를 가져오려면 두 번째 쿼리가 필요해요.

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
-- find() — 전체 조회
SELECT "id", "name", "email" FROM "user"

-- findOne() — 조건으로 하나 찾기
SELECT "id", "name", "email" FROM "user" WHERE "id" = $1 LIMIT 1
-- 파라미터: [1]
```

`find()`는 배열을 반환해요 (매칭되는 행이 없으면 빈 배열). `findOne()`은 타입이 지정된 단일 객체 또는 `null`을 반환해요. 한 행만 필요하니까 ORM이 자동으로 `LIMIT 1`을 추가해요.

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

`save()`에 PK(`id: 1`)가 포함된 객체를 전달하면, INSERT 대신 UPDATE를 실행해요:

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

여기까지가 첫 CRUD예요. 모든 작업이 메서드 하나로 끝나고, SQL 생성, 파라미터 바인딩, 결과 역직렬화는 ORM이 뒤에서 처리해요.

## 다른 데이터베이스 사용

`type`만 바꾸면 다른 DB를 쓸 수 있어요. 나머지 코드는 동일해요.

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

## NestJS 통합

Stingerloom ORM은 `@stingerloom/orm/nestjs` subpath export를 통해 NestJS 통합 모듈을 제공해요.

### 왜 별도의 모듈이 필요할까?

NestJS는 **의존성 주입**(DI)을 사용해요 — `new`로 직접 객체를 만드는 대신, 필요한 것을 선언하면 NestJS가 알아서 제공해요. ORM 모듈은 이 두 세계를 연결하는 다리예요: `EntityManager`와 리포지토리를 생성한 뒤, NestJS의 DI 컨테이너에 등록해서 서비스의 생성자 파라미터로 주입받을 수 있게 해요.

흐름은 이렇게 동작해요:

1. `forRoot()` — `EntityManager`를 생성하고, DB에 연결하고, 글로벌 NestJS 프로바이더로 등록해요.
2. `forFeature([User])` — `BaseRepository<User>`를 생성하고, `User` 클래스에서 유도된 고유 토큰으로 등록해요.
3. `@InjectRepository(User)` — 서비스에서 NestJS에게 "User에 대해 등록된 리포지토리를 줘"라고 알려줘요.
4. NestJS가 의존성을 해석해서 서비스의 생성자에 리포지토리를 전달해요.

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

`@nestjs/common`과 `@nestjs/core`는 선택적 peer dependency예요 -- 모든 NestJS 프로젝트에 이미 있어요.

### 루트 모듈 등록

`StinglerloomOrmModule.forRoot()`로 데이터베이스 연결을 초기화하고, `StinglerloomOrmModule.forFeature()`로 엔티티 리포지토리를 등록해요.

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

`@stingerloom/orm/nestjs`에서 `InjectRepository`를 import해서 타입이 지정된 리포지토리를 주입해요.

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

`forRoot()`와 `forFeature()`에 `connectionName`을 전달하면 여러 데이터베이스를 동시에 쓸 수 있어요.

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

기능 모듈에서 connectionName을 지정해요:

```typescript
// analytics/analytics.module.ts
@Module({
  imports: [StinglerloomOrmModule.forFeature([Event], "analytics")],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
```

서비스에서 `@InjectRepository`와 `@InjectEntityManager`에 connectionName을 전달해요:

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

> connectionName을 생략하면 기본값 `"default"`가 사용되므로, 기존 단일 DB 코드는 변경 없이 계속 동작해요.

> **힌트** 완전한 NestJS 예제는 `examples/nestjs-cats/`, `examples/nestjs-blog/`, `examples/nestjs-multitenant/` 디렉토리에 있어요.

## 다음 단계

기본 설정과 CRUD를 배웠어요. 이제 더 풍부한 엔티티를 정의해 보세요.

- [엔티티](./entities.md) -- 컬럼 타입, 인덱스, 소프트 삭제, 생명주기 훅
- [관계](./relations.md) -- `@ManyToOne`, `@OneToMany`로 테이블 간 관계 정의
- [엔티티 매니저](./entity-manager.md) -- 검색 옵션, 집계, 페이지네이션
- [NestJS 통합](./nestjs.md) -- forRoot/forFeature, @InjectRepository, 멀티 DB
- [설정](./configuration.md) -- 풀링, 타임아웃, Read Replica 및 기타 운영 설정
