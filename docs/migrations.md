# 마이그레이션 시스템 (Migrations)

마이그레이션 시스템을 통해 데이터베이스 스키마 변경 이력을 코드로 관리합니다. `__migrations` 테이블을 자동 생성하여 실행 이력을 추적합니다.

---

## Migration 추상 클래스

모든 마이그레이션은 `Migration` 클래스를 상속하고 `up()` / `down()` 메서드를 구현합니다.

```typescript
import { Migration, MigrationContext } from "stingerloom-orm";

export abstract class Migration {
  get name(): string; // 기본값: 클래스명

  abstract up(context: MigrationContext): Promise<void>;
  abstract down(context: MigrationContext): Promise<void>;
}

interface MigrationContext {
  driver: ISqlDriver;          // DB 드라이버 (DDL 헬퍼 접근 가능)
  query: (sql: string) => Promise<any>; // 임의 SQL 실행
}
```

---

## 마이그레이션 파일 작성

### 테이블 생성

```typescript
// migrations/001_CreateUsersTable.ts
import { Migration, MigrationContext } from "stingerloom-orm";

export class CreateUsersTable extends Migration {
  async up(context: MigrationContext): Promise<void> {
    await context.query(`
      CREATE TABLE IF NOT EXISTS \`users\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`name\` VARCHAR(100) NOT NULL,
        \`email\` VARCHAR(255) NOT NULL UNIQUE,
        \`is_active\` TINYINT(1) NOT NULL DEFAULT 1,
        \`created_at\` DATETIME DEFAULT CURRENT_TIMESTAMP,
        \`deleted_at\` DATETIME NULL
      )
    `);
  }

  async down(context: MigrationContext): Promise<void> {
    await context.query(`DROP TABLE IF EXISTS \`users\``);
  }
}
```

### 컬럼 추가

```typescript
// migrations/002_AddPhoneToUsers.ts
import { Migration, MigrationContext } from "stingerloom-orm";

export class AddPhoneToUsers extends Migration {
  async up(context: MigrationContext): Promise<void> {
    await context.query(
      `ALTER TABLE \`users\` ADD COLUMN \`phone\` VARCHAR(20) NULL`
    );
  }

  async down(context: MigrationContext): Promise<void> {
    await context.query(
      `ALTER TABLE \`users\` DROP COLUMN \`phone\``
    );
  }
}
```

### 인덱스 추가

```typescript
// migrations/003_AddEmailIndex.ts
import { Migration, MigrationContext } from "stingerloom-orm";

export class AddEmailIndex extends Migration {
  async up(context: MigrationContext): Promise<void> {
    await context.query(
      `CREATE INDEX \`idx_users_email\` ON \`users\` (\`email\`)`
    );
  }

  async down(context: MigrationContext): Promise<void> {
    await context.query(
      `DROP INDEX \`idx_users_email\` ON \`users\``
    );
  }
}
```

### 데이터 마이그레이션

```typescript
// migrations/004_SeedInitialData.ts
import { Migration, MigrationContext } from "stingerloom-orm";

export class SeedInitialData extends Migration {
  async up(context: MigrationContext): Promise<void> {
    await context.query(`
      INSERT INTO \`roles\` (\`name\`, \`description\`) VALUES
      ('admin', '관리자'),
      ('user', '일반 사용자'),
      ('guest', '게스트')
    `);
  }

  async down(context: MigrationContext): Promise<void> {
    await context.query(
      `DELETE FROM \`roles\` WHERE \`name\` IN ('admin', 'user', 'guest')`
    );
  }
}
```

### PostgreSQL 마이그레이션

```typescript
// migrations/001_CreatePostsTable.ts
import { Migration, MigrationContext } from "stingerloom-orm";

export class CreatePostsTable extends Migration {
  async up(context: MigrationContext): Promise<void> {
    await context.query(`
      CREATE TABLE IF NOT EXISTS "posts" (
        "id" SERIAL PRIMARY KEY,
        "title" VARCHAR(255) NOT NULL,
        "content" TEXT,
        "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
        "author_id" INTEGER REFERENCES "users"("id"),
        "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        "deleted_at" TIMESTAMP NULL
      )
    `);
  }

  async down(context: MigrationContext): Promise<void> {
    await context.query(`DROP TABLE IF EXISTS "posts"`);
  }
}
```

---

## MigrationRunner 직접 사용

`MigrationRunner`를 직접 인스턴스화하여 프로그래밍 방식으로 마이그레이션을 실행합니다.

```typescript
import {
  EntityManager,
  MigrationRunner,
  MySqlDriver,
} from "stingerloom-orm";
import { CreateUsersTable } from "./migrations/001_CreateUsersTable";
import { AddPhoneToUsers } from "./migrations/002_AddPhoneToUsers";

