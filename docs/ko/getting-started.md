# 시작하기

설치부터 첫 CRUD까지, 5분이면 돼요.

## ORM이란?

TypeScript 코드에서는 **객체**(클래스), DB에서는 **테이블**(행/열)로 데이터가 존재해요. ORM은 이 둘 사이를 자동 변환해 줘요.

```typescript
// ORM 없이 — raw SQL, 타입 없음
const result = await pool.query('SELECT * FROM "user" WHERE "id" = $1', [1]);
const user = result.rows[0]; // any

// ORM — 타입 안전
const user = await em.findOne(User, { where: { id: 1 } });
// User | null
```

클래스 정의 → `CREATE TABLE`, `save()` → `INSERT`, `find()` → `SELECT`. 각 단계에서 실제 생성되는 SQL도 함께 보여줄게요.

## 사전 요구사항

- Node.js 20+
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

### reflect-metadata

데코레이터가 런타임에 타입 정보(`string` → `VARCHAR`, `number` → `INTEGER`)를 읽으려면 이 폴리필이 필요해요. 앱 진입점 최상단에서 한 번만 import하면 돼요.

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
```

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

- `experimentalDecorators` -- `@Entity()`, `@Column()` 문법 활성화
- `emitDecoratorMetadata` -- 런타임 타입 정보 출력 (`string` → `VARCHAR` 매핑에 필요)
- `strictPropertyInitialization` -- 엔티티 프로퍼티는 ORM이 채우므로 생성자 할당 체크 비활성화

## 3단계: 엔티티 정의

엔티티는 DB 테이블에 대응하는 TypeScript 클래스예요. 인스턴스 하나가 행 하나에요.

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

- `@Entity()` -- 이 클래스가 DB 테이블임을 선언. 테이블명은 소문자 클래스명(`user`)
- `@PrimaryGeneratedColumn()` -- 자동 생성 PK (MySQL: auto-increment, PostgreSQL: `SERIAL`)
- `@Column()` -- 일반 컬럼. TS 타입에서 SQL 타입 자동 추론 (`string` → `VARCHAR(255)`, `number` → `INTEGER`)

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

`synchronize: true`면 엔티티와 DB를 비교해서 `CREATE TABLE` / `ALTER TABLE`을 자동 실행해요.

> **경고** `synchronize: true`는 개발 전용이에요. 프로덕션에서는 [마이그레이션](./migrations.md)을 사용하세요.

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

`id`가 없으므로 INSERT를 실행해요. 실제 SQL:

```sql
-- PostgreSQL
INSERT INTO "user" ("name", "email") VALUES ($1, $2) RETURNING *
-- 파라미터: ["John Doe", "john@example.com"]

-- MySQL
INSERT INTO `user` (`name`, `email`) VALUES (?, ?)
-- 파라미터: ["John Doe", "john@example.com"]
-- 이후: SELECT * FROM `user` WHERE `id` = LAST_INSERT_ID()
```

값은 `$1`, `$2` (PostgreSQL) / `?` (MySQL)로 파라미터 바인딩되어 SQL injection을 방지해요. PostgreSQL은 `RETURNING *`로 한 번에 결과를 받고, MySQL은 두 번째 SELECT가 필요해요.

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
SELECT "id", "name", "email" FROM "user"
SELECT "id", "name", "email" FROM "user" WHERE "id" = $1 LIMIT 1
```

`find()` → 배열, `findOne()` → 단일 객체 또는 `null`. `LIMIT 1`은 자동 추가돼요.

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

PK가 있으면 UPDATE를 실행해요:

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
```

여기까지가 기본 CRUD예요. 모든 작업이 메서드 하나로 끝나고, SQL 생성과 파라미터 바인딩은 ORM이 처리해요.

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

`@stingerloom/orm/nestjs`로 NestJS DI와 통합돼요.

`forRoot()` → DB 연결 + EntityManager 글로벌 등록, `forFeature([User])` → Repository 등록, `@InjectRepository(User)` → 서비스에 주입이에요.

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
