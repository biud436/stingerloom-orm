# 시작하기 (Getting Started)

## 1. 설치

```bash
pnpm add stingerloom-orm reflect-metadata
```

---

## 2. TypeScript 설정

`tsconfig.json`에 다음 두 옵션이 반드시 활성화되어 있어야 합니다.

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "strictPropertyInitialization": false
  }
}
```

앱 진입점 최상단에서 `reflect-metadata`를 임포트합니다.

```typescript
import "reflect-metadata";
```

---

## 3. 최소 동작 예제

### 엔티티 정의

```typescript
// user.entity.ts
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
} from "stingerloom-orm";

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

### EntityManager 연결 및 CRUD

```typescript
import "reflect-metadata";
import { EntityManager } from "stingerloom-orm";
import { User } from "./user.entity";

async function main() {
  const em = new EntityManager();

  // DB 연결 + 엔티티 등록 (테이블이 없으면 자동 생성)
  await em.register({
    type: "mysql",
    host: "localhost",
    port: 3306,
    username: "root",
    password: "password",
    database: "mydb",
    entities: [User],
    synchronize: true,
  });

  // INSERT
  const user = await em.save(User, { name: "홍길동", email: "hong@example.com" });
  console.log("저장된 유저:", user);

  // SELECT 전체
  const users = await em.find(User);
  console.log("전체 유저:", users);

  // SELECT 단건
  const found = await em.findOne(User, { where: { id: user.id } });
  console.log("단건 조회:", found);

  // UPDATE
  const updated = await em.save(User, { ...user, name: "홍길동(수정)" });
  console.log("수정된 유저:", updated);

  // DELETE
  const result = await em.delete(User, { id: user.id });
  console.log("삭제된 행 수:", result.affected);
}

main().catch(console.error);
```

---

## 4. DB별 연결 설정 예제

### MySQL / MariaDB

```typescript
await em.register({
  type: "mysql",        // 또는 "mariadb"
  host: "localhost",
  port: 3306,
  username: "root",
  password: "password",
  database: "mydb",
  entities: [User],
  synchronize: true,
  charset: "utf8mb4",
  datesStrings: false,
  pool: {
    max: 10,
    min: 2,
    acquireTimeoutMs: 30000,
    idleTimeoutMs: 10000,
  },
  logging: {
    queries: true,
    slowQueryMs: 500,
    nPlusOne: true,
  },
});
```

### PostgreSQL

```typescript
await em.register({
  type: "postgres",
  host: "localhost",
  port: 5432,
  username: "postgres",
  password: "password",
  database: "mydb",
  schema: "public",    // 기본값: "public"
  entities: [User],
  synchronize: true,
  pool: {
    max: 10,
    min: 1,
    acquireTimeoutMs: 30000,
    idleTimeoutMs: 10000,
  },
});
```

### SQLite

```typescript
await em.register({
  type: "sqlite",
  host: "",
  port: 0,
  username: "",
  password: "",
  database: "./mydb.sqlite",  // 파일 경로
  entities: [User],
  synchronize: true,
});
```

### MSSQL

```typescript
await em.register({
  type: "mssql",
  host: "localhost",
  port: 1433,
  username: "sa",
  password: "password",
  database: "mydb",
  entities: [User],
  synchronize: true,
});
```

---

## 5. 연결 재시도 설정

```typescript
await em.register({
  type: "mysql",
  // ...
  retry: {
    maxAttempts: 5,
    backoffMs: 1000,   // 실제 지연 = backoffMs * 2^(시도횟수-1) (지수 백오프)
  },
});
```

---

## 6. NestJS 통합

NestJS에서 사용하려면 `StinglerloomOrmModule`을 루트 모듈에 등록합니다.

```typescript
// app.module.ts
import { Module } from "@nestjs/common";
import { StinglerloomOrmModule } from "./stingerloom-orm/stingerloom-orm.module";
import { User } from "./user.entity";

@Module({
  imports: [
    StinglerloomOrmModule.forRoot({
      type: "mysql",
      host: "localhost",
      port: 3306,
      username: "root",
      password: "password",
      database: "mydb",
      entities: [User],
      synchronize: true,
    }),
  ],
})
export class AppModule {}
```

서비스에서 `BaseRepository`를 주입하여 사용합니다.

```typescript
// users.service.ts
import { Injectable } from "@nestjs/common";
import { BaseRepository } from "stingerloom-orm";
import { InjectRepository } from "./stingerloom-orm/inject-repository.decorator";
import { User } from "./user.entity";

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly userRepo: BaseRepository<User>,
  ) {}

  async findAll(): Promise<User[]> {
    const result = await this.userRepo.find();
    if (!result) return [];
    return Array.isArray(result) ? result : [result];
  }
}
```