async function runMigrations() {
  const em = new EntityManager();
  await em.register({
    type: "mysql",
    host: "localhost",
    port: 3306,
    username: "root",
    password: "password",
    database: "mydb",
    entities: [],
    synchronize: false, // 마이그레이션 사용 시 synchronize는 false 권장
  });

  // 마이그레이션 목록 (실행 순서대로 정렬)
  const migrations = [
    new CreateUsersTable(),
    new AddPhoneToUsers(),
  ];

  // MigrationRunner를 생성하려면 driver와 queryRunner가 필요합니다.
  // EntityManager 내부의 driver와 connection을 활용합니다.
  // (실제 사용 시에는 MigrationCli를 권장합니다)
}
```

---

## MigrationCli 사용법

`MigrationCli`는 DB 연결 + `MigrationRunner` 실행을 한 번에 처리합니다.

```typescript
import { MigrationCli } from "stingerloom-orm";
import { CreateUsersTable } from "./migrations/001_CreateUsersTable";
import { AddPhoneToUsers } from "./migrations/002_AddPhoneToUsers";
import { AddEmailIndex } from "./migrations/003_AddEmailIndex";

const migrations = [
  new CreateUsersTable(),
  new AddPhoneToUsers(),
  new AddEmailIndex(),
];

const cli = new MigrationCli(migrations, {
  type: "mysql",
  host: "localhost",
  port: 3306,
  username: "root",
  password: "password",
  database: "mydb",
  entities: [],
});

async function main() {
  await cli.connect();

  // 명령어 가져오기
  const command = process.argv[2]; // "migrate:run" | "migrate:rollback" | "migrate:status"

  try {
    const result = await cli.execute(command as any);
    console.log(result);
  } finally {
    await cli.close();
  }
}

main().catch(console.error);
```

**package.json에 스크립트 등록**

```json
{
  "scripts": {
    "migrate:run": "ts-node ./src/migrate.ts migrate:run",
    "migrate:rollback": "ts-node ./src/migrate.ts migrate:rollback",
    "migrate:status": "ts-node ./src/migrate.ts migrate:status"
  }
}
```

**CLI 명령어 실행**

```bash
# 미실행 마이그레이션 모두 실행
pnpm migrate:run

# 마지막 마이그레이션 되돌리기
pnpm migrate:rollback

# 실행됨/미실행 목록 확인
pnpm migrate:status
```

---

## MigrationRunner API

| 메서드 | 설명 |
|--------|------|
| `run(migrations?)` | 미실행 마이그레이션을 순서대로 실행 |
| `rollback(n?)` | 최근 n개 마이그레이션 되돌리기 (기본값: 1) |
| `status()` | `{ executed: string[], pending: string[] }` 반환 |
| `runAll()` | 미실행 마이그레이션 전체 실행 |
| `runUp(migration)` | 단일 마이그레이션 적용 |
| `runDown(migration)` | 단일 마이그레이션 되돌리기 |
| `revertLast()` | 마지막 마이그레이션 되돌리기 |
| `getPendingMigrations()` | 미실행 마이그레이션 목록 반환 |
| `getExecutedMigrations()` | 실행된 마이그레이션 이름 목록 반환 |
| `ensureMigrationTable()` | `__migrations` 테이블 자동 생성 |

---

## __migrations 테이블

마이그레이션 실행 이력을 추적하는 테이블이 자동으로 생성됩니다.

```sql
-- MySQL
CREATE TABLE IF NOT EXISTS `__migrations` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(255) NOT NULL UNIQUE,
  `executed_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- PostgreSQL / SQLite
CREATE TABLE IF NOT EXISTS "__migrations" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL UNIQUE,
  "executed_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## 마이그레이션 결과 타입

```typescript
interface MigrationResult {
  name: string;           // 마이그레이션 클래스명
  direction: "up" | "down";
  success: boolean;
  error?: string;         // 실패 시 에러 메시지
}
```

```typescript
const results = await cli.migrateRun();
for (const result of results) {
  if (result.success) {
    console.log(`[OK] ${result.name}`);
  } else {
    console.error(`[FAIL] ${result.name}: ${result.error}`);
  }
}
```

---

## 권장 마이그레이션 파일 명명 규칙

마이그레이션은 등록한 배열의 순서대로 실행됩니다. 파일명에 순번을 포함하여 순서를 명확히 표현하는 것을 권장합니다.

```
migrations/
├── 001_CreateUsersTable.ts
├── 002_CreatePostsTable.ts
├── 003_AddPhoneToUsers.ts
├── 004_AddEmailIndex.ts
└── 005_SeedRoles.ts
```
