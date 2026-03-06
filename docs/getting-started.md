# 시작하기 (Getting Started)

이 가이드에서는 Stingerloom ORM을 설치하고, 첫 번째 엔티티를 정의한 뒤, 데이터를 생성/조회/수정/삭제하는 과정을 단계별로 진행합니다. 5분이면 완료할 수 있습니다.

## 전제 조건

- Node.js 18 이상
- TypeScript 프로젝트
- MySQL, PostgreSQL, 또는 SQLite 데이터베이스

## 1단계: 설치

```bash
pnpm add stingerloom-orm reflect-metadata
```

> **Hint** npm이나 yarn을 사용한다면 `npm install` 또는 `yarn add`로 대체하세요.

## 2단계: TypeScript 설정

`tsconfig.json`에 데코레이터 관련 옵션을 활성화합니다.

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

`experimentalDecorators`와 `emitDecoratorMetadata`는 `@Entity()`, `@Column()` 같은 데코레이터가 동작하는 데 필수입니다. `strictPropertyInitialization`을 끄면 엔티티 프로퍼티에 `!:` 없이도 초기화 오류가 발생하지 않습니다.

## 3단계: 엔티티 정의

**엔티티(Entity)**는 데이터베이스 테이블을 TypeScript 클래스로 표현한 것입니다. 간단한 사용자 엔티티를 만들어보겠습니다.

```typescript
// user.entity.ts
import { Entity, PrimaryGeneratedColumn, Column } from "stingerloom-orm";

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

`@Entity()`는 이 클래스가 DB 테이블에 대응된다는 선언이고, `@PrimaryGeneratedColumn()`은 자동 증가 기본키, `@Column()`은 일반 컬럼입니다. 이 코드만으로 `user` 테이블이 만들어집니다.

> **Hint** 엔티티에 대해 더 자세히 알고 싶다면 [엔티티 정의](./entities.md) 문서를 참고하세요.

## 4단계: 데이터베이스 연결

이제 `EntityManager`로 DB에 연결하고 엔티티를 등록합니다. 앱 진입점 최상단에서 `reflect-metadata`를 반드시 임포트하세요.

```typescript
// main.ts
import "reflect-metadata";
import { EntityManager } from "stingerloom-orm";
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

`synchronize: true`로 설정하면 엔티티 정의를 기반으로 테이블이 자동 생성됩니다. 아직 `user` 테이블이 없어도 걱정할 필요 없습니다.

> **Warning** `synchronize: true`는 개발 환경에서만 사용하세요. 프로덕션에서는 [마이그레이션](./migrations.md)으로 스키마를 관리해야 합니다.

## 5단계: CRUD 해보기

DB 연결이 되었으니 데이터를 생성, 조회, 수정, 삭제해보겠습니다. `main()` 함수 안에 이어서 작성합니다.

### 생성 (Create)

```typescript
// main.ts (main 함수 안)
const user = await em.save(User, {
  name: "홍길동",
  email: "hong@example.com",
});
console.log("저장된 유저:", user);
// { id: 1, name: "홍길동", email: "hong@example.com" }
```

`em.save()`는 PK가 없으면 INSERT, 있으면 UPDATE를 수행합니다. 자동 생성된 `id`가 포함된 객체가 반환됩니다.

### 조회 (Read)

```typescript
// main.ts
// 전체 조회
const users = await em.find(User);
console.log("전체 유저:", users);

// 조건부 단건 조회
const found = await em.findOne(User, { where: { id: 1 } });
console.log("단건 조회:", found); // User | null
```

`find()`는 배열을, `findOne()`은 단일 객체 또는 `null`을 반환합니다.

### 수정 (Update)

```typescript
// main.ts
const updated = await em.save(User, {
  id: 1,               // PK가 있으므로 UPDATE
  name: "홍길동(수정)",
  email: "hong@example.com",
});
console.log("수정된 유저:", updated);
```

`save()`에 PK(`id`)를 포함하면 해당 행이 업데이트됩니다.

### 삭제 (Delete)

```typescript
// main.ts
const result = await em.delete(User, { id: 1 });
console.log("삭제된 행 수:", result.affected); // 1
```

축하합니다! 첫 번째 CRUD를 완성했습니다.

## 다른 데이터베이스 사용하기

위 예제는 PostgreSQL을 사용했지만, `type` 옵션만 바꾸면 다른 DB도 동일하게 사용할 수 있습니다.

| DB | `type` | `port` | 비고 |
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
// SQLite 예제 — host, port, username, password는 빈 값
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

## NestJS에서 사용하기

NestJS 프로젝트에서는 `StinglerloomOrmModule`로 루트 모듈에 등록하고, 서비스에서 `@InjectRepository()`로 리포지토리를 주입받습니다.

### 모듈 등록

```typescript
// app.module.ts
import { Module } from "@nestjs/common";
import { StinglerloomOrmModule } from "./stingerloom-orm/stingerloom-orm.module";
import { User } from "./user.entity";

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
  ],
})
export class AppModule {}
```

### 서비스에서 사용

```typescript
// users.service.ts
import { Injectable } from "@nestjs/common";
import { BaseRepository, InjectRepository } from "stingerloom-orm";
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

> **Hint** `examples/nestjs-cats/`, `examples/nestjs-blog/`, `examples/nestjs-multitenant/` 폴더에 완전한 NestJS 예제가 포함되어 있습니다.

## 다음 단계

기본적인 설정과 CRUD를 배웠습니다. 이제 엔티티를 더 풍부하게 정의해보세요.

- [엔티티 정의](./entities.md) — 컬럼 타입, 인덱스, Soft Delete, 생명주기 훅
- [관계 설정](./relations.md) — `@ManyToOne`, `@OneToMany`로 테이블 간 관계 정의
- [EntityManager](./entity-manager.md) — find 옵션, 집계, 페이지네이션 활용법
- [설정 가이드](./configuration.md) — 풀링, 타임아웃, Read Replica 등 운영 설정
